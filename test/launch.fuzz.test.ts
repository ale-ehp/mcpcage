import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serverType } from "../src/config.js";
import { cmdNpx, isNpx, npxArgv, parseLaunch, serverIdFor, splitPackageSpec } from "../src/launch.js";
import { anyText, check, TIMEOUT } from "./fuzz.js";

/*
 * What a server's command line is, decided from text a configuration holds: npx and its package, or
 * on Windows `cmd /c npx ...`, which cmd.exe reads before npx does. A line taken for plain npx is run
 * without cmd, so it must hold nothing cmd would have read differently.
 */

/** Words of a command line: npx's flags, package specs, cmd's switches, and the characters cmd reads. */
const word = fc.oneof(
  { weight: 3, arbitrary: anyText(12) },
  { weight: 3, arbitrary: fc.constantFrom("npx", "NPX", "npx.cmd", "C:\\nodejs\\npx.cmd", "-y", "--yes", "-q", "-p", "--package=x", "-c", "--", "@acme/notes-mcp", "@acme/notes-mcp@1.2.3", "@scope", "pkg@", "./x", ".\\x", "C:\\x", "x.tgz", "~/x") },
  { weight: 2, arbitrary: fc.constantFrom("/c", "/C", "/d", "/s", "/D", "/q", "/k", "/c npx", "npx&calc", "a b", "a\tb", "", "%PATH%", "!x!", "^", "(", ")", '"', "<", ">", "|", "&", "\u00a0", "\u3000", ",", ";", "=") },
);

const CMD = fc.constantFrom("cmd", "cmd.exe", "CMD.EXE", "C:\\Windows\\System32\\cmd.exe", "c:/windows/system32/cmd.exe", ".\\cmd.exe", "cmd.com", "xcmd");

/** What cmd reads itself in the line after /c (see CMD_READS in launch.ts), and what ends its line. */
const CMD_SPECIAL = /[&|<>^%!"()\u0000-\u001f\u007f]/;

describe("command lines, fuzzed", () => {
  it(
    "are read as npx, a container image or a host command, or refused with a plain error",
    () => {
      check(
        fc.property(fc.array(word, { minLength: 0, maxLength: 6 }), fc.constantFrom<NodeJS.Platform>("darwin", "linux", "win32"), (argv, platform) => {
          let spec;
          try {
            spec = parseLaunch(argv, undefined, platform);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).constructor).toBe(Error);
            return;
          }
          if (spec.kind === "npm") {
            const line = npxArgv(argv, platform)!;
            expect(line).toBeDefined();
            // The server's own arguments end the npx line, and its package is named or local.
            expect(line.slice(line.length - spec.args.length)).toEqual(spec.args);
            expect(spec.packageName !== "" || spec.localPath !== undefined).toBe(true);
            if (spec.packageName !== "") expect(splitPackageSpec(spec.packageName).name).toBe(spec.packageName);
          } else {
            expect(spec).toEqual({ kind: "host", command: argv[0], args: argv.slice(1) });
          }
          expect(serverIdFor(spec)).toMatch(/^[a-z0-9-]{1,40}-[0-9a-f]{8}$/);
        }),
        2000,
      );
    },
    TIMEOUT,
  );

  it(
    "take a cmd /c line for plain npx only when cmd would hand npx exactly its words",
    () => {
      check(
        fc.property(CMD, fc.array(fc.constantFrom("/d", "/s", "/D", "/S", "/q", "/k"), { maxLength: 2 }), fc.constantFrom("/c", "/C", "/k"), fc.array(word, { minLength: 0, maxLength: 5 }), (cmd, switches, c, line) => {
          const argv = [cmd, ...switches, c, ...line];
          const read = cmdNpx(argv, "win32");
          expect(cmdNpx(argv, "darwin")).toBeUndefined();
          if (read === undefined || !("npx" in read)) {
            expect(serverType({ command: cmd, args: argv.slice(1) }, "win32")).not.toBe("npx");
            return;
          }
          expect(read.npx).toEqual(line);
          expect(isNpx(line[0]!, "win32")).toBe(true);
          expect(/^\/c$/i.test(c)).toBe(true);
          expect(switches.every((option) => /^\/[ds]$/i.test(option))).toBe(true);
          for (const part of line) {
            expect(part).not.toBe("");
            expect(part, JSON.stringify(part)).not.toMatch(CMD_SPECIAL);
          }
          // The program cmd starts is the first word whole: nothing in it ends a program's name for cmd.
          expect(line[0]).not.toMatch(/[\s,;=]/);
          expect(serverType({ command: cmd, args: argv.slice(1) }, "win32")).toBe("npx");
        }),
        2000,
      );
    },
    TIMEOUT,
  );
});
