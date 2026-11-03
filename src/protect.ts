import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { claudeCodeSections, type ClientId, type ConfigLocation } from "./clients.js";
import { hostPath, isWrapped, serverType, wrapEntry, type ServerEntry, type ServerType } from "./config.js";
import { hasComments, isJsonObject, parseJsonc } from "./jsonc.js";
import { parseLaunch, serverIdFor } from "./launch.js";
import type { ToolDefinition } from "./manifest.js";
import { installScripts, type InstallScripts, type NpmRunner } from "./npm-scripts.js";
import { parseMount, type SandboxOptions } from "./sandbox.js";
import { describeFindings, highSeveritySigns, scanTool, type Finding } from "./suspicious.js";

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
  /** Started through `mcpcage run` with its sandbox: false for `mcpcage run --no-sandbox`, which runs on the host. */
  protectedByMcpcage: boolean;
  /** Names of the env variables, headers and arguments whose value looks like a secret. */
  secrets: string[];
  /** Arguments and --mount paths, as written, that expose the whole home directory or the whole disk. */
  broadAccess: string[];
  installScripts?: InstallScripts;
  inspection?: { tools: number; findings: Finding[]; error?: string };
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
  const shown = shownCommand(entry, type);
  const server: ServerReport = {
    client: file.client,
    clientName: file.clientName,
    file: file.file,
    scope: file.scope,
    label: project,
    name,
    type,
    command: shown.line,
    protectedByMcpcage: isWrapped(entry) && !withoutSandbox(entry),
    secrets: [...new Set([...secretNames(entry), ...shown.secrets])],
    broadAccess: type === "remote" ? [] : broadPaths(stringArgs(entry), options.home),
  };
  const launch = npxCommand(entry, type);
  const npm = launch ? npmPackage(launch) : undefined;
  if (npm) server.packageSpec = npm.local ? `local package ${npm.spec}` : npm.spec;
  // Install scripts matter where they would run: an npx server outside the cage.
  if (isUncaged(server) && npm && !npm.local) {
    let lookup = lookups.get(npm.spec);
    if (!lookup) {
      lookup = installScripts(npm.spec, { offline: options.offline, cacheDir: options.cacheDir, runner: options.npmRunner });
      lookups.set(npm.spec, lookup);
    }
    server.installScripts = lookup;
  }
  if (options.inspect && launch) server.inspection = await inspectServer(options.inspect, launch, entry, shown.hidden);
  return server;
}

