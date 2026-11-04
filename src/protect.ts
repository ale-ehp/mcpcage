import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { parseArgs } from "node:util";
import { claudeCodeSections, readConfigFile, type ClientId, type ConfigLocation } from "./clients.js";
import {
  actsOnHost, cageCheck, envEffects, envValues, hostPath, isWrapped, mcpcageArgs, moveHostEnv, replaceFile, RUN_OPTIONS, serverType, unwrapEntry, wrapEntry,
  type EnvEffects, type ServerEntry, type ServerType,
} from "./config.js";
import { envFileOf, mcpcageAt, nodeScript, type ForeignPath, type McpcageCommand, type McpcageKind } from "./installed.js";
import { hasComments, isJsonObject, parseJsonc } from "./jsonc.js";
import { cmdNpx, npxArgv, parseLaunch, serverIdFor, type LaunchSpec } from "./launch.js";
import { MAX_DEPTH, nestedDeeperThan, tooDeep, type ToolDefinition } from "./manifest.js";
import type { Redact } from "./inspect.js";
import { installScripts, type InstallScripts, type NpmRunner } from "./npm-scripts.js";
import { cageHome } from "./paths.js";
import type { SandboxOptions } from "./sandbox.js";
import { accountHome, clientPlaces, sensitivePath, thisMachine } from "./sensitive.js";
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
   * on the host, and for a command that is not the mcpcage --fix writes or the one running.
   */
  protectedByMcpcage: boolean;
  /**
   * For a wrapped entry, what its command is (see mcpcageAt): the mcpcage --fix writes or the one
   * running ("installed"), another program that only has the name, or nothing that can be found.
   */
  mcpcage?: McpcageKind;
  /** For a wrapped entry that starts node with a cli.js, as --fix writes on Windows (see nodeScript): that script. */
  script?: string;
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
  /**
   * For a wrapped entry that starts mcpcage: the directories of its env's PATH that are not on the
   * user's (see foreignPath), from which the client and mcpcage would start programs.
   */
  foreignPath?: ForeignPath;
  /** For a wrapped entry that starts mcpcage: the variables of its env that move the client configurations `run` refuses to mount (see movedPlaces). */
  movedPlaces: string[];
  /**
   * For npx entries and wrapped ones with an `envFile` (VS Code): the file as written, and what its
   * variables do on this machine, as those of `env` above; `effects` is missing when the file could
   * not be read, and `path` when the value is not a string.
   */
  envFile?: { path?: string; effects?: EnvEffects };
  /** What in the entry is not as a client expects it, such as an argument that is not a string. */
  problems: string[];
  /** For a `cmd /c npx` entry on Windows that runs more than npx, why it is not caged (see cmdNpx). */
  notPlain?: string;
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

/**
 * Starts one npx server in the cage and lists its tools: `argv` is its npx command line, `env` its
 * environment, and `redact` hides the values it was given in what an error quotes of it, before the
 * error cuts it (listTools).
 */
export type Inspector = (launch: { argv: string[]; env: Record<string, string>; redact: Redact }) => Promise<ToolDefinition[]>;

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
   * The mcpcage command --fix writes into configurations (`--command`, or the one found in PATH, or
   * on Windows node with mcpcage's cli.js): an entry that starts the same file, or the running
   * mcpcage, counts as mcpcage (see mcpcageAt).
   */
  ownCommand?: McpcageCommand;
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
    movedPlaces: [],
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
    // Any program can be named mcpcage, next to any package.json: only mcpcage itself cages anything.
    if (type === "mcpcage") server.mcpcage = mcpcageAt(entry as ServerEntry & { command: string }, options.ownCommand);
    const script = type === "mcpcage" ? nodeScript(entry) : undefined;
    if (script !== undefined) server.script = script;
    server.protectedByMcpcage = server.mcpcage === "installed" && !withoutSandbox(entry);
    if (server.protectedByMcpcage) server.opened = openedBy(entry);
    server.secrets = [...new Set([...secretNames(entry), ...shown.secrets])];
    // The script node.exe is given is mcpcage's own, in the PATH's npm directory: not a path the server is given.
    server.broadAccess = type === "remote" ? [] : broadPaths(fromRun(entry), options.home);
    if (type === "npx" || type === "mcpcage") {
      const installed = server.mcpcage === "installed";
      Object.assign(server, effectsOf(entry.env, installed));
      // VS Code adds the variables of the file an envFile names to those of env: they act the same way.
      const envFile = envFileOf(entry, file.file);
      if (envFile !== undefined) server.envFile = envFile.variables === undefined ? { path: envFile.path } : { path: envFile.path, effects: effectsOf(envFile.variables, installed) };
    }
    const cmd = type === "other" && Array.isArray(entry.args) ? cmdNpx([entry.command, ...entry.args]) : undefined;
    if (cmd !== undefined && "notPlain" in cmd) server.notPlain = cmd.notPlain;
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
    // Hidden before the message is put on one line: a value with line breaks would no longer be the same.
    server.error = oneLine(redactor([...Object.values(stringValues(entry.env)), ...Object.values(stringValues(entry.headers))])(messageOf(error)));
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
  // The server may repeat a value it was given, in its error output or in its tools: no value reaches the report.
  const values = [...Object.values(env), ...hidden];
  const redact = redactor(values);
  try {
    const tools = await inspect({ argv, env, redact });
    // The proxy refuses such a listing whole, so the report does not read it either.
    const deep = tooDeep(tools);
    if (deep) throw new Error(`the definition of "${deep.name}" is nested more than ${MAX_DEPTH} levels deep, which mcpcage refuses`);
    // Hidden in the definitions, before the scan quotes them: a snippet is clipped at 80 characters,
    // and a rule can match part of a value (a ghp_ token is a base64 blob without its prefix), so
    // masking the snippets afterwards would still print what the cut or the match left of it. A
    // server that copied an environment value into a description had it printed in its snippet.
    const shown = values.some((value) => value.length >= 4) ? tools.map((tool) => withoutValues(tool, redact)) : tools;
    // A sign can quote what it decodes, and tag characters can spell a value out: hidden there too.
    const findings = findingsIn(shown).map((finding) => ({ ...finding, snippet: redact(finding.snippet) }));
    return { tools: tools.length, findings, ...left };
  } catch (error) {
    // Hidden before the message is put on one line: a private key printed on stderr, its line breaks
    // made spaces, was no longer the value, and was printed.
    return { tools: 0, findings: [], error: oneLine(redact((error as Error).message)), ...left };
  }
}

