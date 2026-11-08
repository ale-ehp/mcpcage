// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import type * as Fs from "node:fs";
import type * as Path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { anyText, check, TIMEOUT } from "./fuzz.js";

/*
 * On Windows a path that starts with two slashes or backslashes, in any mix, reaches another machine
 * when anything looks at it (see networkPath): Windows connects to the server and authenticates with
 * the user's credentials. Whatever follows those two characters, mcpcage must take the path for a
 * network path, and none of its entry points may hand it to node:fs; a path on a drive, or a relative
 * one, is no network path. Every call of node:fs is recorded with its path, as in
 * test/network-paths.test.ts, and a network path is answered as a file that is not there, without
 * asking the system. node:path follows Windows' rules while the code runs as on Windows (see
 * asWindows), as it does there: by the host's rules on macOS, a PATH of \\C:/./\server was split at
 * its colon, and /./\server/docker.exe, which Windows would never be asked for, reached node:fs.
 */
const touched: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  const network = (path: string) => /^[\\/]{2}/.test(path);
  const notThere = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT", path });
  const record = <T extends (...args: never[]) => unknown>(call: T, absent: (path: string) => unknown = (path) => { throw notThere(path); }): T =>
    ((...args: Parameters<T>) => {
      if (typeof args[0] === "string") {
        touched.push(args[0]);
        if (network(args[0])) return absent(args[0]);
      }
      return call(...args);
    }) as T;
  const realpathSync = Object.assign(record(fs.realpathSync), { native: record(fs.realpathSync.native) });
  const spied = {
    ...fs,
    existsSync: record(fs.existsSync, () => false),
    statSync: record(fs.statSync),
    lstatSync: record(fs.lstatSync),
    accessSync: record(fs.accessSync),
    openSync: record(fs.openSync),
    readFileSync: record(fs.readFileSync),
    readdirSync: record(fs.readdirSync),
    readlinkSync: record(fs.readlinkSync),
    copyFileSync: record(fs.copyFileSync),
    realpathSync,
  };
  return { ...spied, default: spied };
});

/** Whether node:path follows Windows' rules, whatever the host's are (see asWindows). */
const pathRules = vi.hoisted(() => ({ windows: false }));

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof Path>();
  const rules = (): typeof Path => (pathRules.windows ? path.win32 : path);
  const following: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(path)) {
    if (name === "default") continue;
    if (name === "posix" || name === "win32") following[name] = value;
    else if (typeof value === "function") following[name] = (...args: unknown[]) => (rules()[name as keyof typeof Path] as (...given: unknown[]) => unknown)(...args);
    else Object.defineProperty(following, name, { enumerable: true, get: () => rules()[name as keyof typeof Path] });
  }
  Object.defineProperty(following, "default", { enumerable: true, value: following });
  return following;
});

const { networkPath, NETWORK_PATH } = await import("../src/network-path.js");
const { envFileOf, mcpcageAt, foreignPath } = await import("../src/installed.js");
const { hostPath, wrapEntry } = await import("../src/config.js");
const { parseLaunch } = await import("../src/launch.js");
const { dockerProgram, parseMount, sensitiveMount } = await import("../src/sandbox.js");
const { sensitivePath, thisMachine } = await import("../src/sensitive.js");
const { entryUvSettingsReason, uvSettingsReason } = await import("../src/uv-settings.js");
const { onWindows } = await import("./fake-programs.js");

/** Runs `run` as mcpcage would on Windows, node:path with Windows' rules too. */
function asWindows<T>(run: () => T): T {
  pathRules.windows = true;
  try {
    return onWindows(run);
  } finally {
    pathRules.windows = false;
  }
}

/** What may follow the start of a path: names of shares and devices, drive letters, dots, variables, any text. */
const segment = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("server", "fs01", "share", "profiles$", "c$", "?", ".", "..", "UNC", "C:", "pipe", "GLOBALROOT", "localhost", "x y", "", "\u00e9", "%USERNAME%", "${workspaceFolder}") },
  { weight: 1, arbitrary: anyText(6) },
);
const separator = fc.constantFrom("\\", "/");
const rest = fc.array(fc.tuple(segment, separator), { maxLength: 5 }).map((parts) => parts.map(([name, sep]) => `${name}${sep}`).join(""));

/** Two slashes or backslashes in any mix, then anything. */
const network = fc.tuple(separator, separator, rest, segment).map(([first, second, middle, last]) => `${first}${second}${middle}${last}`);

