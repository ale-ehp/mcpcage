// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { canonicalJson, digest, digestMatches } from "./canonical.js";
import { excerpt, printable } from "./terminal.js";

/** A tool as returned by `tools/list`: name, description, inputSchema, annotations... */
export interface ToolDefinition {
  name: string;
  [field: string]: unknown;
}

export interface PinnedTool {
  hash: string;
  definition: ToolDefinition;
}

/** The approved tool manifest of one server. */
export interface Pin {
  version: 1;
  serverId: string;
  approvedAt: string;
  tools: Record<string, PinnedTool>;
}

export type Violation =
  | { kind: "new-tool"; name: string; after: ToolDefinition }
  | { kind: "changed-tool"; name: string; before: ToolDefinition; after: ToolDefinition };

/**
 * Hash of everything the model reads about a tool. `_meta` is left out on purpose: it is
 * free-form metadata the model does not see, and including it would raise false alarms.
 */
export function toolFingerprint(tool: ToolDefinition): string {
  return digest(fingerprinted(tool));
}

/** Whether `stored`, a fingerprint saved by this or an older version, is the fingerprint of `tool`. */
export function fingerprintMatches(stored: string, tool: ToolDefinition): boolean {
  return digestMatches(stored, fingerprinted(tool));
}

function fingerprinted(tool: ToolDefinition): string {
  const { _meta: _ignored, ...visible } = tool;
  return canonicalJson(visible);
}

/**
 * The property `key` of `record` if it is its own, else undefined. Tool names and schema keys come
 * from the server, and JSON.parse makes an own property of any name: looked up plainly,
 * "constructor", "toString" or "__proto__" find what every object inherits from Object.prototype.
 */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function pinTools(serverId: string, tools: ToolDefinition[], base?: Pin): Pin {
  // Without a prototype, so that a tool named "__proto__" is stored like any other. Assigned on a
  // plain object, it replaced the object's prototype instead: it was never saved, and at the next
  // start the server was blocked for a change it never made.
  const pinned: Record<string, PinnedTool> = Object.assign(Object.create(null), base?.tools);
  for (const tool of tools) pinned[tool.name] = { hash: toolFingerprint(tool), definition: tool };
  return { version: 1, serverId, approvedAt: new Date().toISOString(), tools: pinned };
}

/**
 * Compares a `tools/list` page with the approved manifest. New tools and changed definitions are
 * violations; a tool that disappears is not, because removing capabilities cannot hurt the user.
 */
export function checkTools(pin: Pin, tools: ToolDefinition[]): Violation[] {
  const violations: Violation[] = [];
  for (const tool of tools) {
    const approved = own(pin.tools, tool.name);
    if (!approved) {
      violations.push({ kind: "new-tool", name: tool.name, after: tool });
    } else if (!fingerprintMatches(approved.hash, tool)) {
      violations.push({ kind: "changed-tool", name: tool.name, before: approved.definition, after: tool });
    }
  }
  return violations;
}

/**
 * Compares a page of the first listing, the one trusted on first use, with what that listing pinned so
 * far: `base` holds its earlier pages. A tool not pinned yet is new. A name that comes back with another
 * definition, from an earlier page or from earlier in the same page, is a changed tool: pinning the page
 * would replace a definition the client may already use, or keep the last of two while the client uses
 * the first. A definition repeated unchanged is harmless. One violation per name, a change outranking
 * the addition, so that the pending manifest shows what approving it would pin.
 */
export function checkFirstListing(tools: ToolDefinition[], base?: Pin): Violation[] {
  // A Map, so that a tool named "__proto__" is looked up like any other.
  const known = new Map<string, PinnedTool>(base ? Object.entries(base.tools) : []);
  const violations = new Map<string, Violation>();
  for (const tool of tools) {
    const before = known.get(tool.name);
    if (!before) {
      known.set(tool.name, { hash: toolFingerprint(tool), definition: tool });
      violations.set(tool.name, { kind: "new-tool", name: tool.name, after: tool });
    } else if (!fingerprintMatches(before.hash, tool)) {
      violations.set(tool.name, { kind: "changed-tool", name: tool.name, before: before.definition, after: tool });
    }
  }
  return [...violations.values()];
}

export function isToolList(value: unknown): value is ToolDefinition[] {
  return (
    Array.isArray(value) &&
    value.every((tool) => tool !== null && typeof tool === "object" && typeof (tool as ToolDefinition).name === "string")
  );
}

/**
 * How deep a tool definition may nest objects and arrays, the definition itself being the first
 * level. Real schemas stay within a few dozen. Pinning, comparing, explaining and scanning a
 * definition walk it level by level, and a few kilobytes nested 10,000 levels deep ran them out of
 * stack and crashed the proxy: a definition nested deeper than this is refused whole, before any of
 * them runs.
 */
export const MAX_DEPTH = 256;

