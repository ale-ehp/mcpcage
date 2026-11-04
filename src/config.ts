import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import { isJsonObject } from "./jsonc.js";
import { parseLaunch } from "./launch.js";
import { sensitivePath, thisMachine } from "./sensitive.js";
import { terminalSafe } from "./terminal.js";

/** One MCP server entry, as Claude Desktop, Claude Code, Cursor, VS Code, Copilot, Windsurf and Devin store it. */
export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  type?: string;
  headers?: Record<string, string>;
  [field: string]: unknown;
}

/**
 * The options of `mcpcage run` and `mcpcage prepare`, before `--`. `protect` reads a wrapped entry's
 * arguments with the same definitions, so that it finds the options that open a cage as `run` does.
 */
export const RUN_OPTIONS = {
  mount: { type: "string", multiple: true, default: [] as string[] },
  "allow-sensitive-mount": { type: "boolean", default: false },
  env: { type: "string", multiple: true, default: [] as string[] },
  "allow-net": { type: "boolean", default: false },
  "allow-server-requests": { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  id: { type: "string" },
  image: { type: "string" },
  memory: { type: "string", default: "512m" },
  cpus: { type: "string", default: "1" },
  "keep-image-user": { type: "boolean", default: false },
  rebuild: { type: "boolean", default: false },
  "no-sandbox": { type: "boolean", default: false },
} satisfies ParseArgsOptionsConfig;

/** What starts a server, which decides whether mcpcage can cage it. */
export type ServerType = "npx" | "uvx" | "docker" | "remote" | "mcpcage" | "other";

const REMOTE_TYPES = new Set(["http", "sse", "ws", "streamable-http"]);

export interface WrapOutcome {
  file: string;
  /** `mcpServers` (Claude Desktop, Claude Code, Cursor) or `servers` (VS Code). */
  key: "mcpServers" | "servers";
  changed: Array<{ name: string; before: ServerEntry; after: ServerEntry }>;
  skipped: Array<{ name: string; reason: string }>;
  backup?: string;
}

/** Rewrites every npx-launched stdio server so the client starts it through `mcpcage run`. */
export function wrapConfig(file: string, options: { dryRun: boolean; command?: string }): WrapOutcome {
  const command = options.command ?? "mcpcage";
  return transform(file, options.dryRun, (name, entry, skip) => {
    const wrapped = wrapEntry(entry, { command });
    return "skip" in wrapped ? skip(name, wrapped.skip) : wrapped.entry;
  });
}

/**
 * Variables of a server entry's `env` that act on the host once the entry starts mcpcage. A client
 * starts an entry's command with the entry's `env` added to its environment: after `wrap` that
 * command is mcpcage, so the `env` configures mcpcage's own process on the host, and the node,
 * docker and npm it starts there, before any cage exists. `container` variables were written for the
 * server, which keeps them: they become `--env NAME=value` arguments, whose value reaches the
 * container only, and leave `env`. `drop` variables are not passed at all. Names are compared
 * without case, as Windows compares them.
 */
export const HOST_ENV: ReadonlyArray<{ name: RegExp; to: "container" | "drop"; what: (name: string) => string }> = [
  // Node reads them when it starts mcpcage: NODE_OPTIONS can preload a module (--import, --require)
  // that runs on the host before mcpcage has read its first argument, and Node keeps adding more.
  // NODE_ENV is the exception (see hostVariable).
  { name: /^NODE_/i, to: "container", what: () => "can make Node run code on your machine before the cage starts" },
  // The dynamic loaders of Linux and macOS read them in every program started on the host, node and
  // docker included: LD_PRELOAD and DYLD_INSERT_LIBRARIES load a library of their choice into each.
  { name: /^LD_/i, to: "container", what: () => "can load code into mcpcage on your machine before the cage starts" },
  { name: /^DYLD_/i, to: "container", what: () => "can load code into mcpcage on your machine before the cage starts" },
  // OpenSSL reads them in every program that loads it, Node included, which does so as it starts
  // mcpcage: OPENSSL_CONF can name a provider or an engine to load, a shared library whose code runs
  // on the host before mcpcage has read its first argument, and OPENSSL_MODULES and OPENSSL_ENGINES
  // choose the directory it is loaded from. The others only tune OpenSSL; they move too, because on
  // the host they would tune mcpcage's, which they were not written for.
  {
    name: /^OPENSSL_/i,
    to: "container",
    what: (name) =>
      /^OPENSSL_(CONF|CONF_INCLUDE|MODULES|ENGINES)$/i.test(name)
        ? "can make OpenSSL load code into mcpcage on your machine before the cage starts"
        : "configures OpenSSL in mcpcage on your machine",
  },
  // glibc loads the character set converters of iconv from GCONV_PATH, as shared libraries, in any
  // program on the host that converts text with it.
  { name: /^GCONV_PATH$/i, to: "container", what: () => "can load code into mcpcage on your machine before the cage starts" },
  // The docker command mcpcage runs reads them: DOCKER_HOST and DOCKER_CONTEXT send the build and the
  // run, with the value of every --env, to another daemon; DOCKER_CONFIG chooses its plugins and
  // credential helpers. A DOCKER_HOST of unix:// or npipe:// only names a local socket (see hostVariable).
  {
    name: /^DOCKER_/i,
    to: "container",
    what: (name) => `${/^DOCKER_(HOST|CONTEXT)$/i.test(name) ? "chooses" : "configures"} the Docker that builds and runs the cage`,
  },
  // npm reads them, in both spellings, when mcpcage runs it on the host to pack a local package.
  { name: /^npm_config_/i, to: "container", what: () => "configures npm, which mcpcage runs on your machine" },
  // The cage sets its own HOME, and the home directory is where the sensitive places are looked for:
  // pointed at an empty directory, it would make ~/.ssh an ordinary path for mcpcage.
  { name: /^(HOME|USERPROFILE)$/i, to: "drop", what: () => "changes the home directory mcpcage protects" },
  // mcpcage's store is the user's choice, not a server's: pointed at an empty store, trust on first
  // use approves whatever the server lists, and the audit log lands where `audit` never looks.
  { name: /^MCPCAGE_HOME$/i, to: "drop", what: () => "moves mcpcage's pins and audit log, so approvals start over" },
];

/** What a variable of an entry's `env` would do on the host once the entry starts mcpcage, or undefined for one meant only for the server. */
export function hostVariable(name: string, value: unknown): { to: "container" | "drop"; what: string } | undefined {
  // A local socket, the usual way to reach Docker: it chooses no other daemon than the user's own.
  if (/^DOCKER_HOST$/i.test(name) && typeof value === "string" && /^(?:unix|npipe):\/\//i.test(value)) return undefined;
  // Node never reads NODE_ENV: it is the application's own setting, which many servers are given
  // (NODE_ENV=production), so it stays an ordinary variable instead of a false alarm on each of them.
  if (/^NODE_ENV$/i.test(name)) return undefined;
  const rule = HOST_ENV.find((candidate) => candidate.name.test(name));
  return rule === undefined ? undefined : { to: rule.to, what: rule.what(name) };
}

/**
 * One entry rewritten to start through `mcpcage run`, or why it cannot be. Environment variables
 * become explicit `--env NAME` flags, because nothing from the host reaches the container unless it
 * is named, and stay in `env`, so their values (credentials, often) never appear in the arguments.
 * Those that would act on the host (HOST_ENV) leave `env`: into the cage as `--env NAME=value`, or
 * not at all. A path the server is given and that exists here becomes a writable mount at the same
 * path, because the server is expected to work there: a filesystem server pointed at ~/notes would
 * otherwise find nothing inside the cage. Every other path, and the network, stay closed.
 * A `~/` argument becomes the absolute path that is mounted: inside the cage HOME is /tmp, so a
 * server that expands `~` itself would look in /tmp. A server given the whole disk, the home
 * directory or a directory with credentials (see sensitive.ts) is not caged at all: that mount would
 * undo the cage, so the entry stays as it is and the reason is given.
 */
export function wrapEntry(entry: ServerEntry, options: { command: string }): { entry: ServerEntry } | { skip: string } {
  const type = serverType(entry);
  if (type === "remote") return { skip: "remote server: nothing runs locally to cage" };
  if (!entry.command) return { skip: "no command" };
  // Configuration files are not type-checked: a value that is not a string is never converted into
  // one (an object whose toString is null throws, one nested 10,000 levels deep runs out of stack).
  if (typeof entry.command !== "string") return { skip: "its command is not a string" };
  if (type === "mcpcage") return { skip: "already wrapped" };
  if (type !== "npx") {
    const hint = type === "docker" ? "already containerized; `mcpcage run --image` can add pinning and audit" : "only npx servers can be caged in this version";
    return { skip: `${entry.command}: ${hint}` };
  }
  const given: unknown = entry.args ?? [];
  if (!Array.isArray(given)) return { skip: "its args are not a list" };
  if (given.some((arg) => typeof arg !== "string")) return { skip: "it has an argument that is not a string" };
  const args = given as string[];
  let serverArgs: string[];
  try {
    serverArgs = parseLaunch([entry.command, ...args]).args;
  } catch (error) {
    // `mcpcage run` would refuse this command line at every start: better to leave the entry as it is.
    return { skip: (error as Error).message };
  }
  // The server's own arguments end the list, after npx's flags and the package, which is never mounted.
  const npxPart = args.slice(0, args.length - serverArgs.length);
  const paths = serverArgs.map((arg) => hostPath(arg));
  const machine = thisMachine();
  for (const path of paths) {
    const reason = path === undefined ? undefined : sensitivePath(path, machine);
    if (reason !== undefined) return { skip: `needs ${path}, which mcpcage will not mount: ${reason}` };
  }
  const envFlags: string[] = [];
  const env: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(isJsonObject(entry.env) ? entry.env : {})) {
    const host = hostVariable(name, value);
    if (host === undefined) {
      envFlags.push("--env", name);
      env[name] = value;
    } else if (host.to === "container") {
      if (typeof value !== "string") return { skip: notAString(name) };
      envFlags.push("--env", `${name}=${value}`);
    }
  }
  const mountFlags = [...new Set(paths.filter((path): path is string => path !== undefined))].flatMap((path) => ["--mount", `${path}:rw`]);
  const server = serverArgs.map((arg, index) => paths[index] ?? arg);
  const wrapped: ServerEntry = { ...entry, command: options.command, args: ["run", ...envFlags, ...mountFlags, "--", entry.command, ...npxPart, ...server] };
  if (isJsonObject(entry.env)) wrapped.env = env as Record<string, string>;
  return { entry: wrapped };
}

/** Why an entry whose variable would move into `--env NAME=value` stays as it is: its value would have to be converted. */
function notAString(name: string): string {
  return `its env gives ${terminalSafe(name)} a value that is not a string`;
}

/**
 * A wrapped entry whose `env` sets variables that act on the host (HOST_ENV), rewritten as
 * wrapEntry writes them: each moves to an `--env NAME=value` right after `run`, in place of an
 * `--env NAME` that read it from mcpcage's own environment, or is dropped with that flag. The other
 * arguments stay as they are. Undefined when the entry's `env` sets none; a reason to leave the
 * entry as it is when one of their values is not a string.
 */
export function moveHostEnv(entry: ServerEntry): { entry: ServerEntry } | { skip: string } | undefined {
  if (!isWrapped(entry) || !isJsonObject(entry.env)) return undefined;
  const host = Object.entries(entry.env).flatMap(([name, value]) => {
    const found = hostVariable(name, value);
    return found === undefined ? [] : [{ name, value, to: found.to }];
  });
  if (host.length === 0) return undefined;
  const odd = host.find((variable) => variable.to === "container" && typeof variable.value !== "string");
  if (odd !== undefined) return { skip: notAString(odd.name) };
  const names = new Set(host.map((variable) => variable.name));
  const args = entry.args; // a list: isWrapped asks for one
  const separator = args.indexOf("--");
  const own = args.slice(1, separator === -1 ? args.length : separator);
  const kept: string[] = [];
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    if (arg === "--env" && names.has(own[index + 1]!)) index++;
    else if (!(typeof arg === "string" && arg.startsWith("--env=") && names.has(arg.slice("--env=".length)))) kept.push(arg);
  }
  const moved = host.flatMap((variable) => (variable.to === "container" ? ["--env", `${variable.name}=${variable.value as string}`] : []));
  const env = Object.fromEntries(Object.entries(entry.env).filter(([name]) => !names.has(name))) as Record<string, string>;
  return { entry: { ...entry, args: ["run", ...moved, ...kept, ...(separator === -1 ? [] : args.slice(separator))], env } };
}