async function inspectServer(inspect: Inspector, argv: string[], entry: ServerEntry, hidden: string[]): Promise<NonNullable<ServerReport["inspection"]>> {
  const env = stringValues(entry.env);
  try {
    const tools = await inspect({ argv, env });
    return { tools: tools.length, findings: findingsIn(tools) };
  } catch (error) {
    // The server's own error output may repeat a value it was given: no value reaches the report.
    return { tools: 0, findings: [], error: hideValues(oneLine((error as Error).message), [...Object.values(env), ...hidden]) };
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
 * (server-filesystem) check their directories at start. Nothing in the cage is writable.
 */
export function inspectionSandbox(launch: { argv: string[]; env: Record<string, string> }): Omit<SandboxOptions, "log"> {
  const spec = parseLaunch(launch.argv);
  if (spec.kind !== "npm") throw new Error("only npx servers can be inspected");
  const paths = spec.args.map((arg) => hostPath(arg));
  const caged = { ...spec, args: spec.args.map((arg, index) => paths[index] ?? arg) };
  return {
    // The id `mcpcage run` gives the entry once caged, so the image built now is the one it reuses.
    serverId: serverIdFor(caged),
    spec: caged,
    mounts: [...new Set(paths.filter((path): path is string => path !== undefined))].map((path) => parseMount(path)),
    // The values reach only the container, which has no network; they are never printed.
    env: Object.entries(launch.env).map(([name, value]) => `${name}=${value}`),
    allowNet: false,
    memory: "512m",
    cpus: "1",
    keepImageUser: false,
    rebuild: false,
  };
}

/** A server that runs on this machine with the user's permissions: npx outside mcpcage, or `mcpcage run --no-sandbox`. */
export function isUncaged(server: ServerReport): boolean {
  return server.type === "npx" || (server.type === "mcpcage" && !server.protectedByMcpcage);
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
  const details: string[] = [];
  for (const path of server.broadAccess) details.push(`access: ${printable(path)} (${broadAccessKind(path, home) ?? "a broad path"})`);
  if (server.secrets.length > 0) details.push(`${server.secrets.length === 1 ? "secret" : "secrets"} in clear text: ${server.secrets.map(printable).join(", ")}`);
  if (server.installScripts) details.push(installLine(server.installScripts));
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
  switch (server.type) {
    case "npx":
      return "NOT CAGED";
    case "mcpcage":
      return server.protectedByMcpcage ? "caged" : "mcpcage --no-sandbox: pinning and audit only, no isolation";
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
  const caged = count((server) => server.type === "mcpcage" && server.protectedByMcpcage);
  const scripts = count((server) => server.installScripts?.status === "found");
  const run = `  ${many(uncaged, "runs", "run")} on your machine with your permissions and no cage.`;
  const lines = [
    `  ${many(servers.length, "server", "servers")} in ${many(present, "configuration file", "configuration files")} (${many(report.files.length, "file", "files")} checked, ${report.files.length - present} absent).`,
    uncaged > 0 ? `${run.padEnd(68)}-> mcpcage protect --fix` : run,
    `  ${many(count((server) => server.secrets.length > 0), "keeps", "keep")} a secret in clear text in a configuration file.`,
    `  ${count((server) => server.broadAccess.length > 0)} can reach your whole home directory or more.`,
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
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The rewrite.

export interface FixedFile {
  file: string;
  changed: Array<{ name: string; label?: string; after: ServerEntry }>;
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
 * Rewrites the report's npx servers to start through `mcpcage run`, file by file. Each file is read
 * again right before it changes; only its server entries change, in the file's own style, with a
 * backup next to it and an atomic replace.
 */
export function fixConfigs(options: FixOptions): FixOutcome {
  const home = options.home ?? homedir();
  const files: FixedFile[] = [];
  for (const file of options.report.files) {
    if (!file.exists || file.error !== undefined) continue;
    const servers = options.report.servers.filter((server) => server.file === file.file);
    const targets = servers.filter((server) => server.type === "npx");
    // Already wrapped, so there is nothing to rewrite: only the person who chose --no-sandbox can drop it.
    const onHost = servers.filter((server) => server.type === "mcpcage" && !server.protectedByMcpcage);
    if (targets.length > 0 || onHost.length > 0) files.push(fixFile(file, targets, onHost, options, home));
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
    bytes = readFileSync(file.file);
    config = parseConfig(bytes.toString("utf8"));
  } catch (error) {
    fixed.refused = `could not read it again: ${(error as Error).message}`;
    options.log(`  not changed: ${shown}: ${printable(fixed.refused)}`);
    return fixed;
  }
  const text = bytes.toString("utf8");

  for (const server of targets) {
    const servers = valueAt(config, server.label === undefined ? [file.key] : ["projects", server.label, "mcpServers"]);
    const entry = isJsonObject(servers) && Object.hasOwn(servers, server.name) ? servers[server.name] : undefined;
    const wrapped = isJsonObject(servers) && isJsonObject(entry) ? wrapEntry(entry as ServerEntry, { command: options.command }) : { skip: "it is no longer in the file" };
    if ("skip" in wrapped) {
      fixed.skipped.push({ name: server.name, label: server.label, reason: wrapped.skip });
      continue;
    }
    (servers as Record<string, unknown>)[server.name] = wrapped.entry;
    fixed.changed.push({ name: server.name, label: server.label, after: wrapped.entry });
  }
  for (const server of onHost) {
    fixed.skipped.push({ name: server.name, label: server.label, reason: "it runs with --no-sandbox, without isolation; remove --no-sandbox from its arguments by hand" });
  }
  for (const skipped of fixed.skipped) options.log(`  not changed: ${printable(skipped.name)} in ${where(skipped.label)}: ${printable(skipped.reason)}`);
  if (fixed.changed.length === 0) return fixed;

  // When the file cannot be rewritten, the exact command each server should run instead.
  const byHand = fixed.changed.map(
    (change) => `    ${printable(change.name)}${change.label === undefined ? "" : ` (project ${printable(change.label)})`}: ${printable(shownCommand(change.after, "mcpcage").line)}`,
  );
  if (byHand.some((line) => line.includes(MASK))) byHand.push(`    (${MASK} stands for the value already in the file, which is not shown)`);
  if (hasComments(text)) {
    fixed.refused = "it has comments";
    fixed.changed = [];
    options.log(`  not changed: ${shown} has comments, which rewriting it would lose. Edit it by hand so that each server runs the command shown ("command" is its first word, "args" the rest):`);
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
 * A backup of the bytes that were read, then the new text through a temporary file in the same
 * directory and a rename, so a client never reads half a file. The file keeps its permissions, and
 * a symlinked configuration (dotfiles) keeps its link: the file it points to is the one replaced.
 */
function replaceFile(file: string, original: Buffer, text: string): string {
  const target = realpathSync(file);
  const mode = statSync(target).mode & 0o777;
  let backup = `${file}.mcpcage.bak`;
  if (existsSync(backup)) backup = `${file}.mcpcage.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  writeFileSync(backup, original, { flag: "wx", mode });
  chmodSync(backup, mode);
  const temporary = join(dirname(target), `.${basename(target)}.mcpcage-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return backup;
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
    const masked = maskUrl(String(entry[field] ?? ""));
    return { line: masked.shown || `(${String(entry.type)} server)`, secrets: masked.hidden.length > 0 ? [field] : [], hidden: masked.hidden };
  }
  if (typeof entry.command !== "string" || entry.command === "") return { line: NO_COMMAND, secrets: [], hidden: [] };
  const masked = maskArgs(stringArgs(entry));
  return { line: [entry.command, ...masked.shown].map((part) => (part === "" || /\s/.test(part) ? `"${part}"` : part)).join(" "), ...masked };
}

/** `--api-key sk-...`, `--token=...`, `API_KEY=...`, `Authorization: Bearer ...` and credentials in addresses, masked. */
function maskArgs(args: string[]): { shown: string[]; secrets: string[]; hidden: string[] } {
  const shown = [...args];
  const secrets: string[] = [];
  const hidden: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
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
const ALL_HOMES = new Set(["/Users", "/home", "c:\\users"]);

/** Paths that open the whole home directory or more: the --mount values of a wrapped entry count too. */
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

/** Plain words for a path that opens the whole home directory or more; undefined for a narrower one. */
export function broadAccessKind(path: string, home: string): string | undefined {
  const target = normalizePath(expandHome(path, home));
  const own = normalizePath(home);
  if (target === undefined || own === undefined) return undefined;
  if (target === "/" || /^[a-z]:\\$/.test(target)) return "the whole disk";
  if (target === own) return "your whole home directory";
  if (ALL_HOMES.has(target) || own.startsWith(target.endsWith("\\") ? target : `${target}${target.includes("\\") ? "\\" : "/"}`)) {
    return "your whole home directory and more";
  }
  if (target === "/root") return "the home directory of the root user";
  return undefined;
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
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`could not read it (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
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

function stringArgs(entry: ServerEntry): string[] {
  return Array.isArray(entry.args) ? entry.args.map((arg) => String(arg)) : [];
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

/** The program's file name, from the first word of a command line (quoted when it has spaces). */
function programOf(line: string): string {
  const first = line.startsWith('"') ? (/^"([^"]*)"/.exec(line)?.[1] ?? line) : (line.split(" ")[0] ?? line);
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
