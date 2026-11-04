import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, win32 } from "node:path";
import { parseArgs } from "node:util";
import { claudeCodeSections, readConfigFile, type ClientId, type ConfigLocation } from "./clients.js";
import {
  envValues, hostPath, hostVariable, isWrapped, moveHostEnv, replaceFile, RUN_OPTIONS, serverType, unwrapEntry, wrapEntry, type ServerEntry, type ServerType,
} from "./config.js";
import { hasComments, isJsonObject, parseJsonc } from "./jsonc.js";
import { parseLaunch, serverIdFor, type LaunchSpec } from "./launch.js";
import { MAX_DEPTH, nestedDeeperThan, tooDeep, type ToolDefinition } from "./manifest.js";
import { installScripts, type InstallScripts, type NpmRunner } from "./npm-scripts.js";
import { cageHome } from "./paths.js";
import type { SandboxOptions } from "./sandbox.js";
import { accountHome, sensitivePath, thisMachine } from "./sensitive.js";
import { describeFindings, highSeveritySigns, scanTool, type Finding } from "./suspicious.js";
import { terminalSafe } from "./terminal.js";

/*
 * `mcpcage protect`: every MCP configuration of this machine and of the current project, what each
 * server can reach in plain words, and the rewrite that puts the npx servers in the cage. A scan
 * changes no file. Values of environment variables, headers and credential arguments are never
 * kept in the report, printed or logged: only their names are.
 */

export interface ServerReport {
  client: ClientId;
  clientName: string;
  file: string;
  scope: "user" | "project";
  /** The project path, for the per-project servers of ~/.claude.json. */
  label?: string;
  name: string;
  type: ServerType;
  /** The command line the client runs (credentials masked), or the address of a remote server. */
  command: string;
  /** For npx entries, wrapped ones too (from the part after "--"): `name@range`, `name` or `local package <path>`. */
  packageSpec?: string;
  /**
   * Started through `mcpcage run` with its sandbox: false for `mcpcage run --no-sandbox`, which runs
   * on the host, and for a command that is not an installed mcpcage.
   */
  protectedByMcpcage: boolean;
  /**
   * For a wrapped entry, what its command is (see mcpcageAt): an installed mcpcage, another program
   * that only has the name, or nothing that can be found on this machine.
   */
  mcpcage?: "installed" | "other program" | "not found";
  /** For a caged entry: each run option that opens its cage, in plain words. */
  opened: string[];
  /** Names of the env variables, headers and arguments whose value looks like a secret. */
  secrets: string[];
  /** Arguments and --mount paths, as written, that open the whole disk, the whole home directory or a directory with credentials. */
  broadAccess: string[];
  /**
   * For npx entries and wrapped ones: the variables of its `env` that act on this machine once the
   * entry starts mcpcage (see HOST_ENV in config.ts), by name, with what each does. Never values.
   */
  hostEnv: Array<{ name: string; what: string }>;
  /** What in the entry is not as a client expects it, such as an argument that is not a string. */
  problems: string[];
  /** Why the entry could not be described whole: the report says so on its lines and goes on. */
  error?: string;
  installScripts?: InstallScripts;
  /** `skipped`: the path arguments the inspection did not mount, because they are sensitive (see sensitive.ts). */
  inspection?: { tools: number; findings: Finding[]; error?: string; skipped?: SkippedPath[] };
}

export interface SkippedPath {
  path: string;
  reason: string;
}

export type ScannedFile = ConfigLocation & { error?: string; servers: number };

export interface ProtectReport {
  files: ScannedFile[];
  servers: ServerReport[];
}

/** Starts one npx server in the cage and lists its tools: `argv` is its npx command line, `env` its environment. */
export type Inspector = (launch: { argv: string[]; env: Record<string, string> }) => Promise<ToolDefinition[]>;

export interface ScanOptions {
  locations: ConfigLocation[];
  home: string;
  /** Look install scripts up only in mcpcage's cache and npm's offline cache. */
  offline: boolean;
  /** mcpcage's own cache: the only place a scan writes to. */
  cacheDir: string;
  npmRunner?: NpmRunner;
  inspect?: Inspector;
  /**
   * The mcpcage command --fix writes into configurations (`--command`, or the one found in PATH): an
   * entry that starts the same file counts as an installed mcpcage, whatever its shim (see mcpcageAt).
   */
  ownCommand?: string;
}

/** Reads every configuration that exists and describes each of its servers. */
export async function scanConfigs(options: ScanOptions): Promise<ProtectReport> {
  const report: ProtectReport = { files: [], servers: [] };
  const lookups = new Map<string, InstallScripts>();
  for (const location of options.locations) {
    const file: ScannedFile = { ...location, servers: 0 };
    report.files.push(file);
    if (!location.exists) continue;
    let config: Record<string, unknown>;
    try {
      config = parseConfig(readText(location.file));
    } catch (error) {
      file.error = (error as Error).message;
      continue;
    }
    // The sections as the file is now, not as it was when the locations were listed.
    if (location.nested) file.nested = claudeCodeSections(config);
    for (const section of sectionsOf(file)) {
      const servers = valueAt(config, section.path);
      if (!isJsonObject(servers)) continue;
      for (const [name, entry] of Object.entries(servers)) {
        if (!isJsonObject(entry)) continue;
        report.servers.push(await describeServer(file, section.project, name, entry as ServerEntry, options, lookups));
        file.servers++;
      }
    }
  }
  return report;
}

