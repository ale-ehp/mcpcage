// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digest, digestMatches } from "./canonical.js";
import { auditDir, cageHome } from "./paths.js";

const GENESIS = "0".repeat(64);

export interface AuditEntry {
  seq: number;
  ts: string;
  server: string;
  session: string;
  event: string;
  prev: string;
  hash: string;
  [field: string]: unknown;
}

/**
 * Append-only JSONL log where every entry carries the hash of the previous one. Editing,
 * reordering or deleting an entry breaks the chain, and `verifyAuditFile` finds the first break.
 * It makes tampering evident; it cannot stop someone from deleting a whole file (see THREAT-MODEL.md).
 * Arguments and results are never written, only their hashes and sizes. Each hash names its
 * algorithm (`sha256:<hex>`); a log written by 0.7.0 or earlier, with bare SHA-256 hex, still verifies.
 */
export class AuditLog {
  readonly file: string;
  private prev = GENESIS;
  private seq = 0;

  constructor(
    readonly serverId: string,
    readonly sessionId: string,
  ) {
    const dir = auditDir(serverId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, `${sessionId}.jsonl`);
  }

  write(event: string, data: Record<string, unknown> = {}): void {
    const entry = {
      seq: this.seq++,
      ts: new Date().toISOString(),
      server: this.serverId,
      session: this.sessionId,
      event,
      ...data,
      prev: this.prev,
    };
    const hash = digest(`${this.prev}\n${canonicalJson(entry)}`);
    appendFileSync(this.file, `${JSON.stringify({ ...entry, hash })}\n`, { mode: 0o600 });
    this.prev = hash;
  }
}

export interface VerifyResult {
  file: string;
  ok: boolean;
  entries: number;
  error?: string;
  line?: number;
}

export function verifyAuditFile(file: string): VerifyResult {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  let prev = GENESIS;
  for (const [index, line] of lines.entries()) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return { file, ok: false, entries: index, line: index + 1, error: "not valid JSON" };
    }
    const { hash, ...body } = entry;
    if (body.seq !== index) return { file, ok: false, entries: index, line: index + 1, error: `expected seq ${index}, found ${body.seq}` };
    if (body.prev !== prev) return { file, ok: false, entries: index, line: index + 1, error: "prev does not match the hash of the previous entry" };
    if (typeof hash !== "string" || !digestMatches(hash, `${prev}\n${canonicalJson(body)}`)) return { file, ok: false, entries: index, line: index + 1, error: "entry content does not match its hash" };
    prev = hash;
  }
  return { file, ok: true, entries: lines.length };
}

export function auditFiles(serverId?: string): string[] {
  const root = join(cageHome(), "audit");
  if (!existsSync(root)) return [];
  const servers = serverId ? [serverId] : readdirSync(root);
  return servers.flatMap((server) => {
    // Through auditDir, which refuses a directory outside the store: `audit show ..` read the store's root.
    const dir = auditDir(server);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(dir, name));
  });
}