/**
 * The most tools a server may list, in one page or in all its pages. Real servers list a few dozen.
 * Every tool listed is pinned, compared and scanned: a single line of 200,000 tools made `protect
 * --inspect` throw, and took the proxy two seconds and 11 MiB of log lines to explain once blocked. A
 * page with more is refused whole, like a definition nested too deep, and so is a page that would take
 * the pinned or the pending tools of a server past it: pages and listings add up there, and a server
 * reached any number of them with pages of 10,000.
 */
export const MAX_TOOLS = 10_000;

/**
 * Whether `value` nests objects and arrays more than `limit` levels deep, measured with a stack
 * instead of recursion. Anything from a server is checked with it before it is serialized or walked:
 * JSON.stringify recurses, and runs out of stack a few thousand levels down (about 6,800 on Node 22).
 */
export function nestedDeeperThan(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== "object") return false;
  const stack: Array<[object, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (depth > limit) return true;
    for (const inner of Object.values(current)) if (inner !== null && typeof inner === "object") stack.push([inner, depth + 1]);
  }
  return false;
}

/** The first definition that nests deeper than MAX_DEPTH. */
export function tooDeep(definitions: ToolDefinition[]): ToolDefinition | undefined {
  return definitions.find((definition) => nestedDeeperThan(definition, MAX_DEPTH));
}

/** Human-readable explanation of what changed, for the terminal and for `mcpcage diff`. */
export function describeViolations(violations: Violation[]): string {
  return violations.flatMap((violation) => describeViolation(violation)).join("\n");
}

/**
 * The lines for one violation, so callers can add their own lines under each tool. Names, keys and
 * values are the server's text, so each goes through terminalSafe: printed raw, an escape sequence
 * or a carriage return in them cleared or rewrote the screen the user reads before approving. Names
 * and keys are excerpts, as values are clipped: spelled out whole, a tool name of a million U+009B
 * made 8 MiB of the proxy's block message, of `mcpcage diff` and of `approve`.
 */
export function describeViolation(violation: Violation): string[] {
  const name = excerpt(violation.name);
  if (violation.kind === "new-tool") {
    return [`+ new tool "${name}" was not in the approved manifest`, ...indent(fieldsOf(violation.after))];
  }
  return [
    `~ tool "${name}" changed since it was approved`,
    ...jsonChanges(violation.before, violation.after).map((change) => `    ${change}`),
  ];
}

/** The fields a new tool shows first, in the order a reader expects them; any other follows, sorted. */
const FIELD_ORDER = ["title", "description", "inputSchema", "outputSchema", "annotations"];

/**
 * Every field of a new tool that approving it pins: all but `name`, which heads the view, and `_meta`,
 * which the fingerprint leaves out. Only description and inputSchema were shown before, so a title, an
 * output schema or annotations were approved unseen.
 */
function fieldsOf(tool: ToolDefinition): string[] {
  const keys = Object.keys(tool).filter((key) => key !== "name" && key !== "_meta");
  const ordered = [...FIELD_ORDER.filter((key) => keys.includes(key)), ...keys.filter((key) => !FIELD_ORDER.includes(key)).sort()];
  return ordered.flatMap((key) => {
    const value = own(tool, key);
    if (value === undefined) return [];
    return [`${excerpt(key)}: ${clip(typeof value === "string" ? value : canonicalJson(value))}`];
  });
}

/** Lists the paths that differ between two JSON values, with before and after values, all as terminalSafe shows them, the paths as excerpts. */
export function jsonChanges(before: unknown, after: unknown, path = ""): string[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  const bothObjects =
    before !== null && after !== null && typeof before === "object" && typeof after === "object" &&
    !Array.isArray(before) && !Array.isArray(after);
  if (!bothObjects) {
    return [`${excerpt(path || "(root)")}: ${clip(show(before))} -> ${clip(show(after))}`];
  }
  const changes: string[] = [];
  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  for (const key of [...keys].sort()) {
    if (key === "_meta" && path === "") continue;
    // A key on one side only is absent on the other. Read plainly, a "constructor" added by the
    // server was compared with Object itself, which cannot be shown, and explaining the change threw.
    const left = own(before as Record<string, unknown>, key);
    const right = own(after as Record<string, unknown>, key);
    changes.push(...jsonChanges(left, right, path ? `${path}.${key}` : key));
  }
  return changes;
}

function show(value: unknown): string {
  return value === undefined ? "(absent)" : typeof value === "string" ? JSON.stringify(value) : canonicalJson(value);
}

/** `text` as terminalSafe shows it, clipped after `max` characters, with its full length when clipped. */
function clip(text: string, max = 400): string {
  const { shown, clipped } = printable(text, max);
  return clipped ? `${shown}... (${text.length} chars)` : shown;
}

function indent(lines: string[]): string[] {
  return lines.map((line) => `    ${line}`);
}