async function describeServer(
  file: ScannedFile,
  project: string | undefined,
  name: string,
  entry: ServerEntry,
  options: ScanOptions,
  lookups: Map<string, InstallScripts>,
): Promise<ServerReport> {
  const type = serverType(entry);
  const server: ServerReport = {
    client: file.client,
    clientName: file.clientName,
    file: file.file,
    scope: file.scope,
    label: project,
    name,
    type,
    command: NO_COMMAND,
    protectedByMcpcage: false,
    secrets: [],
    broadAccess: [],
    hostEnv: [],
    problems: [],
    opened: [],
  };
  // Anything on the machine may have written the entry, and the report exists to find the ones
  // nobody meant to be there: whatever in one trips its description up is said on its own lines, and
  // the scan goes on with the others. One argument that could not be converted to text stopped the
  // whole report, every other server and file unreported.
  try {
    const shown = shownCommand(entry, type);
    server.command = shown.line;
    // Any program can be named mcpcage: only an installed one cages anything.
    if (type === "mcpcage") server.mcpcage = mcpcageAt(entry.command as string, options.ownCommand);
    server.protectedByMcpcage = server.mcpcage === "installed" && !withoutSandbox(entry);
    if (server.protectedByMcpcage) server.opened = openedBy(entry);
    server.secrets = [...new Set([...secretNames(entry), ...shown.secrets])];
    server.broadAccess = type === "remote" ? [] : broadPaths(stringArgs(entry), options.home);
    server.hostEnv = type === "npx" || type === "mcpcage" ? hostEnvOf(entry) : [];
    const odd = Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg !== "string").length : 0;
    if (odd > 0) server.problems.push(`args: ${odd === 1 ? "an argument that is not a string" : `${odd} arguments that are not strings`}`);
    const launch = npxCommand(entry, type);
    const npm = launch ? npmPackage(launch) : undefined;
    if (npm) server.packageSpec = npm.local ? `local package ${npm.spec}` : npm.spec;
    // Install scripts matter where they would run: an npx server outside the cage. A caged one whose
    // env acts on the host still installs in the cage, with the scripts disabled; one whose mcpcage
    // cannot be found does not start at all.
    if ((type === "npx" || (type === "mcpcage" && !server.protectedByMcpcage && server.mcpcage !== "not found")) && npm && !npm.local) {
      let lookup = lookups.get(npm.spec);
      if (!lookup) {
        lookup = installScripts(npm.spec, { offline: options.offline, cacheDir: options.cacheDir, runner: options.npmRunner });
        lookups.set(npm.spec, lookup);
      }
      server.installScripts = lookup;
    }
    if (options.inspect && launch) server.inspection = await inspectServer(options.inspect, launch, entry, shown.hidden);
  } catch (error) {
    // The values of the entry's env and headers stay out of the report, whatever the error says.
    server.error = hideValues(oneLine(messageOf(error)), [...Object.values(stringValues(entry.env)), ...Object.values(stringValues(entry.headers))]);
  }
  return server;
}

async function inspectServer(inspect: Inspector, argv: string[], entry: ServerEntry, hidden: string[]): Promise<NonNullable<ServerReport["inspection"]>> {
  // A wrapped entry gives the server some of its variables as `--env NAME=value`: the cage gets them too.
  const moved = isWrapped(entry) ? envValues(stringArgs(entry)) : [];
  const env = { ...stringValues(entry.env), ...Object.fromEntries(moved.map((variable) => [variable.name, variable.value])) };
  // Reported whether the server lists its tools or not: one that needs the path left out may not start.
  const npm = npmLaunch(argv);
  const skipped = npm ? inspectionPlan(npm).skipped : [];
  const left = skipped.length > 0 ? { skipped } : {};
  try {
    const tools = await inspect({ argv, env });
    // The proxy refuses such a listing whole, so the report does not read it either.
    const deep = tooDeep(tools);
    if (deep) throw new Error(`the definition of "${deep.name}" is nested more than ${MAX_DEPTH} levels deep, which mcpcage refuses`);
    return { tools: tools.length, findings: findingsIn(tools), ...left };
  } catch (error) {
    // The server's own error output may repeat a value it was given: no value reaches the report.
    return { tools: 0, findings: [], error: hideValues(oneLine((error as Error).message), [...Object.values(env), ...hidden]), ...left };
  }
}

/** Every sign in every tool, worst first; each field starts with its tool's name, since a server has several. */
function findingsIn(tools: ToolDefinition[]): Finding[] {
  const order = ["high", "medium", "low"];
  return tools
    .flatMap((tool) => scanTool(tool).map((finding) => ({ ...finding, field: `${tool.name}.${finding.field}` })))
    .sort((left, right) => order.indexOf(left.severity) - order.indexOf(right.severity));
}

/**
 * How `--inspect` starts one npx server: in its cage, without network, with its existing path
 * arguments mounted READ-ONLY at the same place and given as absolute paths, because some servers
 * (server-filesystem) check their directories at start. Nothing in the cage is writable. A path is
 * mounted as it is written: parseMount would read a final `:rw` as an option, and a server given a
 * directory named `.ssh:rw` was inspected with the real ~/.ssh mounted writable.
 */
export function inspectionSandbox(launch: { argv: string[]; env: Record<string, string> }): Omit<SandboxOptions, "log"> {
  const spec = parseLaunch(launch.argv);
  if (spec.kind !== "npm") throw new Error("only npx servers can be inspected");
  const plan = inspectionPlan(spec);
  const mounts = plan.mounted.map((path) => {
    // docker's --mount takes comma-separated fields: `mcpcage run` refuses such a path too (parseMount).
    if (path.includes(",")) throw new Error(`paths containing commas are not supported (${path})`);
    return { source: path, target: path, readOnly: true };
  });
  return {
    // The id `mcpcage run` gives the entry once caged, so the image built now is the one it reuses.
    serverId: serverIdFor(plan.spec),
    spec: plan.spec,
    mounts,
    // The values reach only the container, which has no network; they are never printed.
    env: Object.entries(launch.env).map(([name, value]) => `${name}=${value}`),
    allowNet: false,
    memory: "512m",
    cpus: "1",
    keepImageUser: false,
    rebuild: false,
  };
}

/**
 * The server as an inspection starts it, its existing path arguments made absolute, and which of
 * them are mounted: every one but those that sensitive.ts refuses, which `wrap` and `--fix` refuse
 * too, and which an inspection leaves out rather than open to a server nobody has looked at yet.
 * The server is still given the argument.
 */