/** A definition with what `redact` hides hidden in every string and key; it is no deeper than MAX_DEPTH, so recursion is safe. */
function withoutValues<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => withoutValues(item, redact)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [redact(key), withoutValues(inner, redact)])) as T;
  }
  return value;
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
 * runs on this machine, in mcpcage, first, whose PATH has directories that are not the user's, or
 * that moves the places `run` refuses to mount, its envFile's as well as its env's, or whose envFile
 * could not be read. An mcpcage that cannot be found starts nothing.
 */
export function isUncaged(server: ServerReport): boolean {
  if (server.type === "npx") return true;
  if (server.type !== "mcpcage") return false;
  // A wrapped entry that could not be described is not known to be caged.
  if (server.error !== undefined) return true;
  if (server.mcpcage === "not found") return false;
  return !server.protectedByMcpcage || actsOnHost(server) || envFileActs(server);
}

/**
 * The run options of a caged entry that open its cage, in plain words: each was written on purpose,
 * so --fix leaves them, and the report is where they show. Options that `mcpcage run` refuses start
 * nothing, and open nothing.
 */
function openedBy(entry: ServerEntry): string[] {
  const args = fromRun(entry);
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
  // wrap and --fix mount read-only: a :rw was chosen, and among the files it opens are some the host runs.
  for (const path of writablePaths(values.mount)) lines.push(`writable: ${terminalSafe(path)}: the server can change files there that git, editors and build tools run`);
  // Docker reads 0 as no limit at all.
  if (Number.parseFloat(values.memory) <= 0) lines.push(`no memory limit (--memory ${terminalSafe(values.memory)})`);
  if (Number.parseFloat(values.cpus) <= 0) lines.push(`no CPU limit (--cpus ${terminalSafe(values.cpus)})`);
  return lines;
}

function runValues(own: string[]) {
  return parseArgs({ args: own, options: RUN_OPTIONS, strict: true }).values;
}

/** The paths of the `--mount` values that `run` mounts writable (`<path>:rw`), as written. */
function writablePaths(mounts: string[]): string[] {
  return mounts.filter((mount) => mount.endsWith(":rw")).map((mount) => mount.slice(0, -":rw".length));
}

/** The paths a wrapped entry mounts writable, read as `run` reads its options; none when `run` would refuse them. */
export function writableMounts(entry: ServerEntry): string[] {
  const args = fromRun(entry);
  const separator = args.indexOf("--");
  try {
    return writablePaths(runValues(args.slice(1, separator === -1 ? args.length : separator)).mount);
  } catch {
    return [];
  }
}

/** The warning `wrap --writable` and `protect --fix --writable` print for each mount they make writable. */
export function writableWarning(name: string, path: string): string {
  return `WARNING ${terminalSafe(name)} can change files in ${terminalSafe(path)}, code and settings that git, editors and build tools run included (--writable)`;
}

/**
 * What an entry's env, or its envFile, does on the host once it starts mcpcage (see envEffects): the
 * variables that act there, for npx entries and wrapped ones; the PATH and the client places too for
 * an entry that starts mcpcage, whose own PATH decides nothing before it is wrapped.
 */
