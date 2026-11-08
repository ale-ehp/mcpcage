// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, auditFiles, verifyAuditFile } from "../src/audit.js";

// What `mcpcage audit verify` and `audit show` rely on: the first break in the chain is found and
// named, whichever way an entry was changed, and the log files of a store are listed in a stable order.

const GENESIS = "0".repeat(64);

function inFreshHome<T>(body: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "mcpcage-audit-verify-"));
  const before = process.env.MCPCAGE_HOME;
  process.env.MCPCAGE_HOME = home;
  try {
    return body(home);
  } finally {
    if (before === undefined) delete process.env.MCPCAGE_HOME;
    else process.env.MCPCAGE_HOME = before;
  }
}

/** A log of `count` entries, written as the proxy writes it. */
function written(server: string, session: string, count: number): string {
  const audit = new AuditLog(server, session);
  for (let index = 0; index < count; index++) audit.write("call", { tool: `tool-${index}` });
  return audit.file;
}

function linesOf(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}

describe("verifying an audit log", () => {
  it("accepts an intact chain and ignores blank lines", () => {
    inFreshHome(() => {
      const file = written("notes", "s1", 3);
      writeFileSync(file, `${linesOf(file).join("\n\n")}\n\n`);
      expect(verifyAuditFile(file)).toEqual({ file, ok: true, entries: 3 });
    });
  });

  it("accepts an empty file", () => {
    inFreshHome((home) => {
      const file = join(home, "empty.jsonl");
      writeFileSync(file, "");
      expect(verifyAuditFile(file)).toEqual({ file, ok: true, entries: 0 });
    });
  });

  it("names the line that is not JSON, and how many entries came before it", () => {
    inFreshHome(() => {
      const file = written("notes", "s1", 2);
      writeFileSync(file, `${linesOf(file).join("\n")}\n{this is not json\n`);
      expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 2, line: 3, error: "not valid JSON" });
    });
  });

  it("finds an entry that was deleted from the start by its sequence number", () => {
    inFreshHome(() => {
      const file = written("notes", "s1", 3);
      writeFileSync(file, `${linesOf(file).slice(1).join("\n")}\n`);
      expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 0, line: 1, error: "expected seq 0, found 1" });
    });
  });

  it("finds entries that were put in another order", () => {
    inFreshHome(() => {
      const file = written("notes", "s1", 3);
      const [first, second, third] = linesOf(file);
      writeFileSync(file, `${[first, third, second].join("\n")}\n`);
      expect(verifyAuditFile(file)).toMatchObject({ ok: false, entries: 1, line: 2, error: "expected seq 1, found 2" });
    });
  });

  it("finds an entry whose link to the one before it was changed", () => {
    inFreshHome(() => {
      const file = written("notes", "s1", 2);
      const [first, second] = linesOf(file);
      const changed = { ...(JSON.parse(second!) as Record<string, unknown>), prev: GENESIS };
      writeFileSync(file, `${first}\n${JSON.stringify(changed)}\n`);
      expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 1, line: 2, error: "prev does not match the hash of the previous entry" });
    });
  });

  it("finds an entry whose content was changed after it was written", () => {
    inFreshHome(() => {
      const file = written("notes", "s1", 2);
      const [first, second] = linesOf(file);
      const changed = { ...(JSON.parse(first!) as Record<string, unknown>), tool: "something else" };
      writeFileSync(file, `${JSON.stringify(changed)}\n${second}\n`);
      expect(verifyAuditFile(file)).toEqual({ file, ok: false, entries: 0, line: 1, error: "entry content does not match its hash" });
    });
  });

  it("finds an entry whose hash is not a string", () => {
    inFreshHome(() => {
      const file = written("notes", "s1", 1);
      const changed = { ...(JSON.parse(linesOf(file)[0]!) as Record<string, unknown>), hash: 42 };
      writeFileSync(file, `${JSON.stringify(changed)}\n`);
      expect(verifyAuditFile(file)).toMatchObject({ ok: false, line: 1, error: "entry content does not match its hash" });
    });
  });
});

describe("listing the audit log files of a store", () => {
  it("lists nothing when the store has no audit directory yet", () => {
    inFreshHome(() => {
      expect(auditFiles()).toEqual([]);
      expect(auditFiles("notes")).toEqual([]);
    });
  });

  it("lists the .jsonl files of every server, sorted, and nothing else", () => {
    inFreshHome((home) => {
      const second = written("beta", "s2", 1);
      const first = written("alpha", "s1", 1);
      const later = written("alpha", "s3", 1);
      writeFileSync(join(home, "audit", "alpha", "notes.txt"), "not a log");
      expect(auditFiles()).toEqual([first, later, second]);
    });
  });

  it("lists only the files of the server it is asked for", () => {
    inFreshHome(() => {
      written("alpha", "s1", 1);
      const beta = written("beta", "s2", 1);
      expect(auditFiles("beta")).toEqual([beta]);
    });
  });

  it("lists nothing for a server that has no logs", () => {
    inFreshHome((home) => {
      written("alpha", "s1", 1);
      mkdirSync(join(home, "audit", "empty"));
      expect(auditFiles("empty")).toEqual([]);
      expect(auditFiles("missing")).toEqual([]);
    });
  });

  it("refuses a server id that leads outside the store", () => {
    inFreshHome(() => {
      written("alpha", "s1", 1);
      expect(() => auditFiles("..")).toThrow("leads outside mcpcage's store");
    });
  });
});