/**
 * Each `--env NAME=value` (or `--env=NAME=value`) among mcpcage's own arguments, the ones before
 * `--`: `index` is the argument that holds it, `prefix` what comes before NAME in that argument.
 */
export function envValues(args: unknown[]): Array<{ index: number; prefix: string; name: string; value: string }> {
  const found: Array<{ index: number; prefix: string; name: string; value: string }> = [];
  const separator = args.indexOf("--");
  const end = separator === -1 ? args.length : separator;
  for (let index = 0; index < end; index++) {
    const arg = args[index];
    let prefix: string;
    let pair: unknown;
    if (arg === "--env") {
      prefix = "";
      pair = args[++index];
    } else if (typeof arg === "string" && arg.startsWith("--env=")) {
      prefix = "--env=";
      pair = arg.slice(prefix.length);
    } else {
      continue;
    }
    const equals = typeof pair === "string" && index < end ? pair.indexOf("=") : -1;
    if (equals > 0) found.push({ index, prefix, name: (pair as string).slice(0, equals), value: (pair as string).slice(equals + 1) });
  }
  return found;
}

/** A wrapped command line as it can be printed: the value of each `--env NAME=value` left out. */
export function withoutEnvValues(args: string[]): string[] {
  const shown = [...args];
  for (const { index, prefix, name } of envValues(args)) shown[index] = `${prefix}${name}=***`;
  return shown;
}

