#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AuditLog, auditFiles, verifyAuditFile, type AuditEntry } from "./audit.js";
import { discoverConfigs } from "./clients.js";
import { RUN_OPTIONS, unwrapConfig, withoutEnvValues, wrapConfig, type ServerEntry, type WrapOutcome } from "./config.js";
import { listTools } from "./inspect.js";
import { commandOnPath } from "./installed.js";
import { parseLaunch, serverIdFor } from "./launch.js";
import { MAX_DEPTH, tooDeep } from "./manifest.js";
import { cageHome, checkServerId, serverDir } from "./paths.js";
import { approvePending, listServers, loadPending, loadPin, pendingDefinitions, readJson, refuseTooMany, type Pending } from "./pinstore.js";
import { envFileNote, fixConfigs, inspectionSandbox, isUncaged, renderReport, scanConfigs, uncheckedFiles, writableMounts, writableWarning, type Inspector } from "./protect.js";
import { runProxy } from "./proxy.js";
import { dockerAvailable, INSTALL_BASE, parseMount, prepareSandbox, RUNTIME_BASE, sensitiveMount, withSettingsReadOnly, type ServerRecord } from "./sandbox.js";
import { countSuspicious, describeViolationsWithFindings, highSeveritySigns } from "./suspicious.js";
import { boundedLog, terminalSafe } from "./terminal.js";

