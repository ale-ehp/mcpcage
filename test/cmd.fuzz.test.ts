import { spawn } from "node:child_process";
import { copyFileSync, linkSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { cmdRunner } from "../src/launch.js";
import { checkAsync, TIMEOUT } from "./fuzz.js";

/*
 * cmdRunner says which `cmd /c npx ...` and `cmd /c uvx ...` lines run npx or uvx with exactly the
 * words after /c, so that mcpcage can run them without cmd. Only cmd.exe itself can say whether that
 * holds: this test starts each line as a client does (child_process.spawn, no shell), with an npx.cmd
 * that ends as npm's does (`"%NODE_EXE%" "%NPX_CLI_JS%" %*`) and prints the arguments node gives it,
 * and a uvx.exe, and compares them with what cmdRunner says the runner is given. Windows only:
 * elsewhere there is no cmd.exe to ask.
 */

let probe: string;

beforeAll(() => {
  if (process.platform !== "win32") return;
  probe = mkdtempSync(join(tmpdir(), "mcpcage-npx-probe-"));
  writeFileSync(join(probe, "probe.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  // npm's npx.cmd, without the lookup of npm's prefix that comes before its last line: the arguments
  // reach node only through that line, where cmd expands %* and reads the result again.
  writeFileSync(
    join(probe, "npx.cmd"),
    [
      "@ECHO OFF",
      "SETLOCAL",
      `SET "NODE_EXE=${process.execPath}"`,
      'SET "NPX_CLI_JS=%~dp0\\probe.js"',
      '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
      "",
    ].join("\r\n"),
  );
  // uv's uvx.exe is a program, not a batch file: cmd starts it with the line as it is, and the
  // program splits it into arguments. The node running the tests, under that name and given
  // probe.js first, splits it by the same rules of Windows' C runtime and prints what it got.
  try {
    linkSync(process.execPath, join(probe, "uvx.exe"));
  } catch {
    copyFileSync(process.execPath, join(probe, "uvx.exe"));
  }
});

/** Runs `argv` as a client does, from the probe's directory with it first on the PATH, and returns what npx printed. */
function run(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Windows spells it Path: a second PATH next to it would leave which one counts to chance.
    const name = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const child = spawn(argv[0]!, argv.slice(1), { cwd: probe, env: { ...process.env, [name]: `${probe}${delimiter}${process.env[name] ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A character of an argument: mostly ordinary, then what cmd, the batch file or node's parser may read. */
const char = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(..."abcxyzABC0189-_.@/:+~#$'`{}[]*?") },
  { weight: 3, arbitrary: fc.constantFrom(" ", "\\", ",", ";", "=") },
  { weight: 2, arbitrary: fc.constantFrom("\u00e9", "\u00ff", "\u00a0", "\u3000", "\u2028", "\u0301", "\u4e2d", "\u{1f600}", "\uff06", "\uff1c", "\u00bb") },
  { weight: 1, arbitrary: fc.constantFrom("&", "|", "<", ">", "^", "%", "!", '"', "(", ")", "\t", "\n") },
);
const argument = fc.array(char, { minLength: 0, maxLength: 8 }).map((chars) => chars.join(""));

const line = fc.record({
  cmd: fc.constantFrom("cmd", "cmd.exe", "CMD", "C:\\Windows\\System32\\cmd.exe"),
  switches: fc.subarray(["/d", "/s"]),
  c: fc.constantFrom("/c", "/C"),
  runner: fc.constantFrom("npx", "npx.cmd", "NPX", "Npx.Cmd", "uvx", "uvx.exe", "UVX", "Uvx.Exe"),
  args: fc.array(argument, { maxLength: 5 }),
});

describe.runIf(process.platform === "win32")("cmd /c npx and cmd /c uvx, against cmd.exe", () => {
  it(
    "gives npx or uvx exactly the words cmdRunner says, for every line cmdRunner takes for a plain one",
    async () => {
      let compared = 0;
      await checkAsync(
        fc.asyncProperty(line, async ({ cmd, switches, c, runner, args }) => {
          const uvx = /^uvx/i.test(runner);
          const argv = [cmd, ...switches, c, runner, ...(uvx ? ["probe.js"] : []), ...args];
          const read = cmdRunner(argv, "win32");
          if (read === undefined || !("line" in read)) return;
          compared++;
          expect(read.runner).toBe(uvx ? "uvx" : "npx");
          const answer = await run(argv);
          expect(answer.code, `${JSON.stringify(argv)}: ${answer.stderr}`).toBe(0);
          expect(JSON.parse(answer.stdout), JSON.stringify(argv)).toEqual(read.line.slice(uvx ? 2 : 1));
        }),
        150,
        20,
      );
      // Most lines are plain: the comparison is not empty.
      expect(compared).toBeGreaterThan(30);
    },
    TIMEOUT,
  );
});