function effectsOf(variables: unknown, installed: boolean): EnvEffects {
  const effects = envEffects(variables);
  return installed ? effects : { hostEnv: effects.hostEnv, movedPlaces: [] };
}

/** An envFile that acts on the host, or that could not be read, so what it sets is unknown. */
function envFileActs(server: ServerReport): boolean {
  return server.envFile !== undefined && (server.envFile.effects === undefined || actsOnHost(server.envFile.effects));
}

/**
 * What `wrap` and `protect --fix` say of an entry they cage that keeps its envFile: VS Code loads it
 * as it is, now into mcpcage's environment, and the server gets only the variables named with --env.
 */
export function envFileNote(entry: ServerEntry): string | undefined {
  if (typeof entry.envFile !== "string") return undefined;
  return `its envFile stays: VS Code loads ${terminalSafe(entry.envFile)}, and its variables reach mcpcage on your machine (the server gets only those named with --env)`;
}

/** `mcpcage run --no-sandbox -- ...`: pinned and audited, but started on the host without isolation. */
function withoutSandbox(entry: ServerEntry): boolean {
  if (!isWrapped(entry)) return false;
  const args = fromRun(entry);
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
      lines.push(header, `  could not read this file: ${terminalSafe(file.error)}`);
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
      block(`${header} (${terminalSafe(section.label)})`, inSection);
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
  const details: string[] = server.problems.map(terminalSafe);
  if (server.notPlain !== undefined) details.push(`cmd: ${terminalSafe(server.notPlain)}`);
  if (server.error !== undefined) details.push(`could not describe this entry: ${terminalSafe(server.error)}`);
  for (const path of server.broadAccess) details.push(`access: ${terminalSafe(path)}: ${broadAccessKind(path, home) ?? "a broad path"}`);
  if (server.secrets.length > 0) details.push(`${server.secrets.length === 1 ? "secret" : "secrets"} in clear text: ${server.secrets.map(terminalSafe).join(", ")}`);
  if (server.installScripts) details.push(installLine(server.installScripts));
  // Before what --inspect found, whose signs belong under its own line.
  details.push(...effectLines("env", server));
  if (server.envFile?.effects !== undefined) details.push(...effectLines("envFile", server.envFile.effects));
  else if (server.envFile !== undefined) {
    details.push(`envFile: ${server.envFile.path === undefined ? "its value is not a string" : `${terminalSafe(server.envFile.path)} could not be read`}, so what it sets is unknown`);
  }
  details.push(...server.opened);
  for (const skipped of server.inspection?.skipped ?? []) details.push(`inspected without ${terminalSafe(tilde(skipped.path, home))}: ${terminalSafe(skipped.reason)}`);
  const findings: string[] = [];
  if (server.inspection?.error !== undefined) {
    details.push(`could not inspect: ${terminalSafe(server.inspection.error)}`);
  } else if (server.inspection) {
    details.push(`tools: ${server.inspection.tools}, ${signs(server.inspection.findings)}`);
    // describeFindings indents by four spaces: these lines line up with the details above them.
    findings.push(...describeFindings(server.inspection.findings).map((line) => `${indent.slice(4)}${line}`));
  }
  const nameAndCommand = `${terminalSafe(server.name).padEnd(NAME_WIDTH)}  ${terminalSafe(server.command)}`;
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
      if (server.script !== undefined) {
        const started = `starts ${terminalSafe(server.script)} with ${command}`;
        if (server.mcpcage === "other program") return `${started}, which are not mcpcage's cli.js and your node`;
        if (server.mcpcage === "not found") return `${started}, one of which was not found`;
      }
      if (server.mcpcage === "other program" && process.platform === "win32" && !/[/\\]/.test(command)) {
        return `starts ${command} by name, which Windows looks for in the client's current directory first`;
      }
      if (server.mcpcage === "other program") return `starts ${command}, which is not the mcpcage on your PATH`;
      if (server.mcpcage === "not found") return `starts ${command}, which ${/[/\\]/.test(command) ? "was not found" : "is not on your PATH"}`;
      if (!server.protectedByMcpcage) return "mcpcage --no-sandbox: pinning and audit only, no isolation";
      // The env acts first, on the host, before any cage exists.
      const fromFile = server.envFile?.effects;
      if (server.hostEnv.length > 0 || (fromFile?.hostEnv.length ?? 0) > 0) return "caged, but its env runs on your machine";
      if (server.envFile !== undefined && fromFile === undefined) return "caged, but what its envFile sets is unknown";
      if (server.foreignPath !== undefined || fromFile?.foreignPath !== undefined) return "caged, but its PATH picks other programs";
      if (server.movedPlaces.length > 0 || (fromFile?.movedPlaces.length ?? 0) > 0) return "caged, but its env moves what run refuses to mount";
      return server.opened.length > 0 ? "caged, with the cage opened" : "caged";
    }
    case "remote":
      return "remote, nothing to cage";
    case "docker":
      return "docker, already containerized";
    case "uvx":
      return "uvx, not supported yet";
    default:
      if (server.command === NO_COMMAND) return "no command: nothing to start";
      return `${terminalSafe(programOf(server.command))}, ${server.notPlain === undefined ? "not npx: cannot be caged yet" : "not a plain npx command line: cannot be caged"}`;
  }
}

