import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_DEPTH, nestedDeeperThan, own, pinTools, tooDeep, type Pin, type ToolDefinition, type Violation } from "./manifest.js";
import { cageHome, serverDir } from "./paths.js";

/** A manifest that was seen but not approved yet, waiting for `mcpcage approve`. */
export interface Pending {
  serverId: string;
  seenAt: string;
  tools: ToolDefinition[];
  violations: Violation[];
}

/**
 * The approved manifest. An older version may have approved a definition nested deeper than
 * MAX_DEPTH: comparing or explaining it would walk it, and writing the pin again would serialize it.
 * It is left out, with one line to `warn`, and its tool counts as new, needing a fresh approval.
 */
export function loadPin(serverId: string, warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`)): Pin | undefined {
  const pin = readJson<Pin>(join(serverDir(serverId), "pin.json"));
  if (!pin) return undefined;
  const deep = Object.keys(pin.tools).filter((name) => nestedDeeperThan(own(pin.tools, name)?.definition, MAX_DEPTH));
  if (deep.length === 0) return pin;
  for (const name of deep) delete pin.tools[name];
  const names = deep.map((name) => JSON.stringify(name)).join(", ");
  warn(
    deep.length === 1
      ? `mcpcage: left out the approved tool ${names} of ${serverId}: its definition is nested more than ${MAX_DEPTH} levels deep, so it counts as new and needs a fresh approval`
      : `mcpcage: left out the approved tools ${names} of ${serverId}: their definitions are nested more than ${MAX_DEPTH} levels deep, so they count as new and need a fresh approval`,
  );
  return pin;
}

export function savePin(pin: Pin): void {
  writeJson(join(serverDir(pin.serverId), "pin.json"), pin);
}

export function loadPending(serverId: string): Pending | undefined {
  return readJson<Pending>(join(serverDir(serverId), "pending.json"));
}

/** Every definition a pending manifest holds: its tools and both sides of each change. */
export function pendingDefinitions(pending: Pending): ToolDefinition[] {
  return [...pending.tools, ...pending.violations.flatMap((violation) => (violation.kind === "changed-tool" ? [violation.before, violation.after] : [violation.after]))];
}

/** Pagination can deliver a manifest in pieces: pending tools accumulate until approved. */
export function savePending(serverId: string, tools: ToolDefinition[], violations: Violation[]): Pending {
  // An older version may have saved a definition nested deeper than MAX_DEPTH, which can never be
  // shown or approved, and writing it again would run JSON.stringify out of stack: it is left out.
  const loaded = loadPending(serverId);
  const previous = loaded && !tooDeep(pendingDefinitions(loaded)) ? loaded : undefined;
  const byName = new Map<string, ToolDefinition>();
  for (const tool of previous?.tools ?? []) byName.set(tool.name, tool);
  for (const tool of tools) byName.set(tool.name, tool);
  const violationsByName = new Map<string, Violation>();
  for (const violation of [...(previous?.violations ?? []), ...violations]) violationsByName.set(violation.name, violation);
  const pending: Pending = {
    serverId,
    seenAt: new Date().toISOString(),
    tools: [...byName.values()],
    violations: [...violationsByName.values()],
  };
  writeJson(join(serverDir(serverId), "pending.json"), pending);
  return pending;
}

/** Approving merges the pending tools into the pin: they become the new trusted definitions. */
export function approvePending(serverId: string, warn?: (message: string) => void): Pin | undefined {
  const pending = loadPending(serverId);
  if (!pending) return undefined;
  const pin = pinTools(serverId, pending.tools, loadPin(serverId, warn));
  savePin(pin);
  rmSync(join(serverDir(serverId), "pending.json"), { force: true });
  return pin;
}

export function listServers(): string[] {
  const dir = join(cageHome(), "servers");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Writes through a temporary file and a rename, so a crash never leaves half a pin on disk. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}
