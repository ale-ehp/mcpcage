#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AuditLog, auditFiles, verifyAuditFile, type AuditEntry } from "./audit.js";
import { unwrapConfig, wrapConfig, type WrapOutcome } from "./config.js";
import { parseLaunch, serverIdFor } from "./launch.js";
import { describeViolations } from "./manifest.js";
import { cageHome, serverDir } from "./paths.js";
import { approvePending, listServers, loadPending, loadPin, readJson } from "./pinstore.js";
import { runProxy } from "./proxy.js";
import { dockerAvailable, INSTALL_BASE, parseMount, prepareSandbox, RUNTIME_BASE, type ServerRecord } from "./sandbox.js";

const VERSION = "0.1.0";

const HELP = `mcpcage ${VERSION}: run any MCP server in a cage.

Usage:
  mcpcage run [options] -- npx -y <package> [args...]   start a stdio server through the cage
  mcpcage run --image <image> [options] -- [args...]     cage an already containerized server
  mcpcage prepare [options] -- npx -y <package> [args]   build and pin the sandbox image without starting it
  mcpcage wrap <config.json> [--dry-run] [--no-build]    route a client's npx servers through mcpcage
  mcpcage unwrap <config.json> [--dry-run]               restore the original commands
  mcpcage diff <server-id>                               show tool changes waiting for approval
  mcpcage approve <server-id> [--yes]                    trust the reviewed tool definitions
  mcpcage list                                           servers, pinned tools, pending changes
  mcpcage audit verify [server-id]                       check that audit logs were not tampered with
  mcpcage audit show <server-id> [--lines N]             print the latest audit entries
  mcpcage doctor                                         check Docker and the local setup

Run options:
  --mount <path>[:rw]   bind a host path at the same path, read-only unless :rw (repeatable)
  --env <NAME[=value]>  pass one environment variable into the container (repeatable)
  --allow-net           give the server network access (default: none)
  --strict              refuse servers whose tools were never approved (default: trust on first use)
  --id <id>             server id (default: derived from the package and arguments)
  --memory <size>       memory limit (default 512m)    --cpus <n>  CPU limit (default 1)
  --keep-image-user     with --image: keep the image's own user instead of 65532 (nonroot)
  --rebuild             re-resolve the package or image instead of reusing the pinned one
  --no-sandbox          run on the host: pinning and audit only, no isolation (not recommended)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "run":
      return run(rest);
    case "prepare":
      return prepare(rest);
    case "wrap":
    case "unwrap":
      return wrap(command, rest);
    case "diff":
      return diff(rest);
    case "approve":
      return approve(rest);
    case "list":
      return list();
    case "audit":
      return audit(rest);
    case "doctor":
      return doctor();
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`mcpcage: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

function parseRun(argv: string[]) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const server = separator === -1 ? [] : argv.slice(separator + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      mount: { type: "string", multiple: true, default: [] },
      env: { type: "string", multiple: true, default: [] },
      "allow-net": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      id: { type: "string" },
      image: { type: "string" },
      memory: { type: "string", default: "512m" },
      cpus: { type: "string", default: "1" },
      "keep-image-user": { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      "no-sandbox": { type: "boolean", default: false },
    },
    strict: true,
  });
  const spec = parseLaunch(server, values.image);
  return { values, server, spec, serverId: values.id ?? serverIdFor(spec) };
}

