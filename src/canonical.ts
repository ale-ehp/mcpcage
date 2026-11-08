// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
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

/**
 * The algorithms a stored digest may name, and the one new digests use. A digest is stored as
 * `<algorithm>:<hex>`, so that a store written today still checks if DIGEST_ALGORITHM changes: moving
 * off SHA-256 is one line here, not a migration of every pin and audit log users already have.
 */
const DIGEST_HEX_LENGTH = { sha256: 64, sha512: 128 } as const;
type DigestAlgorithm = keyof typeof DIGEST_HEX_LENGTH;
export const DIGEST_ALGORITHM: DigestAlgorithm = "sha256";

/** `text` digested with DIGEST_ALGORITHM, as `<algorithm>:<hex>`. */
export function digest(text: string): string {
  return digestWith(DIGEST_ALGORITHM, text);
}

function digestWith(algorithm: DigestAlgorithm, text: string): string {
  return `${algorithm}:${createHash(algorithm).update(text).digest("hex")}`;
}

/**
 * Whether `stored` is the digest of `text`, with the algorithm it names. Versions up to 0.7.0 stored
 * bare SHA-256 hex, which still counts as SHA-256. A digest that names no known algorithm, or has the
 * wrong length for it, matches nothing: it fails closed, as a changed tool or a broken audit chain.
 */
export function digestMatches(stored: string, text: string): boolean {
  const named = /^([a-z0-9]+):([0-9a-f]+)$/.exec(stored);
  const [algorithm, hex] = named ? [named[1]!, named[2]!] : ["sha256", stored];
  if (!Object.hasOwn(DIGEST_HEX_LENGTH, algorithm)) return false;
  const known = algorithm as DigestAlgorithm;
  if (hex.length !== DIGEST_HEX_LENGTH[known] || !/^[0-9a-f]+$/.test(hex)) return false;
  return digestWith(known, text) === `${known}:${hex}`;
}
