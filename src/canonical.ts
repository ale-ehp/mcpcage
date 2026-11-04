import { createHash } from "node:crypto";

/** JSON with object keys sorted recursively, so equal values always serialize (and hash) the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    // Without a prototype, so that every key becomes an own property that JSON.stringify writes. On
    // a plain object, assigning "__proto__" called the inherited setter instead: whatever a server
    // put under a key of that name, which JSON.parse keeps as an own property, was left out of the
    // fingerprint, and a server could add hidden text there without the change being seen.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) sorted[key] = sortKeys(inner);
    }
    return sorted;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