/** Builds and pins the sandbox image without starting the server (wrap does this for every server). */
async function prepare(argv: string[]): Promise<number> {
  const { values, spec, serverId } = parseRun(argv);
  if (spec.kind === "host") throw new Error(`"${spec.command}" is not an npx command; nothing to prepare`);
  const prepared = prepareSandbox({
    serverId, spec, mounts: [], env: [], allowNet: false, memory: values.memory, cpus: values.cpus,
    keepImageUser: values["keep-image-user"], rebuild: values.rebuild, log: (message) => console.error(message),
  });
  const record = prepared.record;
  console.log(`${serverId}: ${record.packageName ? `${record.packageName}@${record.version} ` : ""}-> ${record.image}`);
  if (record.integrity) console.log(`  integrity ${record.integrity}`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const { values, server, spec, serverId } = parseRun(argv);
  const log = (message: string) => process.stderr.write(`${message}\n`);
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const auditLog = new AuditLog(serverId, sessionId);

  let command: string;
  let args: string[];
  if (values["no-sandbox"]) {
    if (spec.kind === "image") throw new Error("--image always runs in a container; drop --no-sandbox");
    command = spec.kind === "host" ? spec.command : server[0]!;
    args = spec.kind === "host" ? spec.args : server.slice(1);
    log(`mcpcage: WARNING ${serverId} runs on the host without isolation (--no-sandbox). Tool pinning and audit are still on.`);
    auditLog.write("sandbox", { mode: "none", command: [command, ...args] });
  } else {
    if (spec.kind === "host") {
      throw new Error(`"${spec.command}" is not an npx command. Use \`mcpcage run -- npx -y <package>\`, \`--image <image>\` for containerized servers, or --no-sandbox.`);
    }
    const prepared = prepareSandbox({
      serverId,
      spec,
      mounts: values.mount.map(parseMount),
      env: values.env,
      allowNet: values["allow-net"],
      memory: values.memory,
      cpus: values.cpus,
      keepImageUser: values["keep-image-user"],
      rebuild: values.rebuild,
      log,
    });
    command = prepared.command;
    args = prepared.args;
    if (values["allow-net"]) log(`mcpcage: WARNING ${serverId} has network access (--allow-net).`);
    auditLog.write("sandbox", {
      mode: "docker",
      image: prepared.record.image,
      imageId: prepared.record.imageId,
      package: prepared.record.packageName,
      version: prepared.record.version,
      integrity: prepared.record.integrity,
      network: values["allow-net"] ? "bridge" : "none",
      mounts: values.mount,
      env: values.env.map((variable) => variable.split("=")[0]),
    });
  }

  return runProxy({
    serverId,
    command,
    args,
    strict: values.strict,
    audit: auditLog,
    input: process.stdin,
    output: process.stdout,
    log,
  });
}

async function wrap(command: "wrap" | "unwrap", argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
      command: { type: "string" },
    },
  });
  if (positionals.length === 0) throw new Error(`usage: mcpcage ${command} <config.json> [--dry-run]`);
  let status = 0;
  for (const file of positionals) {
    const outcome =
      command === "wrap"
        ? wrapConfig(file, { dryRun: values["dry-run"], command: values.command })
        : unwrapConfig(file, { dryRun: values["dry-run"] });
    report(outcome, command, values["dry-run"]);
    if (command === "wrap" && !values["dry-run"] && !values["no-build"]) {
      // Build now, so the client's first start does not wait for an image build and time out.
      for (const change of outcome.changed) {
        const args = change.after.args ?? [];
        const spec = parseLaunch(args.slice(args.indexOf("--") + 1));
        if (spec.kind !== "npm") continue;
        try {
          const prepared = prepareSandbox({
            serverId: serverIdFor(spec), spec, mounts: [], env: [], allowNet: false, memory: "512m", cpus: "1",
            keepImageUser: false, rebuild: false, log: (message) => console.error(message),
          });
          console.log(`  built ${change.name}: ${prepared.record.packageName}@${prepared.record.version} -> ${prepared.record.image}`);
        } catch (error) {
          status = 1;
          console.error(`  could not build ${change.name}: ${(error as Error).message}`);
        }
      }
    }
  }
  return status;
}

function report(outcome: WrapOutcome, command: string, dryRun: boolean): void {
  console.log(`${outcome.file} (${outcome.key})${dryRun ? " [dry run]" : ""}`);
  for (const change of outcome.changed) {
    console.log(`  ${command === "wrap" ? "caged" : "restored"} ${change.name}: ${[change.after.command, ...(change.after.args ?? [])].join(" ")}`);
  }
  for (const skipped of outcome.skipped) console.log(`  skipped ${skipped.name}: ${skipped.reason}`);
  if (outcome.backup) console.log(`  backup: ${outcome.backup}`);
}

