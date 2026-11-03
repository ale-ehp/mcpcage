import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseLaunch } from "./launch.js";

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
 * One entry rewritten to start through `mcpcage run`, or why it cannot be. Environment variables
 * become explicit `--env NAME` flags, because nothing from the host reaches the container unless it
 * is named. A path the server is given and that exists here becomes a writable mount at the same
 * path, because the server is expected to work there: a filesystem server pointed at ~/notes would
 * otherwise find nothing inside the cage. Every other path, and the network, stay closed.
 * A `~/` argument becomes the absolute path that is mounted: inside the cage HOME is /tmp, so a
 * server that expands `~` itself would look in /tmp.
 */
export function wrapEntry(entry: ServerEntry, options: { command: string }): { entry: ServerEntry } | { skip: string } {
  const type = serverType(entry);
  if (type === "remote") return { skip: "remote server: nothing runs locally to cage" };
  if (!entry.command) return { skip: "no command" };
  if (type === "mcpcage") return { skip: "already wrapped" };
  if (type !== "npx") {
    const hint = type === "docker" ? "already containerized; `mcpcage run --image` can add pinning and audit" : "only npx servers can be caged in this version";
    return { skip: `${entry.command}: ${hint}` };
  }
  const args = entry.args ?? [];
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
  const envFlags = Object.keys(entry.env ?? {}).flatMap((variable) => ["--env", variable]);
  const mountFlags = [...new Set(paths.filter((path): path is string => path !== undefined))].flatMap((path) => ["--mount", `${path}:rw`]);
  const server = serverArgs.map((arg, index) => paths[index] ?? arg);
  return { entry: { ...entry, command: options.command, args: ["run", ...envFlags, ...mountFlags, "--", entry.command, ...npxPart, ...server] } };
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

/** Restores the original commands that `wrapConfig` replaced. */
export function unwrapConfig(file: string, options: { dryRun: boolean }): WrapOutcome {
  return transform(file, options.dryRun, (name, entry, skip) => {
    if (!isWrapped(entry)) return skip(name, "not wrapped");
    const args = entry.args ?? [];
    const separator = args.indexOf("--");
    const original = args.slice(separator + 1);
    if (separator === -1 || original.length === 0) return skip(name, "unexpected mcpcage arguments");
    return { ...entry, command: original[0], args: original.slice(1) };
  });
}

export function isWrapped(entry: ServerEntry): boolean {
  // `where mcpcage` gives mcpcage.cmd on Windows.
  return typeof entry.command === "string" && /(^|[/\\])mcpcage(\.cmd|\.exe)?$/.test(entry.command) && entry.args?.[0] === "run";
}

type Rewrite = (
  name: string,
  entry: ServerEntry,
  skip: (name: string, reason: string) => undefined,
) => ServerEntry | undefined;

function transform(file: string, dryRun: boolean, rewrite: Rewrite): WrapOutcome {
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const text = readFileSync(file, "utf8");
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
    const after = rewrite(name, entry, skip);
    if (after) {
      outcome.changed.push({ name, before: entry, after });
      servers[name] = after;
    }
  }

  if (!dryRun && outcome.changed.length > 0) {
    let backup = `${file}.mcpcage.bak`;
    if (existsSync(backup)) backup = `${file}.mcpcage.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    copyFileSync(file, backup);
    outcome.backup = backup;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return outcome;
}