/** The absolute path an argument names on this machine, when it exists here: `/x` as written, `~/x` expanded. */
export function hostPath(arg: unknown): string | undefined {
  if (typeof arg !== "string") return undefined; // configuration files are not type-checked
  const path = arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
  return isAbsolute(path) && existsSync(path) ? path : undefined;
}

/**
 * `remote` for servers reached over the network (nothing runs locally), `mcpcage` for entries that
 * already start through `mcpcage run`, otherwise the program that starts the server.
 */
export function serverType(entry: ServerEntry): ServerType {
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
  if (entry.url != null || entry.serverUrl != null || (type !== undefined && REMOTE_TYPES.has(type))) return "remote";
  if (isWrapped(entry)) return "mcpcage";
  const program = typeof entry.command === "string" ? (entry.command.split(/[/\\]/).pop() ?? "") : "";
  if (/^npx(\.cmd)?$/.test(program)) return "npx";
  if (/^uvx(\.exe)?$/.test(program)) return "uvx";
  if (/^docker(\.exe)?$/.test(program)) return "docker";
  return "other";
}

/**
 * Restores the original commands that `wrapConfig` replaced. The values `wrap` moved into
 * `--env NAME=value` go back to `env`, where the server finds them again.
 */
export function unwrapConfig(file: string, options: { dryRun: boolean }): WrapOutcome {
  return transform(file, options.dryRun, (name, entry, skip) => {
    const restored = unwrapEntry(entry);
    return "skip" in restored ? skip(name, restored.skip) : restored.entry;
  });
}