function inspectionPlan(spec: NpmLaunch): { spec: NpmLaunch; mounted: string[]; skipped: SkippedPath[] } {
  const paths = spec.args.map((arg) => hostPath(arg));
  const mounted: string[] = [];
  const skipped: SkippedPath[] = [];
  for (const path of new Set(paths.filter((path): path is string => path !== undefined))) {
    const reason = sensitivePath(path, thisMachine());
    if (reason === undefined) mounted.push(path);
    else skipped.push({ path, reason });
  }
  return { spec: { ...spec, args: spec.args.map((arg, index) => paths[index] ?? arg) }, mounted, skipped };
}

type NpmLaunch = Extract<LaunchSpec, { kind: "npm" }>;

/** The npx launch of a command line, or undefined for one that `mcpcage run` would not start. */
function npmLaunch(argv: string[]): NpmLaunch | undefined {
  try {
    const spec = parseLaunch(argv);
    return spec.kind === "npm" ? spec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A server that runs on this machine with the user's permissions: npx outside mcpcage,
 * `mcpcage run --no-sandbox`, or a program that is only named mcpcage; or a caged one whose env
 * runs on this machine, in mcpcage, first. An mcpcage that cannot be found starts nothing.
 */
export function isUncaged(server: ServerReport): boolean {
  if (server.type === "npx") return true;
  if (server.type !== "mcpcage") return false;
  // A wrapped entry that could not be described is not known to be caged.
  if (server.error !== undefined) return true;
  if (server.mcpcage === "not found") return false;
  return !server.protectedByMcpcage || server.hostEnv.length > 0;
}

/**
 * What a wrapped entry's command is on this machine. An absolute path is taken as written, a bare
 * name is looked up in PATH as `which` would; symlinks are followed (a global npm install links
 * bin/mcpcage to the package's dist/cli.js) and the nearest package.json a few directories up must
 * say "mcpcage". `/tmp/evil/mcpcage run -- ...` was reported caged, and left alone by --fix, for its
 * name alone. The same file as `own`, the command --fix writes, is mcpcage whatever it is: pnpm and
 * Volta install a script or a program of their own, not a link into the package, and an entry --fix
 * wrote with one was a look-alike at the next scan, rewritten again by every --fix.
 */
export function mcpcageAt(command: string, own?: string): NonNullable<ServerReport["mcpcage"]> {
  const real = realCommand(command);
  if (real === undefined) return "not found";
  if (own !== undefined && realCommand(own) === real) return "installed";
  // npm on Windows installs a mcpcage.cmd script next to node_modules\mcpcage, not a link.
  if (process.platform === "win32" && /\.(cmd|ps1)$/i.test(real) && packageName(join(dirname(real), "node_modules", "mcpcage")) === "mcpcage") return "installed";
  let dir = dirname(real);
  for (let level = 0; level < 4; level++) {
    if (existsSync(join(dir, "package.json"))) return packageName(dir) === "mcpcage" ? "installed" : "other program";
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "other program";
}

/** The file a command starts here, symlinks followed, or undefined when there is none. */
function realCommand(command: string): string | undefined {
  const found = onThisMachine(command);
  if (found === undefined) return undefined;
  try {
    return realpathSync(found);
  } catch {
    return undefined;
  }
}

/** The file a command names here: an absolute path that exists, or a bare name's first match in PATH. */
function onThisMachine(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  // A relative path depends on the directory the client starts it from, which is not known here.
  if (/[/\\]/.test(command)) return undefined;
  const windows = process.platform === "win32";
  const extensions = windows && !/\.[^.]+$/.test(command) ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const file = join(dir, `${command}${extension}`);
      try {
        if (!statSync(file).isFile()) continue;
        if (!windows) accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not here, or not a program: on to the next
      }
    }
  }
  return undefined;
}

function packageName(dir: string): unknown {
  try {
    const manifest = JSON.parse(readConfigFile(join(dir, "package.json")).toString("utf8")) as unknown;
    return isJsonObject(manifest) ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run options of a caged entry that open its cage, in plain words: each was written on purpose,
 * so --fix leaves them, and the report is where they show. Options that `mcpcage run` refuses start
 * nothing, and open nothing.
 */
function openedBy(entry: ServerEntry): string[] {
  const args = stringArgs(entry);
  const separator = args.indexOf("--");
  let values: ReturnType<typeof runValues>;
  try {
    values = runValues(args.slice(1, separator === -1 ? args.length : separator));
  } catch {
    return [];
  }
  const lines: string[] = [];
  if (values["allow-net"]) {
    // Only what is passed with --env reaches the cage: its env alone stays outside.
    const names = [...new Set(values.env.map((variable) => variable.split("=")[0]!))].filter((name) => SECRET_NAME.test(name)).map(terminalSafe);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    lines.push(`network: on (--allow-net)${list === undefined ? "" : `, so it can send ${list} over the network`}`);
  }
  if (values["allow-server-requests"]) lines.push("can ask your client to run the model or to question you (--allow-server-requests)");
  if (values["keep-image-user"]) lines.push("runs as the image's own user, which may be root (--keep-image-user)");
  // The access lines name the paths.
  if (values["allow-sensitive-mount"]) lines.push("may mount the whole disk, your home directory or a directory with credentials (--allow-sensitive-mount)");
  // Docker reads 0 as no limit at all.
  if (Number.parseFloat(values.memory) <= 0) lines.push(`no memory limit (--memory ${terminalSafe(values.memory)})`);
  if (Number.parseFloat(values.cpus) <= 0) lines.push(`no CPU limit (--cpus ${terminalSafe(values.cpus)})`);
  return lines;
}

function runValues(own: string[]) {
  return parseArgs({ args: own, options: RUN_OPTIONS, strict: true }).values;
}

/** The variables of an entry's env that act on the host once it starts mcpcage, with what each does. */
function hostEnvOf(entry: ServerEntry): ServerReport["hostEnv"] {
  if (!isJsonObject(entry.env)) return [];
  return Object.entries(entry.env).flatMap(([name, value]) => {
    const host = hostVariable(name, value);
    return host === undefined ? [] : [{ name, what: host.what }];
  });
}

/** `mcpcage run --no-sandbox -- ...`: pinned and audited, but started on the host without isolation. */
function withoutSandbox(entry: ServerEntry): boolean {
  if (!isWrapped(entry)) return false;
  const args = stringArgs(entry);
  const separator = args.indexOf("--");
  return (separator === -1 ? args : args.slice(0, separator)).includes("--no-sandbox");
}

// ---------------------------------------------------------------------------------------------
// The report as the terminal shows it.

const NAME_WIDTH = 12;
const COMMAND_WIDTH = 64;
const NO_COMMAND = "(no command)";

/** One block per configuration file, user files before project files, one line for the files not found, then a summary. */
export function renderReport(report: ProtectReport, options: { home: string }): string {
  const lines: string[] = [];
  const absent: string[] = [];
  const block = (header: string, servers: ServerReport[]) => {
    lines.push(header);
    if (servers.length === 0) lines.push("  (no servers)");
    for (const server of servers) lines.push(...serverLines(server, options.home));
  };
  for (const file of report.files) {
    const header = `${file.clientName}  ${shownFile(file, options.home)}`;
    if (!file.exists) {
      absent.push(file.clientName);
      continue;
    }
    if (file.error !== undefined) {
      lines.push(header, `  could not read this file: ${printable(file.error)}`);
      continue;
    }
    const servers = report.servers.filter((server) => server.file === file.file);
    if (!file.nested) {
      block(header, servers);
      continue;
    }
    for (const section of sectionsOf(file)) {
      const inSection = servers.filter((server) => server.label === section.project);
      // A real ~/.claude.json lists dozens of projects, most of them without servers of their own.
      if (section.project !== undefined && inSection.length === 0) continue;
      block(`${header} (${printable(section.label)})`, inSection);
    }
  }
  // Most clients are not installed on a given machine: their paths would bury the files that matter.
  // The client list sits on its own line, so the report stays readable in narrow terminals.
  if (absent.length > 0) {
    lines.push(`Not found: ${absent.length} other configuration file${absent.length === 1 ? "" : "s"}`, `  ${[...new Set(absent)].join(", ")}`);
  }
  lines.push("", "Summary", ...summary(report));
  return lines.join("\n");
}

/**
 * Fixed columns: details always start at column 15. A longer name pushes its own command to the
 * right, and the status stays in its column as long as the line allows.
 */
function serverLines(server: ServerReport, home: string): string[] {
  const indent = " ".repeat(NAME_WIDTH + 4);
  const details: string[] = server.problems.map(printable);
  if (server.error !== undefined) details.push(`could not describe this entry: ${printable(server.error)}`);
  for (const path of server.broadAccess) details.push(`access: ${printable(path)}: ${broadAccessKind(path, home) ?? "a broad path"}`);
  if (server.secrets.length > 0) details.push(`${server.secrets.length === 1 ? "secret" : "secrets"} in clear text: ${server.secrets.map(printable).join(", ")}`);
  if (server.installScripts) details.push(installLine(server.installScripts));
  // Before what --inspect found, whose signs belong under its own line.
  for (const variable of server.hostEnv) details.push(`env ${printable(variable.name)}: ${variable.what}`);
  details.push(...server.opened);
  for (const skipped of server.inspection?.skipped ?? []) details.push(`inspected without ${printable(tilde(skipped.path, home))}: ${printable(skipped.reason)}`);
  const findings: string[] = [];
  if (server.inspection?.error !== undefined) {
    details.push(`could not inspect: ${printable(server.inspection.error)}`);
  } else if (server.inspection) {
    details.push(`tools: ${server.inspection.tools}, ${signs(server.inspection.findings)}`);
    // describeFindings indents by four spaces: these lines line up with the details above them.
    findings.push(...describeFindings(server.inspection.findings).map((line) => `${indent.slice(4)}${line}`));
  }
  const nameAndCommand = `${printable(server.name).padEnd(NAME_WIDTH)}  ${printable(server.command)}`;
  return [
    `  ${nameAndCommand.padEnd(NAME_WIDTH + 2 + COMMAND_WIDTH)}  ${status(server)}`,
    ...details.map((detail) => `${indent}${detail}`),
    ...findings,
  ];
}

function status(server: ServerReport): string {
  // An npx entry runs on the host whatever else could not be read in it.
  if (server.error !== undefined && server.type !== "npx") return "could not be described";
  switch (server.type) {
    case "npx":
      return "NOT CAGED";
    case "mcpcage": {
      const command = terminalSafe(commandOf(server.command));
      if (server.mcpcage === "other program") return `starts ${command}, which is not an installed mcpcage`;
      if (server.mcpcage === "not found") return `starts ${command}, which ${/[/\\]/.test(command) ? "was not found" : "is not on your PATH"}`;
      if (!server.protectedByMcpcage) return "mcpcage --no-sandbox: pinning and audit only, no isolation";
      // The env acts first, on the host, before any cage exists.
      if (server.hostEnv.length > 0) return "caged, but its env runs on your machine";
      return server.opened.length > 0 ? "caged, with the cage opened" : "caged";
    }
    case "remote":
      return "remote, nothing to cage";
    case "docker":
      return "docker, already containerized";
    case "uvx":
      return "uvx, not supported yet";
    default:
      return server.command === NO_COMMAND ? "no command: nothing to start" : `${printable(programOf(server.command))}, not npx: cannot be caged yet`;
  }
}

function installLine(lookup: InstallScripts): string {
  if (lookup.status === "found") {
    return `install scripts: ${lookup.scripts.join(", ")} (they run with your permissions when npx installs the package${lookup.detail ? `; ${printable(lookup.detail)}` : ""})`;
  }
  return `install scripts: ${lookup.status}${lookup.detail ? ` (${printable(lookup.detail)})` : ""}`;
}

function signs(findings: Finding[]): string {
  const high = findings.filter((finding) => finding.severity === "high").length;
  if (high > 0) return highSeveritySigns(high);
  if (findings.length > 0) return `no high-severity signs, ${findings.length} minor sign${findings.length === 1 ? "" : "s"} to look at`;
  return "no signs of hidden instructions";
}

function summary(report: ProtectReport): string[] {
  const servers = report.servers;
  const count = (test: (server: ServerReport) => boolean) => servers.filter(test).length;
  const many = (number: number, one: string, more: string) => `${number} ${number === 1 ? one : more}`;
  const present = report.files.filter((file) => file.exists).length;
  const uncaged = count(isUncaged);
  const elsewhere = count((server) => server.type !== "npx" && server.type !== "mcpcage");
  const inCage = (server: ServerReport) => server.type === "mcpcage" && server.mcpcage === "installed" && !isUncaged(server);
  const caged = count((server) => inCage(server) && server.opened.length === 0);
  const opened = count((server) => inCage(server) && server.opened.length > 0);
  const missing = count((server) => server.type === "mcpcage" && server.error === undefined && server.mcpcage === "not found");
  const scripts = count((server) => server.installScripts?.status === "found");
  const run = `  ${many(uncaged, "runs", "run")} on your machine with your permissions and no cage.`;
  const lines = [
    `  ${many(servers.length, "server", "servers")} in ${many(present, "configuration file", "configuration files")} (${many(report.files.length, "file", "files")} checked, ${report.files.length - present} absent).`,
    uncaged > 0 ? `${run.padEnd(68)}-> mcpcage protect --fix` : run,
    `  ${many(count((server) => server.secrets.length > 0), "keeps", "keep")} a secret in clear text in a configuration file.`,
    `  ${count((server) => server.broadAccess.length > 0)} can reach your whole home directory, the disk or a directory with credentials.`,
    `  ${many(scripts, "uses", "use")} a package with install scripts.`,
  ];
  if (servers.some((server) => server.inspection)) {
    const poisoned = count((server) => server.inspection?.findings.some((finding) => finding.severity === "high") ?? false);
    const failed = count((server) => server.inspection?.error !== undefined);
    lines.push(`  ${many(poisoned, "has", "have")} tools with high-severity signs of hidden instructions.`);
    if (failed > 0) lines.push(`  ${many(failed, "server", "servers")} could not be inspected.`);
  }
  lines.push(
    `  ${many(elsewhere, "is", "are")} remote, already containerized, or started by another command: mcpcage cannot cage ${elsewhere === 1 ? "it" : "them"} yet.`,
    `  ${caged} already ${caged === 1 ? "runs" : "run"} through mcpcage.`,
  );
  if (opened > 0) lines.push(`  ${many(opened, "runs", "run")} through mcpcage with the cage opened by ${opened === 1 ? "its" : "their"} options.`);
  if (missing > 0) lines.push(`  ${many(missing, "starts", "start")} an mcpcage that could not be found.`);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The rewrite.

export interface FixedFile {
  file: string;
  /** `envOnly`: an entry already caged whose env moved off the host; its image stays the same. */
  changed: Array<{ name: string; label?: string; after: ServerEntry; envOnly?: boolean }>;
  skipped: Array<{ name: string; label?: string; reason: string }>;
  /** Why the whole file was left as it is. */
  refused?: string;
  backup?: string;
}

export interface FixOutcome {
  files: FixedFile[];
}

export interface FixOptions {
  report: ProtectReport;
  /** The mcpcage command written into the configurations. */
  command: string;
  claudeCodeRunning: boolean;
  /** Plan and log the same changes without writing anything. */
  dryRun: boolean;
  log: (line: string) => void;
  /** Shown as ~ in messages (default: the user's home directory). */
  home?: string;
}

/**
 * Rewrites the report's npx servers to start through `mcpcage run`, and moves the env that would
 * run on this machine out of the caged ones (see moveHostEnv), file by file. Each file is read again
 * right before it changes; only its server entries change, in the file's own style, with a backup
 * next to it and an atomic replace.
 */
export function fixConfigs(options: FixOptions): FixOutcome {
  const home = options.home ?? homedir();
  const files: FixedFile[] = [];
  for (const file of options.report.files) {
    if (!file.exists || file.error !== undefined) continue;
    const servers = options.report.servers.filter((server) => server.file === file.file);
    // A program that is only named mcpcage gets the rewrite an npx entry gets.
    const targets = servers.filter(
      (server) => server.type === "npx" || (server.type === "mcpcage" && ((server.protectedByMcpcage && server.hostEnv.length > 0) || server.mcpcage === "other program")),
    );
    // Already wrapped, so there is nothing to rewrite: only the person who chose --no-sandbox can drop it.
    const onHost = servers.filter((server) => server.type === "mcpcage" && server.mcpcage === "installed" && !server.protectedByMcpcage && server.error === undefined);
    if (targets.length === 0 && onHost.length === 0) continue;
    try {
      files.push(fixFile(file, targets, onHost, options, home));
    } catch (error) {
      // One file that cannot be rewritten leaves the others to be.
      const fixed: FixedFile = { file: file.file, changed: [], skipped: [], refused: messageOf(error) };
      options.log(`  not changed: ${shownFile(file, home)}: ${printable(fixed.refused!)}`);
      files.push(fixed);
    }
  }
  return { files };
}

function fixFile(file: ScannedFile, targets: ServerReport[], onHost: ServerReport[], options: FixOptions, home: string): FixedFile {
  const fixed: FixedFile = { file: file.file, changed: [], skipped: [] };
  const shown = shownFile(file, home);
  const where = (label: string | undefined) => (label === undefined ? shown : `${shown} (project ${printable(label)})`);

  let bytes: Buffer;
  let config: Record<string, unknown>;
  try {
    bytes = readConfigFile(file.file);
    config = parseConfig(bytes.toString("utf8"));
  } catch (error) {
    fixed.refused = `could not read it again: ${(error as Error).message}`;
    options.log(`  not changed: ${shown}: ${printable(fixed.refused)}`);
    return fixed;
  }
  const text = bytes.toString("utf8");

  // The variables each rewrite takes out of an entry's env, which a rewrite by hand must take out too.
  const removed = new Map<ServerEntry, string[]>();
  for (const server of targets) {
    const servers = valueAt(config, server.label === undefined ? [file.key] : ["projects", server.label, "mcpServers"]);
    const entry = isJsonObject(servers) && Object.hasOwn(servers, server.name) ? servers[server.name] : undefined;
    const wrapped = !isJsonObject(servers) || !isJsonObject(entry) ? { skip: "it is no longer in the file" } : rewrite(entry as ServerEntry, options.command);
    if ("skip" in wrapped) {
      fixed.skipped.push({ name: server.name, label: server.label, reason: wrapped.skip });
      continue;
    }
    (servers as Record<string, unknown>)[server.name] = wrapped.entry;
    fixed.changed.push({ name: server.name, label: server.label, after: wrapped.entry, ...(wrapped.envOnly ? { envOnly: true } : {}) });
    const before = isJsonObject((entry as ServerEntry).env) ? Object.keys((entry as ServerEntry).env!) : [];
    removed.set(wrapped.entry, before.filter((name) => !Object.hasOwn(wrapped.entry.env ?? {}, name)));
  }
  for (const server of onHost) {
    fixed.skipped.push({ name: server.name, label: server.label, reason: "it runs with --no-sandbox, without isolation; remove --no-sandbox from its arguments by hand" });
  }
  for (const skipped of fixed.skipped) options.log(`  not changed: ${printable(skipped.name)} in ${where(skipped.label)}: ${printable(skipped.reason)}`);
  if (fixed.changed.length === 0) return fixed;

  // When the file cannot be rewritten, the exact command each server should run instead.
  const byHand = fixed.changed.flatMap((change) => {
    const line = `    ${printable(change.name)}${change.label === undefined ? "" : ` (project ${printable(change.label)})`}: ${printable(shownCommand(change.after, "mcpcage").line)}`;
    const names = removed.get(change.after) ?? [];
    return names.length === 0 ? [line] : [line, `      and remove from its "env": ${names.map(printable).join(", ")}`];
  });
  if (byHand.some((line) => line.includes(MASK))) byHand.push(`    (${MASK} stands for the value already in the file, which is not shown)`);
  if (hasComments(text)) {
    fixed.refused = "it has comments";
    fixed.changed = [];
    options.log(`  not changed: ${shown} has comments, which rewriting it would lose. Edit it by hand so that each server runs the command shown ("command" is its first word, "args" the rest):`);
    for (const line of byHand) options.log(line);
    return fixed;
  }
  // JSON.stringify recurses, and an unrelated setting nested a few thousand levels deep ran it out of
  // stack, which stopped the rewrite of every file after this one.
  if (nestedDeeperThan(config, MAX_DEPTH)) {
    fixed.refused = `it nests values more than ${MAX_DEPTH} levels deep`;
    fixed.changed = [];
    options.log(`  not changed: ${shown} nests values more than ${MAX_DEPTH} levels deep, which mcpcage does not rewrite. Edit it by hand so that each server runs the command shown ("command" is its first word, "args" the rest):`);
    for (const line of byHand) options.log(line);
    return fixed;
  }
  if (file.client === "claude-code" && file.scope === "user" && options.claudeCodeRunning) {
    fixed.refused = "Claude Code is running";
    fixed.changed = [];
    for (const line of byHand) options.log(line);
    options.log(
      "  not changed: Claude Code is running and rewrites ~/.claude.json while it runs: close it and run mcpcage protect --fix again, or add the servers again with claude mcp add using the commands above",
    );
    return fixed;
  }
  if (!options.dryRun) fixed.backup = replaceFile(file.file, bytes, serialize(config, text));
  for (const change of fixed.changed) options.log(`  ${options.dryRun ? "cage" : "caged"} ${printable(change.name)} in ${where(change.label)}`);
  if (fixed.backup) options.log(`  backup: ${printable(file.scope === "user" ? tilde(fixed.backup, home) : fixed.backup)}`);
  return fixed;
}

/**
 * An npx entry wrapped, a caged entry with its env moved off the host, or the npx command a program
 * only named mcpcage would start, wrapped as wrap would have wrapped it; or why it stays as it is.
 * What the command is, is looked at again: the file may have changed since the scan.
 */
function rewrite(entry: ServerEntry, command: string): { entry: ServerEntry; envOnly?: boolean } | { skip: string } {
  if (serverType(entry) !== "mcpcage") return wrapEntry(entry, { command });
  const found = mcpcageAt(entry.command as string, command);
  if (found === "other program") {
    const inner = unwrapEntry(entry);
    return "skip" in inner ? inner : wrapEntry(inner.entry, { command });
  }
  if (found === "not found") return { skip: "its mcpcage can no longer be found" };
  const moved = moveHostEnv(entry);
  return moved === undefined ? { skip: "its env no longer runs on your machine" } : "skip" in moved ? moved : { entry: moved.entry, envOnly: true };
}

/** JSON in the file's own style: its indentation unit, line endings, final newline and byte order mark. */
function serialize(config: unknown, original: string): string {
  const unit = /\n([ \t]+)\S/.exec(original)?.[1];
  const indent = unit === undefined ? undefined : unit.startsWith("\t") ? "\t" : Math.min(unit.length, 10);
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  let text = JSON.stringify(config, null, indent);
  if (newline === "\r\n") text = text.replace(/\n/g, "\r\n");
  if (original.endsWith("\n")) text += newline;
  return original.startsWith("\uFEFF") ? `\uFEFF${text}` : text;
}

// ---------------------------------------------------------------------------------------------
// What an entry exposes.

// "author" is not "auth": GIT_AUTHOR_NAME holds a name, not a credential (Authorization still counts).
const SECRET_NAME = /token|secret|key|password|passwd|pwd|auth(?!or(?!iz))|credential|api/i;
const MASK = "***";

function secretNames(entry: ServerEntry): string[] {
  const names: string[] = [];
  for (const values of [entry.env, entry.headers]) {
    if (!isJsonObject(values)) continue;
    for (const [name, value] of Object.entries(values)) if (SECRET_NAME.test(name) && looksLikeSecret(value)) names.push(name);
  }
  return names;
}

/** A value written out in full: not a placeholder that the client fills in, nor a path, number or plain address. */
function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length < 8 || isPlaceholder(text)) return false;
  if (/^(?:true|false|-?\d+(?:\.\d+)?)$/i.test(text)) return false;
  if (/^(?:~|\/|[A-Za-z]:[\\/])/.test(text)) return false; // the path of a key file is not the key
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || maskUrl(text).hidden.length > 0;
}

function isPlaceholder(text: string): boolean {
  return (
    /\$\{[^}]*\}/.test(text) || // ${VAR}, VS Code's ${env:VAR} and ${input:id}
    /<[^<>]*>/.test(text) || // <your token>
    /^your_/i.test(text) ||
    /xxx/i.test(text) ||
    /change[_-]?me/i.test(text) ||
    /^todo/i.test(text) ||
    /^\$[A-Za-z_]\w*$/.test(text) || // $GITHUB_TOKEN
    /^%[A-Za-z_]\w*%$/.test(text) // %GITHUB_TOKEN%
  );
}

/** The command line or address as the report shows it, with credentials masked and named. */
function shownCommand(entry: ServerEntry, type: ServerType): { line: string; secrets: string[]; hidden: string[] } {
  if (type === "remote") {
    const field = entry.url != null ? "url" : "serverUrl";
    const address = entry[field];
    const masked = maskUrl(typeof address === "string" ? address : "");
    const kind = typeof entry.type === "string" ? entry.type : "remote";
    return { line: masked.shown || `(${kind} server)`, secrets: masked.hidden.length > 0 ? [field] : [], hidden: masked.hidden };
  }
  if (typeof entry.command !== "string" || entry.command === "") return { line: NO_COMMAND, secrets: [], hidden: [] };
  const masked = maskArgs(stringArgs(entry), type === "mcpcage");
  return { line: [entry.command, ...masked.shown].map((part) => (part === "" || /\s/.test(part) ? `"${part}"` : part)).join(" "), ...masked };
}

/**
 * `--api-key sk-...`, `--token=...`, `API_KEY=...`, `Authorization: Bearer ...` and credentials in
 * addresses, masked. In a wrapped entry, every `--env NAME=value` of mcpcage's own is masked: it is a
 * value of the env, moved there by `wrap`, and it counts as a secret when it looks like one.
 */
function maskArgs(args: string[], wrapped = false): { shown: string[]; secrets: string[]; hidden: string[] } {
  const shown = [...args];
  const secrets: string[] = [];
  const hidden: string[] = [];
  const env = new Map(wrapped ? envValues(args).map((variable) => [variable.index, variable]) : []);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const variable = env.get(index);
    if (variable !== undefined) {
      shown[index] = `${variable.prefix}${variable.name}=${MASK}`;
      hidden.push(variable.value);
      if (SECRET_NAME.test(variable.name) && looksLikeSecret(variable.value)) secrets.push(variable.name);
      continue;
    }
    const next = args[index + 1];
    if (/^--?[\w.-]+$/.test(arg) && SECRET_NAME.test(arg) && next !== undefined && !next.startsWith("-") && looksLikeSecret(next)) {
      shown[index + 1] = MASK;
      secrets.push(arg);
      hidden.push(next);
      index++;
      continue;
    }
    const pair = /^(--?[\w.-]+|[A-Za-z_][\w.-]*)(=|:[ \t]*)(.+)$/.exec(arg);
    if (pair && SECRET_NAME.test(pair[1]!) && looksLikeSecret(pair[3])) {
      shown[index] = `${pair[1]}${pair[2]}${MASK}`;
      secrets.push(pair[1]!);
      hidden.push(pair[3]!);
      continue;
    }
    const url = maskUrl(arg);
    if (url.hidden.length > 0) {
      shown[index] = url.shown;
      secrets.push("url");
      hidden.push(...url.hidden);
    }
  }
  return { shown, secrets, hidden };
}

