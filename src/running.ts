import { spawnSync } from "node:child_process";
import { basename, win32 } from "node:path";

/**
 * Whether Claude Code is running: it rewrites ~/.claude.json while it runs, so a change made meanwhile
 * could be lost or lose its state. CLAUDECODE is set in what Claude Code itself starts. Otherwise the
 * processes are listed: with ps on macOS and Linux, and on Windows with tasklist.exe from System32,
 * by its full path and without a shell. On Windows it was always false: ps is not there, and --fix
 * could rewrite ~/.claude.json under a running Claude Code.
 */
export function claudeCodeIsRunning(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDECODE !== undefined) return true;
  if (platform === "win32") {
    // Windows' own directory, from the variable Windows sets; a value that is not a full path is not used.
    const root = env.SystemRoot !== undefined && win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
    const listed = spawnSync(win32.join(root, "System32", "tasklist.exe"), ["/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    return listed.status === 0 && tasklistHasClaude(listed.stdout);
  }
  if (platform !== "darwin" && platform !== "linux") return false;
  const listed = spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" });
  return listed.status === 0 && listed.stdout.split("\n").some((line) => basename(line.trim()) === "claude");
}

/**
 * Whether `tasklist /fo csv /nh` lists a process named claude.exe, as Windows compares names: without
 * case. That is the native Claude Code. What it cannot see: a Claude Code installed with npm runs as
 * node.exe (with its cli.js), and one in WSL runs inside Linux; neither has its name in the list.
 * Claude Desktop's own program is claude.exe too, and counts: --fix then leaves ~/.claude.json as it
 * is and says how to change it, the safe side of the mistake.
 */
export function tasklistHasClaude(csv: string): boolean {
  return csv.split(/\r?\n/).some((line) => /^"([^"]*)"/.exec(line)?.[1]?.toLowerCase() === "claude.exe");
}
