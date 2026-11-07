import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, auditFiles, verifyAuditFile } from "../src/audit.js";
import { freshHome } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A store with one audit log of `count` entries, written by AuditLog itself. */
function writtenLog(count: number, server = "notes", session = "s1"): string {
  vi.stubEnv("MCPCAGE_HOME", freshHome());
  const audit = new AuditLog(server, session);
  for (let i = 0; i < count; i++) audit.write("call", { tool: `tool-${i}` });
  return audit.file;
}

/** The log's lines, rewritten with `change` applied to the entry at `index`. */
function rewritten(file: string, index: number, change: (entry: Record<string, unknown>) => void): string {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  const entry = JSON.parse(lines[index]!) as Record<string, unknown>;
  change(entry);
  lines[index] = JSON.stringify(entry);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("verifyAuditFile", () => {
  it("accepts an intact log written by AuditLog, with every entry counted", () => {
    const file = writtenLog(3);
    expect(verifyAuditFile(file)).toEqual({ file, ok: true, entries: 3 });
  });

  it("accepts an empty file as an empty log", () => {
    vi.stubEnv("MCPCAGE_HOME", freshHome());
    const file = new AuditLog("notes", "s1").file;
    writeFileSync(file, "");
    expect(verifyAuditFile(file)).toEqual({ file, ok: true, entries: 0 });
  });

  it("rejects a line that is not JSON, at its line number", () => {
    const file = writtenLog(2);
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    lines.splice(1, 0, "not json {");
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 1, line: 2, error: "not valid JSON" });
  });

  it("rejects a wrong seq, at its line number", () => {
    const file = rewritten(writtenLog(3), 2, (entry) => {
      entry.seq = 7;
    });
    expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 2, line: 3, error: "expected seq 2, found 7" });
  });

  it("rejects a prev that does not match the previous entry's hash", () => {
    const file = rewritten(writtenLog(3), 1, (entry) => {
      entry.prev = "f".repeat(64);
    });
    expect(verifyAuditFile(file)).toEqual({
      file,
      ok: false,
      entries: 1,
      line: 2,
      error: "prev does not match the hash of the previous entry",
    });
  });

  it("rejects an edited field whose hash no longer matches", () => {
    const file = rewritten(writtenLog(2), 1, (entry) => {
      entry.event = "edited";
    });
    expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 1, line: 2, error: "entry content does not match its hash" });
  });

  it("rejects a deleted middle entry, where the next one's prev no longer matches", () => {
    const file = writtenLog(3);
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    lines.splice(1, 1);
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 1, line: 2, error: "expected seq 1, found 2" });
  });
});

describe("auditFiles", () => {
  it("lists every server's logs, sorted, when no server id is given", () => {
    vi.stubEnv("MCPCAGE_HOME", freshHome());
    const a = new AuditLog("alpha", "s2");
    a.write("call");
    const b = new AuditLog("beta", "s1");
    b.write("call");
    b.write("result");
    const home = process.env.MCPCAGE_HOME!;
    expect(auditFiles()).toEqual([join(home, "audit", "alpha", "s2.jsonl"), join(home, "audit", "beta", "s1.jsonl")]);
  });

  it("lists only the given server's logs", () => {
    vi.stubEnv("MCPCAGE_HOME", freshHome());
    const a = new AuditLog("alpha", "s1");
    a.write("call");
    new AuditLog("beta", "s1").write("call");
    const home = process.env.MCPCAGE_HOME!;
    expect(auditFiles("alpha")).toEqual([join(home, "audit", "alpha", "s1.jsonl")]);
  });

  it("lists nothing for a server without logs, or in a store without an audit directory", () => {
    vi.stubEnv("MCPCAGE_HOME", freshHome());
    new AuditLog("alpha", "s1").write("call");
    expect(auditFiles("missing")).toEqual([]);
    vi.stubEnv("MCPCAGE_HOME", freshHome());
    expect(auditFiles()).toEqual([]);
    expect(auditFiles("alpha")).toEqual([]);
  });
});
