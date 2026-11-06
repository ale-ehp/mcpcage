#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AuditLog, auditFiles, verifyAuditFile, type AuditEntry } from "./audit.js";
import { canonicalJson } from "./canonical.js";
import { banner } from "./banner.js";
import { discoverConfigs } from "./clients.js";
import { RUN_OPTIONS, unwrapConfig, uvxEnvironment, withoutEnvValues, wrapConfig, type ServerEntry, type WrapOutcome } from "./config.js";
import { listTools } from "./inspect.js";
import { commandOnPath, installedScript, runningFrom, temporaryMcpcage, type McpcageCommand } from "./installed.js";
import { npxArgv, parseLaunch, serverIdFor, startsUv, type LaunchSpec } from "./launch.js";
import { MAX_DEPTH, tooDeep } from "./manifest.js";
import { cageHome, checkServerId, serverDir } from "./paths.js";
import { approvePending, listServers, loadPending, loadPin, pendingDefinitions, readJson, refuseTooMany, type Pending } from "./pinstore.js";
import { envFileNote, fixConfigs, inspectionSandbox, isUncaged, renderReport, scanConfigs, uncheckedFiles, writableMounts, writableWarning, type Inspector } from "./protect.js";
import { runProxy } from "./proxy.js";
import { checkPypi, type PypiCheck, type PypiLock, type PypiResolver } from "./pypi.js";
import { claudeCodeIsRunning } from "./running.js";
import { dockerAvailable, INSTALL_BASE, npxProgram, parseMount, prepareSandbox, RUNTIME_BASE, sensitiveMount, withSettingsReadOnly, type ServerRecord } from "./sandbox.js";
import { countSuspicious, describeViolationsWithFindings, highSeveritySigns } from "./suspicious.js";
import { boundedLog, terminalSafe } from "./terminal.js";