/** What the variables of an entry's env, or of its envFile, do on the host, one line each: `from` says which. */
function effectLines(from: "env" | "envFile", effects: EnvEffects): string[] {
  const lines = effects.hostEnv.map((variable) => `${from} ${terminalSafe(variable.name)}: ${variable.what}`);
  if (effects.foreignPath !== undefined) lines.push(...pathLines(from, effects.foreignPath));
  for (const name of effects.movedPlaces) lines.push(`${from} ${terminalSafe(name)}: ${MOVED_PLACE}`);
  return lines;
}

/** The directories of an entry's PATH that are not the user's, a few by name and the others counted: a PATH can be long. */
function pathLines(from: "env" | "envFile", path: ForeignPath): string[] {
  const why = "it decides which programs start mcpcage and which mcpcage starts";
  if (path.notString) return [`${from} PATH: its value is not a string, so the directories it names are not known; ${why}`];
  const lines = path.dirs.slice(0, PATH_LINES).map((dir) => `${from} PATH: ${dir === "" ? '""' : terminalSafe(dir)} is not on your PATH; ${why}`);
  const more = path.dirs.length - lines.length;
  if (more > 0) lines.push(`${from} PATH: and ${more} more ${more === 1 ? "directory" : "directories"} that ${more === 1 ? "is" : "are"} not on your PATH`);
  return lines;
}

/** The directories of a PATH named one by one in the report. */
const PATH_LINES = 3;

/** What a variable of movedPlaces does, in plain words. */
const MOVED_PLACE = "differs from yours, so mcpcage run would look for the clients' configurations elsewhere, and its mount check would miss the real place";

function installLine(lookup: InstallScripts): string {
  if (lookup.status === "found") {
    return `install scripts: ${lookup.scripts.join(", ")} (they run with your permissions when npx installs the package${lookup.detail ? `; ${terminalSafe(lookup.detail)}` : ""})`;
  }
  return `install scripts: ${lookup.status}${lookup.detail ? ` (${terminalSafe(lookup.detail)})` : ""}`;
}

function signs(findings: Finding[]): string {
  const high = findings.filter((finding) => finding.severity === "high").length;
  if (high > 0) return highSeveritySigns(high);
  if (findings.length > 0) return `no high-severity signs, ${findings.length} minor sign${findings.length === 1 ? "" : "s"} to look at`;
  return "no signs of hidden instructions";
}

/**
 * The configuration files that are there but could not be checked: too large, not a regular file,
 * not valid JSON, or unreadable. What they start is not known, and a client may read one that
 * mcpcage refuses (a file of 17 MiB, most of it whitespace): `protect` counts them in its summary,
 * and exits as it does for an uncaged server. It said "could not read this file" on the file's own
 * lines, then a clean summary, and exited 0.
 */
export function uncheckedFiles(report: ProtectReport): number {
  return report.files.filter((file) => file.exists && file.error !== undefined).length;
}

function summary(report: ProtectReport): string[] {
  const servers = report.servers;
  const count = (test: (server: ServerReport) => boolean) => servers.filter(test).length;
  const many = (number: number, one: string, more: string) => `${number} ${number === 1 ? one : more}`;
  const present = report.files.filter((file) => file.exists).length;
  const unchecked = uncheckedFiles(report);
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
    ...(unchecked > 0 ? [`  ${many(unchecked, "configuration file", "configuration files")} could not be checked.`] : []),
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
  command: McpcageCommand;
  claudeCodeRunning: boolean;
  /** Plan and log the same changes without writing anything. */
  dryRun: boolean;
  log: (line: string) => void;
  /** Shown as ~ in messages (default: the user's home directory). */
  home?: string;
  /** `--writable`: mount the paths of the servers it cages writable, as wrapEntry does with it. */
  writable?: boolean;
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
    // A program that is only named mcpcage gets the rewrite an npx entry gets; a caged entry whose
    // env or envFile acts on the host gets what can be moved moved, and the check of the result.
    const targets = servers.filter(
      (server) =>
        server.type === "npx" ||
        (server.type === "mcpcage" && (server.mcpcage === "other program" || (server.protectedByMcpcage && server.error === undefined && (actsOnHost(server) || envFileActs(server))))),
    );
    // Already wrapped, so there is nothing to rewrite: only the person who chose --no-sandbox can drop it.
    const onHost = servers.filter((server) => server.type === "mcpcage" && server.mcpcage === "installed" && !server.protectedByMcpcage && server.error === undefined);
    if (targets.length === 0 && onHost.length === 0) continue;
    try {
      files.push(fixFile(file, targets, onHost, options, home));
    } catch (error) {
      // One file that cannot be rewritten leaves the others to be.
      const fixed: FixedFile = { file: file.file, changed: [], skipped: [], refused: messageOf(error) };
      options.log(`  not changed: ${shownFile(file, home)}: ${terminalSafe(fixed.refused!)}`);
      files.push(fixed);
    }
  }
  return { files };
}