/**
 * An address with its credentials masked: the password, a user name that is really a token
 * (https://ghp_...@github.com), and query values with a credential name. `root@localhost` stays.
 */
function maskUrl(text: string): { shown: string; hidden: string[] } {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { shown: text, hidden: [] };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { shown: text, hidden: [] };
  }
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const hidden: string[] = [];
  const password = decode(url.password);
  const username = decode(url.username);
  if (password !== "" && !isPlaceholder(password)) {
    hidden.push(password, url.password);
    url.password = MASK;
  } else if (password === "" && looksLikeSecret(username)) {
    hidden.push(username, url.username);
    url.username = MASK;
  }
  for (const name of [...new Set(url.searchParams.keys())]) {
    const value = url.searchParams.get(name) ?? "";
    if (SECRET_NAME.test(name) && looksLikeSecret(value)) {
      hidden.push(value);
      url.searchParams.set(name, MASK);
    }
  }
  return { shown: hidden.length > 0 ? url.toString() : text, hidden };
}

// Where ~, $HOME and %USERPROFILE% stand for the home directory.
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])/i;

/** Paths that open the whole home directory or more, or a directory with credentials: the --mount values of a wrapped entry count too. */
function broadPaths(args: string[], home: string): string[] {
  const candidates: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--mount" && index + 1 < args.length) candidates.push(args[++index]!.replace(/:(?:rw|ro)$/, ""));
    else if (arg.startsWith("--mount=")) candidates.push(arg.slice("--mount=".length).replace(/:(?:rw|ro)$/, ""));
    else candidates.push(arg);
  }
  const places = new Set<string>();
  const found: string[] = [];
  for (const candidate of candidates) {
    if (broadAccessKind(candidate, home) === undefined) continue;
    const place = normalizePath(expandHome(candidate, home)) ?? candidate;
    if (places.has(place)) continue; // the mount and the argument of a wrapped entry are the same place
    places.add(place);
    found.push(candidate);
  }
  return found;
}