// Read from the package's own package.json, one level above dist/, so a release never reports a stale number.
const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const HELP = `mcpcage ${VERSION}: run any MCP server in a cage.

Usage:
  mcpcage run [options] -- npx -y <package> [args...]   start a stdio server through the cage
  mcpcage run [options] -- uvx <package> [args...]       start a PyPI server through the cage, from its wheels
  mcpcage run --image <image> [options] -- [args...]     cage an already containerized server
  mcpcage prepare [options] -- npx -y <package> [args]   build and pin the sandbox image without starting it
  mcpcage prepare [options] -- uvx <package> [args]      the same for a PyPI server
  mcpcage wrap <config.json> [--dry-run] [--no-build]    route a client's npx and uvx servers through mcpcage
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
  --inspect             start each npx and uvx server in the cage and look for hidden instructions in its tools
  --offline             do not ask the npm registry; use what was looked up before
  --fix                 route every npx and uvx server through mcpcage, after showing the plan (backups are kept)
  --yes                 with --fix: change the files without asking
  --no-build            with --fix: do not resolve the uvx servers or build the sandbox images now
  --command <path>      the mcpcage command written into configurations (default: mcpcage's full path;
                        on Windows, node.exe with mcpcage's cli.js)
  --writable            with --fix, and with wrap: mount the paths servers are given writable, not read-only
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // For a person at a terminal only (see banner.ts): never on run's stdout, the MCP channel.
  const shown = banner(command, process.stdout, VERSION);
  if (shown !== undefined) process.stdout.write(`${shown}\n\n`);
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
  const spec = launchSpec(server, values.image, values["no-sandbox"]);
  return { values, server, spec, serverId: id ?? serverIdFor(spec), sensitive };
}

/**
 * What the server's command line starts. `--no-sandbox` starts a line of uv's as the host command it
 * always was, as uv itself runs it, under the id it had before mcpcage built uvx servers: read as a
 * PyPI server, it would get another id, under which its approved tools would be trusted again as a
 * new server's, and a flag the cage refuses would stop a line that runs on the host anyway.
 *
 * A uvx line is read with mcpcage's own environment, which is the client's plus the entry's env, as
 * uvx would read it there: the same rules wrap and protect apply to the entry's env (see
 * parseLaunch), so a variable that makes uvx install from another index stops the server here too,
 * and UV_PYTHON is its --python. It is the user's own environment as protect reads it, so its
 * UV_CONFIG_FILE is a settings file to look at for an index (see uv-settings.ts), as protect does,
 * and a refusal is worded as protect words it for the user's own variables ("your environment sets
 * UV_DEFAULT_INDEX: ..."): `run` said "the environment mcpcage runs in" for the same variable.
 */
function launchSpec(server: string[], image: string | undefined, noSandbox: boolean): LaunchSpec {
  const [command] = server;
  if (noSandbox && image === undefined && command !== undefined && startsUv(server)) return { kind: "host", command, args: server.slice(1) };
  // The entry's env and envFile are in mcpcage's environment already: an entry of its own adds nothing.
  return parseLaunch(server, image, process.platform, uvxEnvironment({}, process.env));
}

/** Builds and pins the sandbox image without starting the server (wrap does this for every server). */
async function prepare(argv: string[]): Promise<number> {
  const { values, spec, serverId } = parseRun(argv);
  if (spec.kind === "host") throw new Error(`"${spec.command}" is not an npx or uvx command; nothing to prepare`);
  const prepared = prepareSandbox({
    serverId, spec, mounts: [], env: [], allowNet: false, memory: values.memory, cpus: values.cpus,
    keepImageUser: values["keep-image-user"], rebuild: values.rebuild, log: (message) => console.error(message),
  });
  const record = prepared.record;
  // The name and version come from the installed package's metadata, which the package author wrote.
  console.log(terminalSafe(`${serverId}: ${record.packageName ? `${record.packageName}@${record.version} ` : ""}-> ${record.image}`));
  if (record.integrity) console.log(`  integrity ${record.integrity}`);
  if (record.python) console.log(`  python ${record.python}, wheels for ${record.platform}`);
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
    // The npx command line alone: one that `cmd /c` runs (see cmdNpx) starts without cmd, which
    // would read its arguments as commands.
    const line = (spec.kind === "npm" ? npxArgv(server) : undefined) ?? server;
    ({ command, args } = onHost(line, spec.kind === "npm"));
    log(`mcpcage: WARNING ${serverId} runs on the host without isolation (--no-sandbox). Tool pinning and audit are still on.`);
    auditLog.write("sandbox", { mode: "none", command: [command, ...args] });
  } else {
    if (spec.kind === "host") {
      throw new Error(`"${spec.command}" is not an npx or uvx command. Use \`mcpcage run -- npx -y <package>\`, \`mcpcage run -- uvx <package>\`, \`--image <image>\` for containerized servers, or --no-sandbox.`);
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
      // A PyPI server's: the CPython, the wheels' platform and the uv that installed them.
      python: prepared.record.python,
      platform: prepared.record.platform,
      uvVersion: prepared.record.uvVersion,
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

/**
 * How `run --no-sandbox` starts a server's command line on the host: as written on macOS and Linux;
 * on Windows npx as npm's npx-cli.js run by the node running mcpcage (see npxProgram), and never a
 * batch file. Node starts a .cmd or .bat only through cmd.exe, which would read the server's
 * arguments as commands, and refuses to start one without it since the fix of CVE-2024-27980 (a plain
 * spawn throws EINVAL); a bare name finds only a .com or an .exe. A bare name whose PATH lookup finds
 * a batch file first is refused too, with the file named, instead of failing with ENOENT.
 */