/** A path on a drive (absolute, or relative to the drive's current directory), and a relative path or one from the current drive's root. */
const drive = fc.tuple(fc.constantFrom("C", "c", "D", "z"), fc.constantFrom(":", ":\\", ":/"), rest, segment).map(([letter, colon, middle, last]) => `${letter}${colon}${middle}${last}`);
const relative = fc
  .tuple(fc.constantFrom("", "\\", "/", ".\\", "./", "..\\"), rest, segment)
  .map(([start, middle, last]) => `${start}${middle}${last}`)
  .filter((path) => !/^[\\/]{2}/.test(path));

/** Windows' own directory, which mcpcage asks Windows for when it looks for docker (see windowsSources in sandbox.ts): no entry's. */
const WINDOWS_OWN = "\\\\?\\GLOBALROOT\\SystemRoot";

/** The network paths among those node:fs was given, but Windows' own directory. */
const reached = () => touched.filter((path) => networkPath(path, "win32") && path !== WINDOWS_OWN);

const SETTINGS = ["APPDATA", "USERPROFILE", "PROGRAMDATA", "SYSTEMDRIVE"];

describe("network paths on Windows, fuzzed", () => {
  it(
    "every path that starts with two slashes or backslashes is one; a path on a drive, or a relative one, is not",
    () => {
      check(
        fc.property(network, drive, relative, (path, onDrive, other) => {
          expect(networkPath(path, "win32"), path).toBe(true);
          expect(networkPath(onDrive, "win32"), onDrive).toBe(false);
          expect(networkPath(other, "win32"), other).toBe(false);
        }),
        1000,
      );
    },
    TIMEOUT,
  );

  it(
    "no entry point hands one to node:fs, wherever an entry names it",
    () => {
      const home = "C:\\Users\\me";
      const windows = { appData: `${home}\\AppData\\Roaming`, programData: "C:\\ProgramData" };
      const machine = asWindows(() => thisMachine());
      check(
        fc.property(network, fc.constantFrom(...SETTINGS), (path, variable) => {
          touched.length = 0;
          asWindows(() => {
            // Its envFile, its command, the node and the cli.js it starts, the directories of its PATH.
            expect(envFileOf({ command: "npx", envFile: path }, "C:\\work\\.vscode\\mcp.json")?.variables, path).toBeUndefined();
            expect(mcpcageAt({ command: `${path}\\mcpcage.exe`, args: ["run", "--", "npx", "-y", "x"] }), path).toBe("other program");
            expect(mcpcageAt({ command: process.execPath, args: [`${path}\\cli.js`, "run", "--", "npx", "-y", "x"] }), path).toBe("other program");
            expect(mcpcageAt({ command: "mcpcage", args: ["run", "--", "npx", "-y", "x"], env: { PATH: `${path};C:\\Windows` } }), path).toBe("other program");
            foreignPath({ PATH: path });
            // Its args: wrap and --fix never cage an entry that would mount one, run never mounts or packs one.
            hostPath(path);
            const wrapped = wrapEntry({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", path] }, { command: "mcpcage" });
            expect("skip" in wrapped, path).toBe(true);
            sensitivePath(path, machine);
            sensitiveMount(path);
            expect(() => parseMount(`${path}:rw`), path).toThrow(/^--mount: /);
            expect(() => parseLaunch(["npx", "-y", path], undefined, "win32"), path).toThrow(new Error(`the package after npx is ${NETWORK_PATH}`));
            // The uv settings its variables, or the user's, point uvx to.
            // Each stops the cage, named, whatever the path holds: a host without a share too.
            expect(entryUvSettingsReason([{ where: "its env", variables: { [variable]: path } }], "win32", home), path).toBe(`its env sets ${variable} to ${NETWORK_PATH}, and the cage builds from PyPI only`);
            expect(uvSettingsReason({ platform: "win32", env: { [variable]: path }, home, windows }), path).toBe(`your environment sets ${variable} to ${NETWORK_PATH}, and the cage builds from PyPI only`);
            expect(uvSettingsReason({ platform: "win32", env: { UV_CONFIG_FILE: path }, home, windows }), path).toBe(`your environment sets UV_CONFIG_FILE to ${NETWORK_PATH}, and the cage builds from PyPI only`);
            // The PATH `run` looks for docker in, which holds the entry's. Only for this call: mcpcage
            // looks in the user's own PATH for itself (see onPath in installed.ts), whatever it holds.
            vi.stubEnv("PATH", path);
            try {
              dockerProgram();
            } finally {
              vi.unstubAllEnvs();
            }
          });
          expect(reached(), path).toEqual([]);
        }),
        100,
        4,
      );
    },
    TIMEOUT,
  );
});