/**
 * Plain words for a path that opens the whole disk, the whole home directory or more, or a directory
 * with credentials, as sensitive.ts decides for every mount; undefined for an ordinary one. A home
 * directory written like C:\Users\me means Windows paths. This machine's PATH and the account's own
 * home directory (which counts whatever HOME says) count only for paths of this machine's kind: they
 * are written in that syntax.
 */
export function broadAccessKind(path: string, home: string): string | undefined {
  const platform = /^[A-Za-z]:/.test(home) ? "win32" : process.platform === "win32" ? "linux" : process.platform;
  const here = platform === process.platform;
  return sensitivePath(expandHome(path, home), { home, account: here ? accountHome() : undefined, platform, cage: cageHome(), path: here ? process.env.PATH : undefined });
}

function expandHome(path: string, home: string): string {
  return path.trim().replace(HOME_PREFIX, () => home);
}

/** One spelling per place: `..` resolved, no trailing separator, Windows paths in lowercase with backslashes. */
function normalizePath(path: string): string | undefined {
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(path)) {
    const normal = win32.normalize(path.length === 2 ? `${path}\\` : path).toLowerCase();
    return normal.length > 3 ? normal.replace(/\\+$/, "") : normal;
  }
  if (!path.startsWith("/")) return undefined;
  const normal = posix.normalize(path);
  return normal.length > 1 ? normal.replace(/\/+$/, "") : normal;
}

