import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinTools, type Pin, type ToolDefinition, type Violation } from "./manifest.js";
import { cageHome, serverDir } from "./paths.js";

/** A manifest that was seen but not approved yet, waiting for `mcpcage approve`. */
export interface Pending {
  serverId: string;
  seenAt: string;
  tools: ToolDefinition[];
  violations: Violation[];
}

export function loadPin(serverId: string): Pin | undefined {
  return readJson<Pin>(join(serverDir(serverId), "pin.json"));
}

export function savePin(pin: Pin): void {
  writeJson(join(serverDir(pin.serverId), "pin.json"), pin);
}

export function loadPending(serverId: string): Pending | undefined {
  return readJson<Pending>(join(serverDir(serverId), "pending.json"));
}

/** Pagination can deliver a manifest in pieces: pending tools accumulate until approved. */
export function savePending(serverId: string, tools: ToolDefinition[], violations: Violation[]): Pending {
  const previous = loadPending(serverId);
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
export function approvePending(serverId: string): Pin | undefined {
  const pending = loadPending(serverId);
  if (!pending) return undefined;
  const pin = pinTools(serverId, pending.tools, loadPin(serverId));
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