/** The entry a wrapped one was made from: the command after `--`, with the values of its `--env NAME=value` back in `env`. */
export function unwrapEntry(entry: ServerEntry): { entry: ServerEntry } | { skip: string } {
  if (!isWrapped(entry)) return { skip: "not wrapped" };
  const args = entry.args; // a list: isWrapped asks for one
  const separator = args.indexOf("--");
  const original = args.slice(separator + 1);
  if (separator === -1 || original.length === 0) return { skip: "unexpected mcpcage arguments" };
  // They become the command and its arguments again, which are never converted into text: unwrap
  // wrote such a command back, then stopped printing it ("Cannot convert object to primitive value").
  if (original.some((arg) => typeof arg !== "string")) return { skip: "it has an argument that is not a string" };
  const restored: ServerEntry = { ...entry, command: original[0], args: original.slice(1) };
  const moved = envValues(args);
  if (moved.length > 0) restored.env = { ...(isJsonObject(entry.env) ? entry.env : {}), ...Object.fromEntries(moved.map((variable) => [variable.name, variable.value])) };
  return { entry: restored };
}

export function isWrapped(entry: ServerEntry): entry is ServerEntry & { command: string; args: string[] } {
  // `where mcpcage` gives mcpcage.cmd on Windows. The arguments must be a list: an object whose "0"
  // is "run" looked wrapped too, and unwrap stopped at it with "args.indexOf is not a function".
  return typeof entry.command === "string" && /(^|[/\\])mcpcage(\.cmd|\.exe)?$/.test(entry.command) && Array.isArray(entry.args) && entry.args[0] === "run";
}