// ---------------------------------------------------------------------------------------------
// Small helpers.

/** The npx command line of an npx entry, or of the server a wrapped entry starts after `--`. */
function npxCommand(entry: ServerEntry, type: ServerType): string[] | undefined {
  const args = stringArgs(entry);
  if (type === "npx") return [entry.command as string, ...args];
  if (type !== "mcpcage" || !args.includes("--")) return undefined;
  const inner = args.slice(args.indexOf("--") + 1);
  return inner[0] !== undefined && /(^|[/\\])npx(\.cmd)?$/.test(inner[0]) ? inner : undefined;
}

function npmPackage(argv: string[]): { spec: string; local: boolean } | undefined {
  try {
    const spec = parseLaunch(argv);
    if (spec.kind !== "npm") return undefined;
    if (spec.localPath !== undefined) return { spec: spec.localPath, local: true };
    return { spec: spec.versionRange ? `${spec.packageName}@${spec.versionRange}` : spec.packageName, local: false };
  } catch {
    return undefined; // npx flags that mcpcage does not reproduce: there is no package to look up
  }
}

function sectionsOf(file: ScannedFile): Array<{ path: string[]; label: string; project?: string }> {
  if (!file.nested) return [{ path: [file.key], label: file.scope }];
  return file.nested.map((section) => ({ ...section, project: section.path[0] === "projects" ? section.path[1] : undefined }));
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) current = isJsonObject(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  return current;
}

