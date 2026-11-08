// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DEPTH } from "../src/manifest.js";
import { fixConfigs, scanConfigs } from "../src/protect.js";

// Why `protect --fix` leaves a whole file as it is, and what it says then.

const noNpm = () => ({ status: 1, stdout: "", stderr: "no npm" });
const entry = '{ "command": "npx", "args": ["-y", "@acme/notes"] }';

async function scanned(text: string, jsonc: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "mcpcage-fix-refusals-"));
  const file = join(dir, "mcp.json");
  writeFileSync(file, text);
  const location = { client: "cursor" as const, clientName: "Cursor", scope: "user" as const, file, key: "mcpServers" as const, jsonc, exists: true };
  const report = await scanConfigs({ locations: [location], home: dir, offline: true, cacheDir: join(dir, "cache"), npmRunner: noNpm });
  return { dir, file, report };
}

function fix(report: Awaited<ReturnType<typeof scanned>>["report"], dir: string, claudeCodeRunning = false) {
  const log: string[] = [];
  const outcome = fixConfigs({ report, command: "/opt/mcpcage", claudeCodeRunning, dryRun: true, home: dir, log: (line) => log.push(line) });
  return { outcome, log };
}

describe("protect --fix leaves a file as it is", () => {
  it("when it has comments, and shows the command to write by hand", async () => {
    const { dir, report } = await scanned(`{\n  // my servers\n  "mcpServers": { "notes": ${entry} }\n}\n`, true);
    const { outcome, log } = fix(report, dir);
    expect(outcome.files[0]?.refused).toBe("it has comments");
    expect(outcome.files[0]?.changed).toEqual([]);
    expect(log.join("\n")).toContain("has comments, which rewriting it would lose");
    expect(log.join("\n")).toContain("mcpcage");
  });

  it("when it nests values deeper than it will rewrite", async () => {
    const deep = `${'{"a":'.repeat(MAX_DEPTH + 5)}1${"}".repeat(MAX_DEPTH + 5)}`;
    const { dir, report } = await scanned(`{ "setting": ${deep}, "mcpServers": { "notes": ${entry} } }`, false);
    const { outcome, log } = fix(report, dir);
    expect(outcome.files[0]?.refused).toContain("levels deep");
    expect(log.join("\n")).toContain("which mcpcage does not rewrite");
  });

  it("when it cannot be read again after the scan", async () => {
    const { dir, file, report } = await scanned(`{ "mcpServers": { "notes": ${entry} } }`, false);
    rmSync(file);
    const { outcome, log } = fix(report, dir);
    expect(outcome.files[0]?.refused).toContain("could not read it again");
    expect(log.join("\n")).toContain("not changed:");
  });

  it("when what it holds is no longer JSON after the scan", async () => {
    const { dir, file, report } = await scanned(`{ "mcpServers": { "notes": ${entry} } }`, false);
    writeFileSync(file, "{ broken");
    expect(fix(report, dir).outcome.files[0]?.refused).toContain("could not read it again");
  });

  it("plans the rewrite of an ordinary file", async () => {
    const { dir, report } = await scanned(`{ "mcpServers": { "notes": ${entry} } }`, false);
    const { outcome, log } = fix(report, dir);
    expect(outcome.files[0]?.refused).toBeUndefined();
    expect(outcome.files[0]?.changed.map((change) => change.name)).toEqual(["notes"]);
    expect(log.join("\n")).toContain("cage notes in");
  });
});
