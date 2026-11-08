// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

/*
 * Where mcpcage asks Windows for its places (see windowsSources): the object manager's \SystemRoot
 * link for Windows' own directory, and the registry through the reg.exe there, started with no
 * environment and from that directory, so that nothing of the client's environment or directory
 * reaches it; each key asked once. reg.exe and the link are answered here, as Windows would.
 */

const spawned = vi.hoisted(() => [] as Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>);
const answers = vi.hoisted(() => ({ systemRoot: "D:\\Windows" as string, folders: "" }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  const spawnSync = (file: string, args: readonly string[], options: Record<string, unknown>) => {
    spawned.push({ file, args, options });
    if (args[1] === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion") return { status: 0, stdout: "\r\n    ProgramFilesDir    REG_SZ    D:\\Programs\r\n", stderr: "" };
    if (args[1]!.endsWith("User Shell Folders") && answers.folders !== "") return { status: 0, stdout: answers.folders, stderr: "" };
    return { status: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
  };
  return { ...original, spawnSync, default: { ...original, spawnSync } };
});

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  const realpathSync = Object.assign((...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args), {
    native: (path: string) => (path === "\\\\?\\GLOBALROOT\\SystemRoot" ? answers.systemRoot : fs.realpathSync.native(path)),
  });
  return { ...fs, realpathSync, default: { ...fs, realpathSync } };
});

const { windowsPlaces, windowsRedirectedAppData, windowsSources } = await import("../src/windows-places.js");
const { uvPlacesHere } = await import("../src/uv-settings.js");
const { onWindows } = await import("./fake-programs.js");

const FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

describe("Windows' places, asked of Windows", () => {
  it("reads the registry with the reg.exe of Windows' own directory, with no environment, from that directory, each key once", () => {
    spawned.length = 0;
    const sources = windowsSources();
    expect(sources.windows).toBe("D:\\Windows");
    expect(sources.registry("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion")).toBe("\r\n    ProgramFilesDir    REG_SZ    D:\\Programs\r\n");
    expect(sources.registry("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion")).toContain("D:\\Programs");
    // A key reg.exe cannot read is no value, and is not asked again either.
    expect(sources.registry(FOLDERS)).toBeUndefined();
    expect(sources.registry(FOLDERS)).toBeUndefined();
    expect(spawned).toEqual([
      { file: "D:\\Windows\\System32\\reg.exe", args: ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion", "/reg:64"], options: expect.objectContaining({ encoding: "utf8", env: {}, cwd: "D:\\Windows", windowsHide: true }) },
      { file: "D:\\Windows\\System32\\reg.exe", args: ["query", FOLDERS, "/reg:64"], options: expect.objectContaining({ env: {}, cwd: "D:\\Windows", windowsHide: true }) },
    ]);
  });

  it("takes Windows' own directory only as a path on a drive, else where Windows puts it", () => {
    answers.systemRoot = "\\\\?\\Volume{1b3a}\\Windows";
    try {
      expect(windowsSources().windows).toBe("C:\\Windows");
      answers.systemRoot = "\\\\?\\D:\\Windows";
      expect(windowsSources().windows).toBe("C:\\Windows");
    } finally {
      answers.systemRoot = "D:\\Windows";
    }
  });

  it("gives the places and the user's AppData on a share once for the whole run", () => {
    answers.folders = "\r\n    AppData    REG_EXPAND_SZ    \\\\fs01\\profiles$\\me\\AppData\\Roaming\r\n";
    spawned.length = 0;
    expect(windowsRedirectedAppData()).toBe("\\\\fs01\\profiles$\\me\\AppData\\Roaming");
    expect(windowsPlaces()).toMatchObject({ SystemRoot: "D:\\Windows", ProgramFiles: "D:\\Programs", APPDATA: expect.stringMatching(/AppData\\Roaming$/) });
    expect(windowsRedirectedAppData()).toBe("\\\\fs01\\profiles$\\me\\AppData\\Roaming");
    windowsPlaces();
    // The two keys, each once: the sources and their answers are kept.
    expect(spawned.map((call) => call.args[1])).toEqual([FOLDERS, "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion"]);
    // The places where uv's settings are looked for on Windows: Windows' own, and the share.
    const places = onWindows(() => uvPlacesHere());
    expect(places.windows).toStrictEqual({ appData: windowsPlaces().APPDATA, programData: "D:\\ProgramData", redirected: "\\\\fs01\\profiles$\\me\\AppData\\Roaming" });
    // Elsewhere none.
    if (process.platform !== "win32") expect(uvPlacesHere().windows).toBeUndefined();
  });
});