function fixFile(file: ScannedFile, targets: ServerReport[], onHost: ServerReport[], options: FixOptions, home: string): FixedFile {
  const fixed: FixedFile = { file: file.file, changed: [], skipped: [] };
  const shown = shownFile(file, home);
  const where = (label: string | undefined) => (label === undefined ? shown : `${shown} (project ${terminalSafe(label)})`);

  let bytes: Buffer;
  let config: Record<string, unknown>;
  try {
    bytes = readConfigFile(file.file);
    config = parseConfig(bytes.toString("utf8"));
  } catch (error) {
    fixed.refused = `could not read it again: ${(error as Error).message}`;
    options.log(`  not changed: ${shown}: ${terminalSafe(fixed.refused)}`);
    return fixed;
  }
  const text = bytes.toString("utf8");

  // The variables each rewrite takes out of an entry's env, which a rewrite by hand must take out too.
  const removed = new Map<ServerEntry, string[]>();
  for (const server of targets) {
    const servers = valueAt(config, server.label === undefined ? [file.key] : ["projects", server.label, "mcpServers"]);
    const entry = isJsonObject(servers) && Object.hasOwn(servers, server.name) ? servers[server.name] : undefined;
    const wrapped = !isJsonObject(servers) || !isJsonObject(entry) ? { skip: "it is no longer in the file" } : rewrite(entry as ServerEntry, options.command, options.writable === true, file.file);
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
  for (const skipped of fixed.skipped) options.log(`  not changed: ${terminalSafe(skipped.name)} in ${where(skipped.label)}: ${terminalSafe(skipped.reason)}`);
  if (fixed.changed.length === 0) return fixed;

  // Said with the plan, before the question, for each mount --writable made writable. An entry that was
  // caged already keeps the mounts it had, which the report names.
  const warnings = (change: FixedFile["changed"][number]) => (options.writable && !change.envOnly ? writableMounts(change.after).map((path) => writableWarning(change.name, path)) : []);
  // When the file cannot be rewritten, the exact command each server should run instead.
  const byHand = fixed.changed.flatMap((change) => {
    const line = `    ${terminalSafe(change.name)}${change.label === undefined ? "" : ` (project ${terminalSafe(change.label)})`}: ${terminalSafe(shownCommand(change.after, "mcpcage").line)}`;
    const names = removed.get(change.after) ?? [];
    return [line, ...(names.length === 0 ? [] : [`      and remove from its "env": ${names.map(terminalSafe).join(", ")}`]), ...warnings(change).map((warning) => `      ${warning}`)];
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
  for (const change of fixed.changed) {
    options.log(`  ${options.dryRun ? "cage" : "caged"} ${terminalSafe(change.name)} in ${where(change.label)}`);
    for (const warning of warnings(change)) options.log(`    ${warning}`);
    const note = envFileNote(change.after);
    if (note !== undefined) options.log(`    ${note}`);
  }
  if (fixed.backup) options.log(`  backup: ${terminalSafe(file.scope === "user" ? tilde(fixed.backup, home) : fixed.backup)}`);
  return fixed;
}

/**
 * An npx entry wrapped, a caged entry with its env moved off the host, or the npx command a program
 * only named mcpcage would start, wrapped as wrap would have wrapped it; or why it stays as it is.
 * What the command is, is looked at again: the file may have changed since the scan. The result is
 * checked as the report will check it (see cageCheck): one that would still not count as caged,
 * because of a PATH, a client place or an envFile that only the user can change, stays as it is,
 * with what to do, instead of being called caged.
 */
function rewrite(entry: ServerEntry, command: McpcageCommand, writable: boolean, configFile: string): { entry: ServerEntry; envOnly?: boolean } | { skip: string } {
  const rewritten = rewriteEntry(entry, command, writable);
  if ("skip" in rewritten) return rewritten;
  const reason = cageCheck(rewritten.entry, { command, configFile });
  if (reason !== undefined) return { skip: reason };
  return rewritten.entry === entry ? { skip: "its env no longer runs on your machine" } : rewritten;
}

function rewriteEntry(entry: ServerEntry, command: McpcageCommand, writable: boolean): { entry: ServerEntry; envOnly?: boolean } | { skip: string } {
  if (serverType(entry) !== "mcpcage") return wrapEntry(entry, { command, writable });
  const found = mcpcageAt(entry as ServerEntry & { command: string }, command);
  if (found === "other program") {
    const inner = unwrapEntry(entry);
    return "skip" in inner ? inner : wrapEntry(inner.entry, { command, writable });
  }
  if (found === "not found") return { skip: "its mcpcage can no longer be found" };
  // Nothing to move: the entry as it is, which the check says what to do about.
  const moved = moveHostEnv(entry);
  return moved === undefined ? { entry } : "skip" in moved ? moved : { entry: moved.entry, envOnly: true };
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
// Query parameters that carry a credential under a name SECRET_NAME does not know: the signature of
// an Azure SAS (sig), an Azure Functions key (code), the signature of a presigned AWS or Google
// address. A SAS address printed its sig in clear. Whole names only: "decode" and "encoding" are not.
const SECRET_QUERY = /^(?:sig|signature|code|sas|x-amz-signature|x-goog-signature)$/i;
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
  // The path of a key file is not the key, written from a variable too: ${workspaceFolder}/key.json.
  if (/^(?:~|\/|[A-Za-z]:[\\/]|\$\{[^}]*\}[\\/]|\$[A-Za-z_]\w*[\\/]|%[A-Za-z_]\w*%[\\/])/.test(text)) return false;
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || maskUrl(text).hidden.length > 0;
}

// ${VAR}, VS Code's ${env:VAR} and ${input:id}, and <your token>, alone or with only separators
// between them (<user>:<password>).
const FILLED_IN = /^(?:\$\{[^}]*\}|<[^<>]*>)(?:[\s:@\/._-]*(?:\$\{[^}]*\}|<[^<>]*>))*$/;

