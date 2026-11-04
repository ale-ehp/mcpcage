import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeIsRunning, tasklistHasClaude } from "../src/running.js";

// How --fix tells whether Claude Code is running, which leaves ~/.claude.json alone. What it starts
// is recorded, then started as it would be.
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; shell: unknown }>);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const spawnSync = ((file: string, args: string[], options: import("node:child_process").SpawnSyncOptions) => {
    spawned.push({ file, args, shell: options?.shell ?? false });
    return original.spawnSync(file, args, options);
  }) as unknown as typeof original.spawnSync;
  return { ...original, spawnSync };
});

afterEach(() => {
  spawned.length = 0;
});

describe("whether Claude Code is running", () => {
  it("on Windows lists the processes with System32's tasklist.exe, by its full path and without a shell", () => {
    claudeCodeIsRunning("win32", { SystemRoot: "D:\\Windows" });
    // A SystemRoot that is not a full path is not used: the program would be looked for from the current directory.
    claudeCodeIsRunning("win32", { SystemRoot: "Windows" });
    expect(spawned).toEqual([
      { file: "D:\\Windows\\System32\\tasklist.exe", args: ["/fo", "csv", "/nh"], shell: false },
      { file: "C:\\Windows\\System32\\tasklist.exe", args: ["/fo", "csv", "/nh"], shell: false },
    ]);
    // CLAUDECODE, set in what Claude Code starts, answers first.
    expect(claudeCodeIsRunning("win32", { CLAUDECODE: "1" })).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it("finds claude.exe in tasklist's list, in any case, and nothing that only looks like it", () => {
    const line = (name: string) => `"${name}","4242","Console","1","180.000 K"`;
    expect(tasklistHasClaude([line("System Idle Process"), line("claude.exe"), ""].join("\r\n"))).toBe(true);
    expect(tasklistHasClaude(line("Claude.EXE"))).toBe(true);
    expect(tasklistHasClaude([line("node.exe"), line("claude-helper.exe"), line("notclaude.exe"), line("claude")].join("\r\n"))).toBe(false);
  });

  it.runIf(process.platform === "win32")("is true on Windows while a program named claude.exe runs", async () => {
    // A copy of node named claude.exe, which only waits: the name is all tasklist shows.
    const claude = join(mkdtempSync(join(tmpdir(), "mcpcage-claude-")), "claude.exe");
    copyFileSync(process.execPath, claude);
    const child = spawn(claude, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    try {
      expect(claudeCodeIsRunning("win32", { SystemRoot: process.env.SystemRoot })).toBe(true);
    } finally {
      child.kill();
    }
  });
});
