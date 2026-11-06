import type * as Fs from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * mcpcage never looks at a network path a configuration entry names or derives (see networkPath):
 * on Windows looking at a share connects to its server and authenticates with the user's
 * credentials. Every call of node:fs these tests reach is recorded, with the path it was given,
 * and none may be a network path. On macOS and Linux the code reads Windows paths with the host's
 * rules, so the spellings with a slash first are the ones that reach node:fs here, as all of them
 * do on Windows.
 */
const touched: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  const record = <T extends (...args: never[]) => unknown>(call: T): T =>
    ((...args: Parameters<T>) => {
      if (typeof args[0] === "string") touched.push(args[0]);
      return call(...args);
    }) as T;
  const realpathSync = Object.assign(record(fs.realpathSync), { native: record(fs.realpathSync.native) });
  const spied = {
    ...fs,
    existsSync: record(fs.existsSync),
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

const { networkPath, NETWORK_PATH } = await import("../src/network-path.js");
const { envFileOf, mcpcageAt, foreignPath } = await import("../src/installed.js");
const { hostPath, wrapEntry } = await import("../src/config.js");
const { parseLaunch } = await import("../src/launch.js");
const { dockerProgram, parseMount, sensitiveMount, withSettingsReadOnly } = await import("../src/sandbox.js");
const { sensitivePath, thisMachine } = await import("../src/sensitive.js");
const { entryUvSettingsReason, uvSettingsReason } = await import("../src/uv-settings.js");
const { fixConfigs, renderReport, scanConfigs } = await import("../src/protect.js");
const { redirectedAppData, windowsEnv } = await import("../src/windows-places.js");
const { onWindows, onWindowsUntilDone } = await import("./fake-programs.js");

/** Whether these tests run on Windows itself, whatever onWindows makes process.platform say. */
const ON_WINDOWS = process.platform === "win32";

/** Runs `run` as mcpcage would on `platform`. */
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

/** The network paths of `platform` among those node:fs was given since the test started. */
const reached = (platform: NodeJS.Platform) => touched.filter((path) => networkPath(path, platform));

// Every spelling of a share or a device Windows takes: backslashes, slashes, both, the long forms.
const WINDOWS = ["\\\\server\\share\\x", "//server/share/x", "\\\\?\\UNC\\server\\share\\x", "\\\\.\\pipe\\x", "\\\\?\\C:\\x", "/\\server\\share\\x", "\\/server/share/x", "//?/UNC/server/share/x"];

beforeEach(() => {
  touched.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a network path, as mcpcage tells one", () => {
  it("on Windows, any path that starts with two slashes or backslashes, in any mix", () => {
    for (const path of [...WINDOWS, "\\\\", "//", "\\/"]) expect(networkPath(path, "win32"), path).toBe(true);
    for (const path of ["C:\\x", "c:/x", "\\x", "/x", "x"]) expect(networkPath(path, "win32"), path).toBe(false);
  });

  it("on macOS, a path under /net/<host>, the automounter's -hosts map, written any way the system reads it", () => {
    for (const path of ["/net/host/x", "/NET/host", "//net/host", "/net/../net/host/x", "/./net/host"]) expect(networkPath(path, "darwin"), path).toBe(true);
    for (const path of ["/net", "/net/", "/network/host", "/Users/me/net/host", "host/net/x"]) expect(networkPath(path, "darwin"), path).toBe(false);
    // Linux has no such default, and on Windows //net/host is a share like any other.
    expect([networkPath("/net/host", "linux"), networkPath("//server/share", "linux"), networkPath("//net/host", "win32")]).toEqual([false, false, true]);
  });
});

describe("what an entry names on a network path, never looked at", () => {
  it("its envFile: unknown, never read, and said without its value", () => {
    onWindows(() => {
      for (const path of WINDOWS) {
        const found = envFileOf({ command: "npx", envFile: path }, "C:\\work\\.vscode\\mcp.json");
        expect(found?.variables, path).toBeUndefined();
        // On this machine a path is absolute by its rules: the others are no file to it, and unknown as well.
        if (isAbsolute(path)) expect(found, path).toEqual({ path, network: true });
      }
      // ${workspaceFolder} is filled in first, and the result is what counts: a project on a share.
      // (On macOS and Linux //server/share is /server/share, a local path, which this does not test.)
      if (ON_WINDOWS) {
        expect(envFileOf({ command: "npx", envFile: "${workspaceFolder}/.env" }, "\\\\server\\share\\work\\.vscode\\mcp.json")).toEqual({ path: "${workspaceFolder}/.env", network: true });
      }
    });
    expect(reached("win32")).toEqual([]);
  });

  it("its command, and the node and the cli.js it starts: not known to be mcpcage", () => {
    onWindows(() => {
      for (const path of WINDOWS) {
        expect(mcpcageAt({ command: `${path}\\mcpcage.exe`, args: ["run", "--", "npx", "-y", "x"] }), path).toBe("other program");
        expect(mcpcageAt({ command: `${path}\\node.exe`, args: [`${path}\\cli.js`, "run", "--", "npx", "-y", "x"] }), path).toBe("other program");
        expect(mcpcageAt({ command: process.execPath, args: [`${path}\\cli.js`, "run", "--", "npx", "-y", "x"] }), path).toBe("other program");
      }
    });
    // On macOS a bare name is looked up in the entry's PATH, and a directory under /net is not looked in.
    expect(onPlatform("darwin", () => mcpcageAt({ command: "mcpcage", args: ["run", "--", "npx", "-y", "x"], env: { PATH: "/net/host/bin:/usr/bin" } }))).toBe("other program");
    expect([...reached("win32"), ...reached("darwin")]).toEqual([]);
  });

  it("the directories of its PATH: compared as written", () => {
    onWindows(() => {
      for (const path of WINDOWS) expect(foreignPath({ PATH: path })?.dirs.length, path).toBeGreaterThan(0);
    });
    expect(reached("win32")).toEqual([]);
  });

  it("its args: wrap and --fix leave the entry, and nothing mounts or inspects such a path", () => {
    onWindows(() => {
      for (const path of WINDOWS) {
        expect(hostPath(path), path).toBe(path);
        expect(wrapEntry({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", path] }, { command: "mcpcage" }), path).toEqual({ skip: `one of its args is ${NETWORK_PATH}` });
        // Their answers are those of the path as written: what matters here is that nothing looked.
        sensitivePath(path, thisMachine());
        sensitiveMount(path);
        expect(() => parseMount(`${path}:rw`), path).toThrow(/^--mount: /);
        expect(() => parseLaunch(["npx", "-y", path], undefined, "win32"), path).toThrow(new Error(`the package after npx is ${NETWORK_PATH}`));
      }
    });
    // macOS: /net/<host> is refused by run as it is written.
    onPlatform("darwin", () => {
      expect(hostPath("/net/host/notes")).toBe("/net/host/notes");
      expect(() => parseMount("/net/host/notes")).toThrow(new Error(`--mount: ${NETWORK_PATH}`));
      expect(sensitiveMount("/net/host/notes")).toBeUndefined();
    });
    expect([...reached("win32"), ...reached("darwin")]).toEqual([]);
  });

  it("the uv settings its variables point uvx to, never read from an entry; the user's own redirected AppData is", () => {
    const windows = { appData: "C:\\Users\\me\\AppData\\Roaming", programData: "C:\\ProgramData" };
    for (const path of WINDOWS) {
      for (const name of ["APPDATA", "USERPROFILE", "PROGRAMDATA", "SYSTEMDRIVE"]) {
        expect(entryUvSettingsReason([{ where: "its env", variables: { [name]: path } }], "win32", "C:\\Users\\me"), `${name} ${path}`).toBe(`its env sets ${name} to ${NETWORK_PATH}, and the cage builds from PyPI only`);
      }
      // `run` cannot tell an entry's APPDATA from the user's: a share is read only when it is the user's AppData, as the registry gives it.
      expect(uvSettingsReason({ platform: "win32", env: { APPDATA: path }, home: "C:\\Users\\me", windows }), path).toBe(`your environment sets APPDATA to ${NETWORK_PATH}, and the cage builds from PyPI only`);
      expect(uvSettingsReason({ platform: "win32", env: { UV_CONFIG_FILE: path }, home: "C:\\Users\\me", windows }), path).toBe(`your environment sets UV_CONFIG_FILE to ${NETWORK_PATH}, and the cage builds from PyPI only`);
    }
    expect(onPlatform("darwin", () => entryUvSettingsReason([{ where: "its env", variables: { HOME: "/net/host/home" } }], "darwin", "/Users/me"))).toBe(`its env sets HOME to ${NETWORK_PATH}, and the cage builds from PyPI only`);
    expect(reached("win32")).toEqual([]);
    expect(reached("darwin")).toEqual([]);
    // The user's own AppData redirected to a share, as Windows gives it to every program of the session, is theirs: read.
    const share = "\\\\fs01\\profiles$\\me\\AppData\\Roaming";
    expect(uvSettingsReason({ platform: "win32", env: { APPDATA: share }, home: "C:\\Users\\me", windows: { ...windows, redirected: share } })).toBeUndefined();
    expect(reached("win32")).toEqual([`${share}\\uv\\uv.toml`]);
  });

  it("reads the user's own AppData on a share where the registry puts it, with %USERNAME% from the account", () => {
    const folders = (value: string) => ({
      windows: "C:\\Windows",
      home: "C:\\Users\\me",
      user: "me",
      registry: (key: string) => (key.endsWith("User Shell Folders") ? `\r\n    AppData    REG_EXPAND_SZ    ${value}\r\n` : undefined),
    });
    expect(redirectedAppData(folders("\\\\fs01\\profiles$\\%USERNAME%\\AppData\\Roaming"))).toBe("\\\\fs01\\profiles$\\me\\AppData\\Roaming");
    // On a drive it is APPDATA's (see windowsEnv); a device path, or a variable mcpcage does not know, is no share of the user's.
    for (const value of ["%USERPROFILE%\\AppData\\Roaming", "\\\\?\\UNC\\fs01\\me", "\\\\.\\pipe\\x", "%HOMESHARE%\\AppData", "\\\\fs01"]) {
      expect(redirectedAppData(folders(value)), value).toBeUndefined();
    }
    // docker and npm keep the folder's default place for a share, as before.
    expect(windowsEnv(folders("\\\\fs01\\profiles$\\%USERNAME%\\AppData\\Roaming")).APPDATA).toBe("C:\\Users\\me\\AppData\\Roaming");
    expect(touched).toEqual([]);
  });

  it("a directory of the PATH `run` looks for docker in", () => {
    vi.stubEnv("PATH", "//server/share/bin");
    onWindows(() => dockerProgram());
    // Windows' own directory, which mcpcage asks Windows for (see windowsSources), is no entry's.
    expect(reached("win32").filter((path) => path !== "\\\\?\\GLOBALROOT\\SystemRoot")).toEqual([]);
  });

  it("the repository a .git file in a writable mount names, under /net", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-network-git-"));
    const project = join(top, "work");
    mkdirSync(project);
    writeFileSync(join(project, ".git"), "gitdir: /net/host/repo\n");
    const mount = { source: project, target: project, readOnly: false };
    // On macOS and Windows a .git file in a writable mount is refused before it is followed (another
    // case of its name): its pointer is followed on Linux, read here as if /net were macOS's.
    expect(() => onPlatform("darwin", () => withSettingsReadOnly([mount], undefined, "linux"))).toThrow(`cannot follow ${join(project, ".git")} to the repository it names (it leads to ${NETWORK_PATH})`);
    expect(reached("darwin")).toEqual([]);
  });

  it("protect does not count such an entry as caged, says which field, and --fix leaves it", async () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-network-scan-"));
    const file = join(top, "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "@acme/notes-mcp"], envFile: "//server/share/.env" } } }));
    const location = { client: "cursor" as const, clientName: "Cursor", scope: "user" as const, file, key: "mcpServers" as const, jsonc: false, exists: true };
    const noNpm = () => ({ status: 0, stdout: "", stderr: "" });
    const report = await onWindowsUntilDone(() => scanConfigs({ locations: [location], home: top, offline: true, cacheDir: join(top, "cache"), npmRunner: noNpm }));
    const text = renderReport(report, { home: top });
    expect(text).toContain(`envFile: ${NETWORK_PATH}, so what it sets is unknown`);
    expect(text).not.toContain("//server/share");
    const plan: string[] = [];
    onWindows(() => fixConfigs({ report, command: join(top, "mcpcage.exe"), claudeCodeRunning: false, dryRun: true, home: top, log: (line) => plan.push(line) }));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(/^ {2}not changed: files in /);
    expect(plan[0]).toContain(`: its envFile is ${NETWORK_PATH}, so what it sets is unknown: check that file, or move what it sets into its "env"`);
    expect(reached("win32")).toEqual([]);
  });
});