/**
 * A value that stands for one the client fills in or the user writes later: only when it is one
 * whole, after an auth scheme at most (`Bearer ${input:token}`). Anywhere in the value, "xxx" made
 * `--api-key sk-live-xxx-0123456789` a placeholder, and then "changeme", "<...>" and "${...}" did the
 * same for `sk-live-changeme-0123456789`: printed in clear, and left out of the count. A value that
 * is not surely a placeholder is taken for a secret, and masked.
 */
function isPlaceholder(text: string): boolean {
  const value = text.replace(/^(?:bearer|basic|token|bot)\s+/i, "");
  return (
    FILLED_IN.test(value) ||
    /^your_[a-z_-]*$/i.test(value) || // YOUR_API_KEY, your_token_here
    // xxxxxxxx, sk-xxxx, ghp_XXXXXXXX, ****, after a short prefix.
    /^(?:[a-z0-9]{1,8}[-_]){0,3}[x*.-]{3,}$/i.test(value) ||
    /^change[\s_-]?me(?:[\s_-]+[a-z]+)*$/i.test(value) || // changeme, CHANGE_ME, changeme-please
    /^todo(?:[\s:.,-]+[a-z]+)*[\s:.!-]*$/i.test(value) || // TODO, TODO: fill in
    /^\$[A-Za-z_]\w*$/.test(value) || // $GITHUB_TOKEN
    /^%[A-Za-z_]\w*%$/.test(value) // %GITHUB_TOKEN%
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
 * addresses, masked (see maskArg), in the server's arguments of a wrapped entry too. In a wrapped
 * entry, every `--env NAME=value` of mcpcage's own is masked: it is a value of the env, moved there
 * by `wrap`, and it counts as a secret when it looks like one.
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
    const masked = maskArg(arg);
    if (masked) {
      shown[index] = masked.shown;
      secrets.push(...masked.secrets);
      hidden.push(...masked.hidden);
    }
  }
  return { shown, secrets, hidden };
}

/**
 * One argument with its credentials masked, or undefined when it holds none: an address wherever it
 * is, whole or as the value of an option or variable of any name, and the value of `--token=...`,
 * `API_KEY=...` or `Authorization: Bearer ...` by its name. `--url=https://user:pass@...` was printed
 * whole: only an argument that starts with a scheme was read as an address. The value of an option
 * is read once more as an argument of its own, for `--header=Authorization: Bearer ...`.
 */
function maskArg(arg: string, nested = false): { shown: string; secrets: string[]; hidden: string[] } | undefined {
  const url = maskUrl(arg);
  if (url.hidden.length > 0) return { shown: url.shown, secrets: ["url"], hidden: url.hidden };
  const pair = /^(--?[\w.-]+|[A-Za-z_][\w.-]*)(=|:[ \t]*)(.+)$/.exec(arg);
  if (!pair) return undefined;
  const name = pair[1]!;
  const separator = pair[2]!;
  const value = pair[3]!;
  if (SECRET_NAME.test(name) && looksLikeSecret(value)) return { shown: `${name}${separator}${MASK}`, secrets: [name], hidden: [value] };
  const inner = nested ? undefined : maskArg(value, true);
  return inner && { ...inner, shown: `${name}${separator}${inner.shown}` };
}

