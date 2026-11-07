import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeStaleRoots } from "./global-setup.js";

describe("the temporary roots of test runs", () => {
  it("are removed when the process that made one is gone, never while it runs, and others are left alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcage-roots-"));
    // A process that has ended: its pid names no process now.
    const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const dead = Number(ended.stdout);
    const root = (name: string) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "left"), "x");
      return join(dir, name);
    };
    const stale = root(`mcpcage-vitest-${dead}-a1B2c3`);
    const own = root(`mcpcage-vitest-${process.pid}-d4E5f6`);
    const parent = root(`mcpcage-vitest-${process.ppid}-g7H8i9`);
    // A root of the old form names no process, and anything else is no root of a test run.
    const unnamed = root("mcpcage-vitest-j1K2l3");
    const other = root(`mcpcage-other-${dead}-x`);
    removeStaleRoots(dir);
    expect(existsSync(stale)).toBe(false);
    for (const kept of [own, parent, unnamed, other]) expect(existsSync(kept), kept).toBe(true);
  });
});