function onHost(line: string[], npx: boolean): { command: string; args: string[] } {
  const [program, ...rest] = line as [string, ...string[]];
  if (process.platform !== "win32") return { command: program, args: rest };
  if (npx) {
    const found = npxProgram();
    if (found === undefined) throw new Error(`npx not found: mcpcage starts npm's npx-cli.js with the node it runs on, and there is none next to ${process.execPath}`);
    return { command: found.file, args: [...found.args, ...rest] };
  }
  // The program the spawn below finds: in this process's PATH, as it is.
  const batch = /\.(?:cmd|bat)$/i.test(program) ? program : /^[^/\\.]+$/.test(program) ? commandOnPath(program, process.env.PATH ?? "") : undefined;
  if (batch !== undefined && /\.(?:cmd|bat)$/i.test(batch)) {
    throw new Error(
      `${batch} is a batch file, which Windows starts only through cmd.exe, a shell that would read the server's arguments as commands: give --no-sandbox the program it starts instead (for a package npm installed, node.exe and its script)`,
    );
  }
  return { command: program, args: rest };
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
  // On macOS and Linux wrap writes mcpcage by its bare name, which the client looks up in its own PATH.
  const written = command === "wrap" ? (values.command ?? (process.platform === "win32" ? installedCommand() : undefined)) : undefined;
  if (written !== undefined) refuseTemporary(written, "wrap");
  let status = 0;
  // uvx servers are resolved before they are written, unless --no-build, and built from those locks.
  const pypi = pypiResolver();
  for (const file of positionals) {
    const outcome =
      command === "wrap"
        ? wrapConfig(file, { dryRun: values["dry-run"], command: written, writable: values.writable, ...(values["no-build"] ? {} : { resolve: pypi.resolve }) })
        : unwrapConfig(file, { dryRun: values["dry-run"] });
    report(outcome, command, values["dry-run"]);
    if (command === "wrap" && values["no-build"] && cagesUvx(outcome.changed)) console.log(`  ${NOT_RESOLVED}`);
    if (command === "wrap" && !values["dry-run"] && !values["no-build"]) status = Math.max(status, buildImages(outcome.changed.map((change) => ({ ...change, file })), pypi.locks));
  }
  return status;
}

/** What --no-build says when it cages uvx servers, whose resolve it skips with the build. */
const NOT_RESOLVED = "--no-build: the packages of the uvx servers were not resolved, so one whose dependencies ship no wheel is caged anyway and will fail when it first starts";

/** Whether any of the changes cages a uvx server: one that now starts a line of uv's after `--`. */
function cagesUvx(changes: Array<{ after: ServerEntry; alreadyCaged?: boolean }>): boolean {
  return changes.some((change) => {
    const args = (change.after.args ?? []).filter((arg): arg is string => typeof arg === "string");
    return !change.alreadyCaged && args.includes("--") && startsUv(args.slice(args.indexOf("--") + 1));
  });
}

/**
 * The resolve of each uvx server wrap and protect --fix are about to write (see checkPypi), run once
 * per server and spec: the plan and the rewrite that follows it ask for the same server, and
 * buildImages then builds from the locks it made (`locks`, by server id).
 */
function pypiResolver(): { resolve: PypiResolver; locks: Map<string, PypiLock> } {
  const answers = new Map<string, PypiCheck>();
  const locks = new Map<string, PypiLock>();
  const resolve: PypiResolver = (serverId, spec) => {
    const key = canonicalJson({ serverId, spec });
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = checkPypi(serverId, spec, { log: (message) => console.error(terminalSafe(message)) });
      answers.set(key, answer);
      if ("locked" in answer) locks.set(serverId, answer.locked);
    }
    return answer;
  };
  return { resolve, locks };
}

/**
 * Builds the images now, so the client's first start does not wait for an image build and time out.
 * A uvx server is built from the lock its resolve made a moment ago (`locks`, see pypiResolver).
 * `file` is the configuration that holds the entry, whose envFile is read with its env.
 */
