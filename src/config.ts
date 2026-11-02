import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** One MCP server entry, as Claude Desktop, Claude Code, Cursor and VS Code store it. */
interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  [field: string]: unknown;
}

export interface WrapOutcome {
  file: string;
  /** `mcpServers` (Claude Desktop, Claude Code, Cursor) or `servers` (VS Code). */
  key: "mcpServers" | "servers";
  changed: Array<{ name: string; before: ServerEntry; after: ServerEntry }>;
  skipped: Array<{ name: string; reason: string }>;
  backup?: string;
}

/**
 * Rewrites every npx-launched stdio server so the client starts it through `mcpcage run`.
 * Environment variables the entry passes become explicit `--env NAME` flags, because nothing
 * from the host reaches the container unless it is named.
 */
export function wrapConfig(file: string, options: { dryRun: boolean; command?: string }): WrapOutcome {
  const mcpcage = options.command ?? "mcpcage";
  return transform(file, options.dryRun, (name, entry, skip) => {
    if (entry.url !== undefined || (entry.type !== undefined && entry.type !== "stdio")) return skip(name, "remote server: nothing runs locally to cage");
    if (!entry.command) return skip(name, "no command");
    if (isWrapped(entry)) return skip(name, "already wrapped");
    if (!/(^|[/\\])npx(\.cmd)?$/.test(entry.command)) {
      const hint = /(^|[/\\])docker$/.test(entry.command) ? "already containerized; `mcpcage run --image` can add pinning and audit" : "only npx servers can be caged in this version";
      return skip(name, `${entry.command}: ${hint}`);
    }
    const envFlags = Object.keys(entry.env ?? {}).flatMap((variable) => ["--env", variable]);
    return { ...entry, command: mcpcage, args: ["run", ...envFlags, "--", entry.command, ...(entry.args ?? [])] };
  });
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
  return entry.command !== undefined && /(^|[/\\])mcpcage$/.test(entry.command) && entry.args?.[0] === "run";
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