/**
 * An address with its credentials masked: the password, a user name that is really a token
 * (https://ghp_...@github.com, https://ghp_...:x-oauth-basic@github.com), and query values with a credential name (SECRET_NAME or
 * SECRET_QUERY). `root@localhost` stays.
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
  }
  // A token as the user name, with a password after it or not: GitHub's own form is
  // https://ghp_...:x-oauth-basic@github.com, which printed the token and masked x-oauth-basic.
  if (looksLikeSecret(username)) {
    hidden.push(username, url.username);
    url.username = MASK;
  }
  // Every value of every name, in their order: `?token=short&token=sk-live-...` printed the second
  // token in clear, because only the first value of each name was looked at.
  let masked = false;
  const query = [...url.searchParams].map(([name, value]): [string, string] => {
    if (!(SECRET_NAME.test(name) || SECRET_QUERY.test(name)) || !looksLikeSecret(value)) return [name, value];
    hidden.push(value);
    masked = true;
    return [name, MASK];
  });
  if (masked) url.search = new URLSearchParams(query).toString();
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
 * directory written like C:\Users\me means Windows paths. This machine's PATH, the account's own
 * home directory (which counts whatever HOME says) and the client configurations where this
 * environment puts them count only for paths of this machine's kind: they are written in that
 * syntax. Without the client places, a configuration under COPILOT_HOME had no access line in the
 * report, though wrap, run and the inspection refuse to mount it.
 */