function readText(file: string): string {
  try {
    return readConfigFile(file).toString("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A file over the size limit is said so in readConfigFile's words.
    throw new Error(code === undefined ? messageOf(error) : `could not read it (${code})`);
  }
}

function parseConfig(text: string): Record<string, unknown> {
  let config: unknown;
  try {
    config = parseJsonc(text);
  } catch (error) {
    // JSON.parse quotes the text around the mistake, which may be a secret: only say where it is.
    const at = /position (\d+)/.exec((error as Error).message)?.[1];
    const before = at === undefined ? undefined : text.slice(0, Number(at));
    throw new Error(`not valid JSON${before === undefined ? "" : ` (line ${before.split("\n").length}, column ${before.length - before.lastIndexOf("\n")})`}`);
  }
  if (!isJsonObject(config)) throw new Error("not a JSON object");
  return config;
}

/**
 * The arguments that are strings. Another value is never converted: an object whose toString is
 * null throws, and an array nested 10,000 levels deep runs out of stack. The report says it is there.
 */
function stringArgs(entry: ServerEntry): string[] {
  return Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
}

function stringValues(record: unknown): Record<string, string> {
  if (!isJsonObject(record)) return {};
  return Object.fromEntries(Object.entries(record).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
}

/** Longest values first, so one that contains another is hidden whole; very short values would hide ordinary words. */
function hideValues(text: string, values: string[]): string {
  let result = text;
  for (const value of [...new Set(values)].filter((value) => value.length >= 4).sort((left, right) => right.length - left.length)) {
    result = result.split(value).join(MASK);
  }
  return result;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** What a caught value says, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "an unexpected error";
}

/** The first word of a command line, as written (quoted when it has spaces). */
function commandOf(line: string): string {
  return line.startsWith('"') ? (/^"([^"]*)"/.exec(line)?.[1] ?? line) : (line.split(" ")[0] ?? line);
}

/** The program's file name, from the first word of a command line. */
function programOf(line: string): string {
  const first = commandOf(line);
  return first.split(/[/\\]/).pop() || first;
}

function shownFile(file: ScannedFile, home: string): string {
  return printable(file.scope === "user" ? tilde(file.file, home) : file.file);
}

/** A path under the home directory, written from ~. */
function tilde(path: string, home: string): string {
  const root = home.replace(/[\\/]+$/, "");
  if (root === "" || !path.startsWith(root)) return path;
  const rest = path.slice(root.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}

/** Configuration files and servers do not get to drive the terminal: control and format characters are spelled out. */
function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) => `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
}
