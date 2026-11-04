import { canonicalJson, sha256 } from "./canonical.js";

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
  const { _meta: _ignored, ...visible } = tool;
  return sha256(canonicalJson(visible));
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
    } else if (approved.hash !== toolFingerprint(tool)) {
      violations.push({ kind: "changed-tool", name: tool.name, before: approved.definition, after: tool });
    }
  }
  return violations;
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
 * The most tools one listing may hold. Real servers list a few dozen. Every tool listed is pinned,
 * compared and scanned: a single line of 200,000 tools made `protect --inspect` throw, and took the
 * proxy two seconds and 11 MiB of log lines to explain once blocked. A listing with more is refused
 * whole, like a definition nested too deep.
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

/** The lines for one violation, so callers can add their own lines under each tool. */
export function describeViolation(violation: Violation): string[] {
  if (violation.kind === "new-tool") {
    return [`+ new tool "${violation.name}" was not in the approved manifest`, ...indent(fieldsOf(violation.after))];
  }
  return [
    `~ tool "${violation.name}" changed since it was approved`,
    ...jsonChanges(violation.before, violation.after).map((change) => `    ${change}`),
  ];
}

function fieldsOf(tool: ToolDefinition): string[] {
  const out: string[] = [];
  if (typeof tool.description === "string") out.push(`description: ${clip(tool.description)}`);
  if (tool.inputSchema !== undefined) out.push(`inputSchema: ${clip(canonicalJson(tool.inputSchema))}`);
  return out;
}

/** Lists the paths that differ between two JSON values, with before and after values. */
export function jsonChanges(before: unknown, after: unknown, path = ""): string[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  const bothObjects =
    before !== null && after !== null && typeof before === "object" && typeof after === "object" &&
    !Array.isArray(before) && !Array.isArray(after);
  if (!bothObjects) {
    return [`${path || "(root)"}: ${clip(show(before))} -> ${clip(show(after))}`];
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

function clip(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}... (${text.length} chars)` : text;
}

function indent(lines: string[]): string[] {
  return lines.map((line) => `    ${line}`);
}