export function broadAccessKind(path: string, home: string): string | undefined {
  const platform = /^[A-Za-z]:/.test(home) ? "win32" : process.platform === "win32" ? "linux" : process.platform;
  const here = platform === process.platform;
  return sensitivePath(expandHome(path, home), {
    home,
    account: here ? accountHome() : undefined,
    platform,
    cage: cageHome(),
    path: here ? process.env.PATH : undefined,
    clients: here ? clientPlaces({ platform, home, env: process.env }) : undefined,
  });
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
  return npxArgv(inner) === undefined ? undefined : inner;
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

/** The arguments of a wrapped entry from `run` on, those that are strings (see mcpcageArgs); all of them for another entry. */
function fromRun(entry: ServerEntry): string[] {
  return isWrapped(entry) ? stringArgs({ args: mcpcageArgs(entry) } as ServerEntry) : stringArgs(entry);
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

/** Runs of this many characters of a credential are hidden wherever they appear: see redactor. */
const RUN = 8;
/** The characters of credentials whose runs are looked for; past them, a value is hidden whole only. */
const MAX_RUN_CHARS = 256 * 1024;
// What shows nothing, or nothing of its own: controls, format and unassigned characters, line
// separators, variation selectors and the other default-ignorable characters.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]+/gu;
const HAS_UNSEEN = new RegExp(UNSEEN.source, "u");
// Of those, the ones the signs of hidden text are made of: invisible-chars, unicode-tags,
// bidi-control and variation-selectors in suspicious.ts.
const SIGN_CHARS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// The rolling hash of a run of RUN characters, modulo 2^32: BASE, and BASE to the power RUN.
const BASE = 0x01000193;
const BASE_TO_RUN = Array.from({ length: RUN }).reduce<number>((power) => Math.imul(power, BASE), 1);
/** The bits of a hash its first look reads (see redactor): 2^HASH_BITS bits, 128 KiB. */
const HASH_BITS = 20;

/**
 * Hides `values` in a text a server wrote, for a report meant to be shared. Each value is hidden
 * whole, from 4 characters (shorter ones would hide ordinary words), and so is every run of RUN
 * characters of a credential (see credentialParts). With whole values only, a server given
 * GITHUB_TOKEN that wrote it with U+200B in the middle, or its first half in one address and the
 * second in another, had it printed: a reader deletes the [U+200B] or joins the halves. Both are
 * looked for in the text without the characters that show nothing, and those a sign is made of
 * (U+200B is one) are put back after the mask, so that hiding a value never hides a sign from the
 * scan. Linear in the text: a rolling hash finds the places where a run may start, and only those
 * are compared. With `from`, only the text from there on is returned (see Redact in inspect.ts).
 */
function redactor(values: string[]): Redact {
  const whole = new Set<string>();
  const runs = new Set<string>();
  let budget = MAX_RUN_CHARS;
  for (const value of values) {
    const seen = value.replace(UNSEEN, "");
    let covered = false;
    for (const part of credentialParts(value)) {
      const text = part.replace(UNSEEN, "");
      if (text.length < RUN || text.length > budget) {
        // The password of an address, say: hidden whole, as the address is.
        if (text.length >= 4) whole.add(text);
        continue;
      }
      budget -= text.length;
      for (let at = 0; at + RUN <= text.length; at++) runs.add(text.slice(at, at + RUN));
      // Wherever the value is, its runs are: no need to look for it whole.
      if (text === seen) covered = true;
    }
    if (seen.length >= 4 && !covered) whole.add(seen);
  }
  const hashes = new Set([...runs].map(hashOf));
  // A first look before the set, one bit per hash prefix: most places in a text match no run.
  const likely = new Int32Array(1 << (HASH_BITS - 5));
  for (const hash of hashes) likely[hash >>> (32 - HASH_BITS + 5)]! |= 1 << ((hash >>> (32 - HASH_BITS)) & 31);
  // Not Math.min(...whole): an entry with a few hundred thousand variables would overflow the stack.
  let shortest = runs.size > 0 ? RUN : Infinity;
  for (const value of whole) shortest = Math.min(shortest, value.length);
  return (text, from = 0) => {
    if (text.length < shortest) return text.slice(from);
    // The text as it reads, and where each of its pieces starts there and in `text`.
    const pieces: Array<[number, number]> = [[0, 0]];
    let seen = text;
    if (HAS_UNSEEN.test(text)) {
      pieces.length = 0;
      seen = "";
      let last = 0;
      for (const match of text.matchAll(UNSEEN)) {
        if (match.index > last) pieces.push([seen.length, last]);
        seen += text.slice(last, match.index);
        last = match.index + match[0].length;
      }
      if (last < text.length) pieces.push([seen.length, last]);
      seen += text.slice(last);
    }
    // reach[at]: where the longest stretch to hide that starts at `at` ends, 0 for none.
    let reach: Int32Array | undefined;
    const hide = (start: number, end: number) => {
      reach ??= new Int32Array(seen.length);
      if (end > reach[start]!) reach[start] = end;
    };
    for (const value of whole) for (let at = seen.indexOf(value); at !== -1; at = seen.indexOf(value, at + 1)) hide(at, at + value.length);
    if (runs.size > 0) {
      let hash = 0;
      for (let at = 0; at < seen.length; at++) {
        hash = (Math.imul(hash, BASE) + seen.charCodeAt(at)) | 0;
        if (at >= RUN) hash = (hash - Math.imul(seen.charCodeAt(at - RUN), BASE_TO_RUN)) | 0;
        if (at < RUN - 1 || !((likely[hash >>> (32 - HASH_BITS + 5)]! >>> ((hash >>> (32 - HASH_BITS)) & 31)) & 1)) continue;
        if (hashes.has(hash) && runs.has(seen.slice(at + 1 - RUN, at + 1))) hide(at + 1 - RUN, at + 1);
      }
    }
    if (reach === undefined) return text.slice(from);
    const marks = reach;
    // Each stretch, with those it overlaps, replaced in `text` by the mask and the sign characters in it.
    let piece = 0;
    const inText = (at: number) => {
      while (piece + 1 < pieces.length && pieces[piece + 1]![0] <= at) piece++;
      return pieces[piece]![1] + at - pieces[piece]![0];
    };
    let shown = "";
    let done = from;
    for (let at = 0; at < seen.length; ) {
      let end = marks[at]!;
      if (end === 0) {
        at++;
        continue;
      }
      for (let next = at + 1; next < end; next++) end = Math.max(end, marks[next]!);
      let start = inText(at);
      let stop = inText(end - 1) + 1;
      // The two halves of a surrogate pair are one character: hidden together.
      if (start > done && isLowSurrogate(text, start) && isHighSurrogate(text, start - 1)) start--;
      if (isLowSurrogate(text, stop) && isHighSurrogate(text, stop - 1)) stop++;
      at = end;
      // Before `from`, nothing is shown; a stretch across it is shown as the mask.
      if (stop <= from) continue;
      shown += `${text.slice(done, Math.max(start, done))}${MASK}${text.slice(Math.max(start, from), stop).match(SIGN_CHARS)?.join("") ?? ""}`;
      done = stop;
    }
    return shown + text.slice(done);
  };
}

/**
 * The parts of a value whose runs are hidden (see redactor): the value when it looks like a
 * credential, the credentials in an address. A path, a number, a plain address or a placeholder is
 * hidden whole only: its runs ("https://", "/.ssh/id_") are the very text the scan looks for, and a
 * server given SSH_KEY_PATH would have had "~/.ssh/id_rsa" hidden from the scan in its tools.
 */
function credentialParts(value: string): string[] {
  const text = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return maskUrl(text).hidden;
  return looksLikeSecret(text) ? [text] : [];
}

function hashOf(run: string): number {
  let hash = 0;
  for (let at = 0; at < run.length; at++) hash = (Math.imul(hash, BASE) + run.charCodeAt(at)) | 0;
  return hash;
}

function isHighSurrogate(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff;
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
  return terminalSafe(file.scope === "user" ? tilde(file.file, home) : file.file);
}

/** A path under the home directory, written from ~. */
function tilde(path: string, home: string): string {
  const root = home.replace(/[\\/]+$/, "");
  if (root === "" || !path.startsWith(root)) return path;
  const rest = path.slice(root.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}