type Rewrite = (
  name: string,
  entry: ServerEntry,
  skip: (name: string, reason: string) => undefined,
) => ServerEntry | undefined;

function transform(file: string, dryRun: boolean, rewrite: Rewrite): WrapOutcome {
  // Read first and explain a missing file from the error: a look before the read would leave a
  // moment in which the file can change under the name that is then rewritten.
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${file} does not exist`);
    throw error;
  }
  const text = bytes.toString("utf8");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} is not plain JSON (comments are not supported yet)`);
  }
  const key = config.mcpServers !== undefined ? "mcpServers" : config.servers !== undefined ? "servers" : undefined;
  if (!key) throw new Error(`${file} has neither "mcpServers" nor "servers"`);
  const servers = config[key] as Record<string, ServerEntry>;

  const outcome: WrapOutcome = { file, key, changed: [], skipped: [] };
  const skip = (name: string, reason: string) => {
    outcome.skipped.push({ name, reason });
    return undefined;
  };
  for (const [name, entry] of Object.entries(servers)) {
    // Configuration files are not type-checked, and one entry that trips its rewrite up is left as it
    // is, with the reason, while the others are rewritten: a null entry, or one whose args were an
    // object, stopped wrap or unwrap with a TypeError and left every server of the file as it was.
    let after: ServerEntry | undefined;
    try {
      after = isJsonObject(entry) ? rewrite(name, entry, skip) : skip(name, "it is not an object");
    } catch (error) {
      after = skip(name, `could not rewrite it: ${error instanceof Error ? error.message : "an unexpected error"}`);
    }
    if (after) {
      outcome.changed.push({ name, before: entry, after });
      servers[name] = after;
    }
  }

  // Written over the live file, the new text could be cut halfway (a full disk, a kill) and leave the
  // client half a JSON file; and a backup copied from the file could hold other bytes than those read.
  if (!dryRun && outcome.changed.length > 0) outcome.backup = replaceFile(file, bytes, `${JSON.stringify(config, null, 2)}\n`);
  return outcome;
}

/**
 * A backup of the bytes that were read, under a name no other file has, then the new text through a
 * temporary file in the same directory and a rename, so a client never reads half a file. The file
 * keeps its permissions, and a symlinked configuration (dotfiles) keeps its link: the file it points
 * to is the one replaced.
 */
export function replaceFile(file: string, original: Buffer, text: string): string {
  const target = realpathSync(file);
  const mode = statSync(target).mode & 0o777;
  const backup = createBackup(file, (name) => writeFileSync(name, original, { flag: "wx", mode }));
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

/**
 * A backup next to `file` that never replaces another: `<file>.mcpcage.bak`, else a name with the
 * time, else that name with a random suffix. `create` must refuse a name that exists (EEXIST):
 * looking first and writing after would leave a moment in which a file can appear under that name.
 */
export function createBackup(file: string, create: (backup: string) => void): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const backup of [`${file}.mcpcage.bak`, `${file}.mcpcage.${stamp}.bak`]) {
    try {
      create(backup);
      return backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const backup = `${file}.mcpcage.${stamp}-${randomBytes(4).toString("hex")}.bak`;
  create(backup);
  return backup;
}