function diff(argv: string[]): number {
  const [serverId] = argv;
  if (!serverId) throw new Error("usage: mcpcage diff <server-id>");
  const pending = loadPending(serverId);
  if (!pending) {
    console.log(`${serverId}: no tool changes waiting for approval.`);
    return 0;
  }
  console.log(`${serverId}: tool definitions seen ${pending.seenAt} differ from the approved ones:\n`);
  console.log(describeViolations(pending.violations));
  return 1;
}

async function approve(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: "boolean", default: false } } });
  const [serverId] = positionals;
  if (!serverId) throw new Error("usage: mcpcage approve <server-id> [--yes]");
  const pending = loadPending(serverId);
  if (!pending) {
    console.log(`${serverId}: nothing to approve.`);
    return 0;
  }
  console.log(describeViolations(pending.violations));
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error("refusing to approve without a terminal; review the diff and pass --yes");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(`\nTrust these tool definitions for ${serverId}? Type "approve": `);
    prompt.close();
    if (answer.trim() !== "approve") {
      console.log("Not approved.");
      return 1;
    }
  }
  const pin = approvePending(serverId);
  new AuditLog(serverId, `approve-${Date.now()}`).write("approved", { tools: Object.keys(pin?.tools ?? {}) });
  console.log(`Approved ${Object.keys(pin?.tools ?? {}).length} tools for ${serverId}.`);
  return 0;
}

function list(): number {
  const servers = listServers();
  if (servers.length === 0) {
    console.log(`No servers yet (${cageHome()}).`);
    return 0;
  }
  for (const serverId of servers) {
    const pin = loadPin(serverId);
    const pending = loadPending(serverId);
    const record = readJson<ServerRecord>(`${serverDir(serverId)}/server.json`);
    const what = record?.packageName ? `${record.packageName}@${record.version}` : record?.image ?? "";
    console.log(
      `${serverId}  ${what}  tools: ${pin ? Object.keys(pin.tools).length : 0}` +
        `${pin ? `  approved ${pin.approvedAt}` : "  not approved"}${pending ? "  PENDING CHANGES" : ""}`,
    );
  }
  return 0;
}

function audit(argv: string[]): number {
  const [action, ...rest] = argv;
  if (action === "verify") {
    const files = auditFiles(rest[0]);
    let broken = 0;
    for (const file of files) {
      const result = verifyAuditFile(file);
      if (!result.ok) {
        broken++;
        console.log(`BROKEN  ${file}: line ${result.line}: ${result.error}`);
      }
    }
    console.log(`${files.length - broken}/${files.length} audit logs intact.`);
    return broken === 0 ? 0 : 1;
  }
  if (action === "show") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { lines: { type: "string", default: "20" } } });
    const [serverId] = positionals;
    if (!serverId) throw new Error("usage: mcpcage audit show <server-id>");
    const entries = auditFiles(serverId)
      .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as AuditEntry)
      .sort((left, right) => left.ts.localeCompare(right.ts))
      .slice(-Number(values.lines));
    for (const entry of entries) {
      const { seq: _seq, ts, server: _server, session: _session, event, prev: _prev, hash: _hash, ...data } = entry;
      console.log(`${ts}  ${event.padEnd(14)} ${JSON.stringify(data)}`);
    }
    return 0;
  }
  throw new Error("usage: mcpcage audit verify [server-id] | mcpcage audit show <server-id>");
}

function doctor(): number {
  const docker = dockerAvailable();
  const checks: Array<[string, boolean, string]> = [
    ["node >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.versions.node],
    ["docker", docker.ok, docker.ok ? `server ${docker.version}` : docker.error ?? ""],
    ["home", true, cageHome()],
  ];
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(12)} ${detail}`);
  console.log(`      install base  ${INSTALL_BASE}\n      runtime base  ${RUNTIME_BASE}`);
  if (existsSync(cageHome())) console.log(`      servers       ${listServers().length}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`mcpcage: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