function buildImages(changes: Array<{ name: string; after: ServerEntry; file: string }>, locks: ReadonlyMap<string, PypiLock> = new Map()): number {
  let status = 0;
  for (const change of changes) {
    const args = change.after.args ?? [];
    // With the env and the envFile the client gives mcpcage, as wrap read them: their UV_PYTHON is the Python `run` builds for.
    const spec = parseLaunch(args.slice(args.indexOf("--") + 1), undefined, process.platform, uvxEnvironment(change.after, process.env, change.file));
    if (spec.kind !== "npm" && spec.kind !== "pypi") continue;
    const serverId = serverIdFor(spec);
    const pypiLock = spec.kind === "pypi" ? locks.get(serverId) : undefined;
    try {
      const prepared = prepareSandbox({
        serverId, spec, mounts: [], env: [], allowNet: false, memory: "512m", cpus: "1",
        keepImageUser: false, rebuild: false, log: (message) => console.error(message), ...(pypiLock === undefined ? {} : { pypiLock }),
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
 * to and, with --fix, routes the npx and uvx servers through mcpcage. Without --fix it writes nothing outside
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
  if (values.fix) refuseTemporary(command, "protect --fix");
  const report = await scanConfigs({
    locations, home, offline: values.offline, cacheDir: join(cageHome(), "cache"), inspect: values.inspect ? inspectInCage : undefined, ownCommand: command,
  });
  console.log(renderReport(report, { home }));
  const uncaged = report.servers.filter(isUncaged).length;
  // A configuration that could not be checked may start anything: it counts as an uncaged server does.
  const unchecked = uncheckedFiles(report);
  if (!values.fix) return uncaged > 0 || unchecked > 0 ? 1 : 0;

  const claudeCodeRunning = claudeCodeIsRunning();
  // uvx servers are resolved while the plan is made, unless --no-build, and built from those locks after yes.
  const pypi = pypiResolver();
  const resolving = values["no-build"] ? {} : { resolve: pypi.resolve };
  console.log("\nPlan");
  const planned: string[] = [];
  const logPlan = (line: string) => {
    planned.push(line);
    console.log(line);
  };
  const plan = fixConfigs({ report, command, claudeCodeRunning, dryRun: true, home, log: logPlan, writable: values.writable, ...resolving });
  if (values["no-build"] && cagesUvx(plan.files.flatMap((file) => file.changed))) logPlan(`  ${NOT_RESOLVED}`);
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
  const outcome = fixConfigs({ report, command, claudeCodeRunning, dryRun: false, home, log: logNew, writable: values.writable, ...resolving });
  const changed = outcome.files.flatMap((fixed) => fixed.changed.map((change) => ({ ...change, file: fixed.file })));
  const status = changed.length < uncaged || unchecked > 0 ? 1 : 0;
  // A failed build is reported and leaves the configuration caged: the image is built at the next start.
  // An entry that was caged already, and only had its env or its launcher changed, keeps the image it has.
  return values["no-build"] ? status : Math.max(status, buildImages(changed.filter((change) => !change.alreadyCaged), pypi.locks));
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
 *
 * On Windows configurations get the node running mcpcage and mcpcage's own cli.js, by their full
 * paths, which every client can start. The mcpcage.cmd npm installs starts only through cmd.exe:
 * checked on Windows 10 with Node 24, a plain child_process.spawn of it throws EINVAL (Node's fix of
 * CVE-2024-27980), so a client that starts servers so could not start what --fix wrote; the MCP
 * SDK's cross-spawn could. Both started node.exe given cli.js. A bare name would be looked for in the
 * client's current directory first.
 *
 * Run from a temporary place (see runningFrom), the PATH it was given starts with the runner's
 * directories, which userPath leaves out: from npx the mcpcage installed with `npm install -g` was
 * found past them, and an entry it had caged was said to start "not the mcpcage on your PATH".
 */
function installedCommand(): McpcageCommand {
  if (process.platform === "win32") {
    const running = realpathSync.native(fileURLToPath(import.meta.url));
    // Run by npx, pnpm dlx, yarn dlx or bunx, mcpcage writes the user's own: the one their PATH finds.
    return { node: process.execPath, script: runningFrom() === undefined ? running : (installedScript() ?? running) };
  }
  // None on the user's PATH, the runner's own is the one --fix and wrap would write, and refuse.
  return commandOnPath("mcpcage") ?? commandOnPath("mcpcage", process.env.PATH ?? "") ?? "mcpcage";
}

/**
 * Refuses to write into configurations a mcpcage that lives in a temporary place (see
 * temporaryMcpcage), as `npx mcpcage protect --fix` did, and `pnpm dlx`, `yarn dlx` and `bunx` too:
 * the runner's bin, which the PATH it gives mcpcage finds first, or on Windows the cli.js it runs.
 * Once that place was gone, on the Windows PC protect said of the entry --fix had written "starts
 * ...\_npx\...\cli.js with ...\node.exe, one of which was not found". An explicit --command in such a
 * place is refused the same way; any other is written as given.
 */
function refuseTemporary(command: McpcageCommand, what: string): void {
  const temporary = temporaryMcpcage(command);
  if (temporary === undefined) return;
  throw new Error(
    `${temporary} is in a temporary place, where npx, pnpm dlx, yarn dlx or bunx put a package for one run: every server ${what} cages with it would stop starting once it is gone. ` +
      `Install mcpcage first (npm install -g mcpcage) and run mcpcage ${what} again, or pass --command with the full path of an installed mcpcage.`,
  );
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
    if (change.note !== undefined) print(`    ${change.note}`);
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