// Read from the package's own package.json, one level above dist/, so a release never reports a stale number.
const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const HELP = `mcpcage ${VERSION}: run any MCP server in a cage.

Usage:
  mcpcage run [options] -- npx -y <package> [args...]   start a stdio server through the cage
  mcpcage run --image <image> [options] -- [args...]     cage an already containerized server
  mcpcage prepare [options] -- npx -y <package> [args]   build and pin the sandbox image without starting it
  mcpcage wrap <config.json> [--dry-run] [--no-build]    route a client's npx servers through mcpcage
  mcpcage unwrap <config.json> [--dry-run]               restore the original commands
  mcpcage protect [--inspect] [--fix] [options]          find every MCP configuration and show what is exposed
  mcpcage diff <server-id>                               show tool changes waiting for approval
  mcpcage approve <server-id> [--yes]                    trust the reviewed tool definitions
  mcpcage list                                           servers, pinned tools, pending changes
  mcpcage audit verify [server-id]                       check that audit logs were not tampered with
  mcpcage audit show <server-id> [--lines N]             print the latest audit entries
  mcpcage doctor                                         check Docker and the local setup

Run options:
  --mount <path>[:rw]   bind a host path at the same path, read-only unless :rw (repeatable)
  --allow-sensitive-mount
                        let --mount reach the whole disk, your home directory or a directory with credentials
  --env <NAME[=value]>  pass one environment variable into the container (repeatable)
  --allow-net           give the server network access (default: none)
  --allow-server-requests
                        let the server ask your client to run the model or to question you (default: refused)
  --strict              refuse servers whose tools were never approved (default: trust on first use)
  --id <id>             server id (default: derived from the package and arguments)
  --memory <size>       memory limit (default 512m)    --cpus <n>  CPU limit (default 1)
  --keep-image-user     with --image: keep the image's own user instead of 65532 (nonroot)
  --rebuild             re-resolve the package or image instead of reusing the pinned one
  --no-sandbox          run on the host: pinning and audit only, no isolation (not recommended)

Protect options:
  --project <dir>       also check this project's .mcp.json, .cursor/, .vscode/ and .devin/ (default: current directory)
  --inspect             start each npx server in the cage and look for hidden instructions in its tools
  --offline             do not ask the npm registry; use what was looked up before
  --fix                 route every npx server through mcpcage, after showing the plan (backups are kept)
  --yes                 with --fix: change the files without asking
  --no-build            with --fix: do not build the sandbox images now
  --command <path>      the mcpcage command written into configurations (default: mcpcage's full path)
  --writable            with --fix, and with wrap: mount the paths servers are given writable, not read-only
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
    case "protect":
      return protect(rest);
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
      // A client starts mcpcage with an entry's arguments, which anyone may have written.
      console.error(`mcpcage: unknown command "${terminalSafe(command)}"\n\n${HELP}`);
      return 2;
  }
}

function parseRun(argv: string[]) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const server = separator === -1 ? [] : argv.slice(separator + 1);
  const { values } = parseArgs({ args: own, options: RUN_OPTIONS, strict: true });
  // Docker reads a memory or CPU limit of 0 as no limit at all, which leaves the server the whole machine.
  if (!/^\d+(?:\.\d+)? ?[kmgtp]?i?b?$/i.test(values.memory) || Number.parseFloat(values.memory) <= 0) {
    throw new Error(`--memory ${terminalSafe(values.memory)}: give a positive size, such as 512m or 2g (Docker reads 0 as no limit)`);
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(values.cpus) || Number(values.cpus) <= 0) {
    throw new Error(`--cpus ${terminalSafe(values.cpus)}: give a positive number of CPUs, such as 1 or 0.5 (Docker reads 0 as no limit)`);
  }
  // Checked before anything else, the audit log included: a mount of the whole disk, the home
  // directory or a directory with credentials would undo the cage it belongs to (see sensitive.ts).
  const sensitive = values.mount.flatMap((mount) => sensitiveMount(mount) ?? []);
  if (sensitive[0] !== undefined && !values["allow-sensitive-mount"]) {
    throw new Error(`--mount ${sensitive[0].path}: ${sensitive[0].reason}. Pass --allow-sensitive-mount if you really want this.`);
  }
  // The id names directories of the store, so one given here must stay a plain name (see paths.ts).
  const id = values.id === undefined ? undefined : checkServerId(values.id, "--id");
  const spec = parseLaunch(server, values.image);
  return { values, server, spec, serverId: id ?? serverIdFor(spec), sensitive };
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
  // The name and version come from the installed package's metadata, which the package author wrote.
  console.log(terminalSafe(`${serverId}: ${record.packageName ? `${record.packageName}@${record.version} ` : ""}-> ${record.image}`));
  if (record.integrity) console.log(`  integrity ${record.integrity}`);
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const { values, server, spec, serverId, sensitive } = parseRun(argv);
  // Bounded: the client may never read mcpcage's stderr, and the proxy logs what the server makes it log.
  const log = boundedLog(process.stderr);
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const auditLog = new AuditLog(serverId, sessionId);

  let command: string;
  let args: string[];
  /** docker's own environment for a caged server (see dockerProgram); the host command gets mcpcage's. */
  let env: NodeJS.ProcessEnv | undefined;
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
    // Said before Docker is needed: what the cage leaves open is said even when Docker is missing or the build fails.
    if (values["allow-net"]) log(`mcpcage: WARNING ${serverId} has network access (--allow-net).`);
    // The path is the entry's argument; the server id is a plain name (checkServerId, serverIdFor).
    for (const mount of sensitive) log(terminalSafe(`mcpcage: WARNING --mount ${mount.path} gives ${serverId} ${mount.reason} (--allow-sensitive-mount).`));
    const prepared = prepareSandbox({
      serverId,
      spec,
      // Looked for at every start: git's and the editors' settings inside a writable mount stay read-only.
      mounts: withSettingsReadOnly(values.mount.map(parseMount)),
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
    env = prepared.env;
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
  if (values["allow-server-requests"]) log(`mcpcage: WARNING ${serverId} may ask your client to run the model or to question you (--allow-server-requests).`);

  return runProxy({
    serverId,
    command,
    args,
    env,
    strict: values.strict,
    allowServerRequests: values["allow-server-requests"],
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
      writable: { type: "boolean", default: false },
    },
  });
  if (positionals.length === 0) throw new Error(`usage: mcpcage ${command} <config.json> [--dry-run]`);
  let status = 0;
  for (const file of positionals) {
    const outcome =
      command === "wrap"
        ? wrapConfig(file, { dryRun: values["dry-run"], command: values.command, writable: values.writable })
        : unwrapConfig(file, { dryRun: values["dry-run"] });
    report(outcome, command, values["dry-run"]);
    if (command === "wrap" && !values["dry-run"] && !values["no-build"]) status = Math.max(status, buildImages(outcome.changed));
  }
  return status;
}

/** Builds the images now, so the client's first start does not wait for an image build and time out. */
function buildImages(changes: Array<{ name: string; after: ServerEntry }>): number {
  let status = 0;
  for (const change of changes) {
    const args = change.after.args ?? [];
    const spec = parseLaunch(args.slice(args.indexOf("--") + 1));
    if (spec.kind !== "npm") continue;
    try {
      const prepared = prepareSandbox({
        serverId: serverIdFor(spec), spec, mounts: [], env: [], allowNet: false, memory: "512m", cpus: "1",
        keepImageUser: false, rebuild: false, log: (message) => console.error(message),
      });
      // The name is the configuration's, the package name and version its author's metadata.
      console.log(terminalSafe(`  built ${change.name}: ${prepared.record.packageName}@${prepared.record.version} -> ${prepared.record.image}`));
    } catch (error) {
      status = 1;
      // The message can quote the entry's command line and npm's or docker's output.
      console.error(terminalSafe(`  could not build ${change.name}: ${(error as Error).message}`));
    }
  }
  return status;
}

/**
 * Finds every MCP configuration of this machine and of the project, says what each server is exposed
 * to and, with --fix, routes the npx servers through mcpcage. Without --fix it writes nothing outside
 * mcpcage's own directory.
 */
async function protect(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      inspect: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
      command: { type: "string" },
      writable: { type: "boolean", default: false },
    },
    strict: true,
  });
  const home = homedir();
  const locations = discoverConfigs({ platform: process.platform, home, env: process.env, project: resolve(values.project ?? process.cwd()) });
  // Known before the scan: an entry that starts the command --fix writes is mcpcage, whatever its shim.
  const command = values.command ?? installedCommand();
  const report = await scanConfigs({
    locations, home, offline: values.offline, cacheDir: join(cageHome(), "cache"), inspect: values.inspect ? inspectInCage : undefined, ownCommand: command,
  });
  console.log(renderReport(report, { home }));
  const uncaged = report.servers.filter(isUncaged).length;
  // A configuration that could not be checked may start anything: it counts as an uncaged server does.
  const unchecked = uncheckedFiles(report);
  if (!values.fix) return uncaged > 0 || unchecked > 0 ? 1 : 0;

  const claudeCodeRunning = claudeCodeIsRunning();
  console.log("\nPlan");
  const planned: string[] = [];
  const logPlan = (line: string) => {
    planned.push(line);
    console.log(line);
  };
  const plan = fixConfigs({ report, command, claudeCodeRunning, dryRun: true, home, log: logPlan, writable: values.writable });
  const servers = plan.files.reduce((total, file) => total + file.changed.length, 0);
  const files = plan.files.filter((file) => file.changed.length > 0).length;
  if (servers === 0) {
    console.log("  nothing that mcpcage can change by itself.");
    return uncaged > 0 || unchecked > 0 ? 1 : 0;
  }
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error("refusing to change configuration files without a terminal; review the plan and pass --yes");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(`\nCage ${servers} server${servers === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}? Type "yes": `);
    prompt.close();
    if (answer.trim() !== "yes") {
      console.log("Nothing changed.");
      return 1;
    }
  }
  console.log("");
  // The files are read again now; what the plan already said (files left unchanged and why) is not repeated.
  const logNew = (line: string) => {
    if (!planned.includes(line)) console.log(line);
  };
  const outcome = fixConfigs({ report, command, claudeCodeRunning, dryRun: false, home, log: logNew, writable: values.writable });
  const changed = outcome.files.flatMap((file) => file.changed);
  const status = changed.length < uncaged || unchecked > 0 ? 1 : 0;
  // A failed build is reported and leaves the configuration caged: the image is built at the next start.
  // An entry that was caged already, and only had its env moved, keeps the image it has.
  return values["no-build"] ? status : Math.max(status, buildImages(changed.filter((change) => !change.envOnly)));
}

/** `--inspect`: the server starts in its cage (no network, its paths read-only) only to list its tools. */
const inspectInCage: Inspector = async (launch) => {
  const prepared = prepareSandbox({ ...inspectionSandbox(launch), log: (message) => console.error(message) });
  return listTools(prepared.command, prepared.args, prepared.env, 30_000, launch.redact);
};

/**
 * Desktop apps start servers with a minimal PATH, so configurations get mcpcage's full path when it is
 * found: in the absolute directories of the PATH, as the report looks up an entry's command. On
 * Windows `where` looked in the current directory first, and spawning `where` by name ran a where.exe
 * found there: run in a repository that held a mcpcage.cmd, --fix wrote it into the user's
 * configurations, and the clients started it on the host.
 */
function installedCommand(): string {
  return commandOnPath("mcpcage") ?? "mcpcage";
}

/** Claude Code rewrites ~/.claude.json while it runs, so a change made meanwhile could be lost or lose its state. */
function claudeCodeIsRunning(): boolean {
  if (process.env.CLAUDECODE !== undefined) return true;
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  const listed = spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" });
  return listed.status === 0 && listed.stdout.split("\n").some((line) => basename(line.trim()) === "claude");
}

/**
 * What wrap and unwrap did. Server names, commands and the reasons that quote them come from the
 * configuration file, which anyone may have written: a server named with ESC and CR cleared the
 * screen and printed a success line of its own. Every line goes through terminalSafe.
 */
function report(outcome: WrapOutcome, command: string, dryRun: boolean): void {
  const print = (line: string) => console.log(terminalSafe(line));
  print(`${outcome.file} (${outcome.key})${dryRun ? " [dry run]" : ""}`);
  for (const change of outcome.changed) {
    // The values wrap moved from the env into mcpcage's arguments are not printed, as no env value is.
    const args = change.after.args ?? [];
    print(`  ${command === "wrap" ? "caged" : "restored"} ${change.name}: ${[change.after.command, ...(command === "wrap" ? withoutEnvValues(args) : args)].join(" ")}`);
    // Only --writable makes wrap write :rw: what that lets the server change is said for each mount.
    if (command === "wrap") for (const path of writableMounts(change.after)) print(`    ${writableWarning(change.name, path)}`);
    // VS Code loads an envFile as it is, now for mcpcage: said for each entry that keeps one.
    const note = command === "wrap" ? envFileNote(change.after) : undefined;
    if (note !== undefined) print(`    ${note}`);
  }
  for (const skipped of outcome.skipped) print(`  skipped ${skipped.name}: ${skipped.reason}`);
  if (outcome.backup) print(`  backup: ${outcome.backup}`);
}

function diff(argv: string[]): number {
  const [serverId] = argv;
  if (!serverId) throw new Error("usage: mcpcage diff <server-id>");
  checkServerId(serverId);
  const pending = loadPending(serverId);
  if (!pending) {
    console.log(`${serverId}: no tool changes waiting for approval.`);
    return 0;
  }
  refuseTooDeep(serverId, pending);
  console.log(`${serverId}: tool definitions seen ${pending.seenAt} differ from the approved ones:\n`);
  console.log(describeViolationsWithFindings(pending.violations));
  return 1;
}

async function approve(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: "boolean", default: false } } });
  const [serverId] = positionals;
  if (!serverId) throw new Error("usage: mcpcage approve <server-id> [--yes]");
  checkServerId(serverId);
  const pending = loadPending(serverId);
  if (!pending) {
    console.log(`${serverId}: nothing to approve.`);
    return 0;
  }
  refuseTooDeep(serverId, pending);
  // Before the question, which would be asked for nothing. approvePending says why a pin it loads
  // leaves a definition out; here it is only counted.
  refuseTooMany(serverId, loadPin(serverId, () => {}), pending);
  console.log(describeViolationsWithFindings(pending.violations));
  // Said before the question and before --yes takes effect: this is the last moment to look.
  const { high } = countSuspicious(pending.violations);
  if (high > 0) console.log(`\nWARNING: ${highSeveritySigns(high)}. Approve only if you have read the full definitions.`);
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

/**
 * Showing and approving a definition walk it level by level, so one nested deeper than MAX_DEPTH is
 * refused here too. The proxy no longer saves such a listing, but older versions did under --strict
 * as deep as their stack allowed: a definition 3,000 levels deep was saved, then crashed them.
 */
function refuseTooDeep(serverId: string, pending: Pending): void {
  const deep = tooDeep(pendingDefinitions(pending));
  if (!deep) return;
  throw new Error(
    `the pending definition of "${terminalSafe(deep.name)}" is nested more than ${MAX_DEPTH} levels deep, so it is neither shown nor approved. ` +
      `Delete ${join(serverDir(serverId), "pending.json")} to discard it.`,
  );
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
    // The package name and version come from the installed package's metadata, which its author wrote.
    const what = record?.packageName ? `${record.packageName}@${record.version}` : record?.image ?? "";
    console.log(
      terminalSafe(
        `${serverId}  ${what}  tools: ${pin ? Object.keys(pin.tools).length : 0}` +
          `${pin ? `  approved ${pin.approvedAt}` : "  not approved"}${pending ? "  PENDING CHANGES" : ""}`,
      ),
    );
  }
  return 0;
}

function audit(argv: string[]): number {
  const [action, ...rest] = argv;
  if (action === "verify") {
    const files = auditFiles(rest[0] === undefined ? undefined : checkServerId(rest[0]));
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
    checkServerId(serverId);
    const entries = auditFiles(serverId)
      .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as AuditEntry)
      .sort((left, right) => left.ts.localeCompare(right.ts))
      .slice(-Number(values.lines));
    for (const entry of entries) {
      const { seq: _seq, ts, server: _server, session: _session, event, prev: _prev, hash: _hash, ...data } = entry;
      // Entries hold what the server sent (tool names, methods, ids), and JSON.stringify escapes only
      // U+0000 to U+001F: C1 controls, bidi and other format characters would reach the terminal raw.
      console.log(terminalSafe(`${ts}  ${event.padEnd(14)} ${JSON.stringify(data)}`));
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

// A client that closes the pipe carrying mcpcage's log lines makes every later write to stderr fail
// with EPIPE. Nothing can be done about it, and the proxy already shuts down when its stdout fails.
process.stderr.on("error", () => {});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Many messages quote the arguments, and a client starts mcpcage with an entry's arguments, which
    // anyone may have written: their control characters reached whatever shows mcpcage's stderr.
    process.stderr.write(`mcpcage: ${terminalSafe((error as Error).message)}\n`);
    process.exitCode = 1;
  },
);
