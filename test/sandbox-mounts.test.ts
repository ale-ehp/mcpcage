// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cagePath, dockerProgram, hostMount, NOT_ON_A_DRIVE, parseMount, runArgs, SETTINGS_LIMITS, withSettingsReadOnly, type Mount } from "../src/sandbox.js";
import { onWindows } from "./fake-programs.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ro = (path: string): Mount => ({ source: path, target: path, readOnly: true });
const rw = (path: string): Mount => ({ source: path, target: path, readOnly: false });
const windowsHost = process.platform === "win32";
const asRoot = process.getuid?.() === 0;

/**
 * The message of what `run` threw, which must be an Error: vitest's toThrow(message) passes when
 * the value thrown is undefined or null, whatever the message expected.
 */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("nothing was thrown");
}

/** A directory of this system, as the system spells it, with the given files and empty directories (names ending in /). */
function layout(entries: Record<string, string>): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mcpcage-mounts-")));
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(join(dir, path.endsWith("/") ? path : join(path, "..")), { recursive: true });
    if (!path.endsWith("/")) writeFileSync(join(dir, path), text.replaceAll("<dir>", dir));
  }
  return dir;
}

/** How `refuse` in withSettingsReadOnly words a refusal of the writable mount `dir`. */
const refused = (dir: string, problem: string, remedy: string) => `--mount ${dir}:rw: ${problem}. ${remedy}, or mount ${dir} read-only by dropping :rw.`;
const settings = (mounts: Mount[], platform: NodeJS.Platform = "linux") => withSettingsReadOnly(mounts, SETTINGS_LIMITS, platform);
const byTarget = (mounts: Mount[]) => [...mounts].sort((left, right) => left.target.localeCompare(right.target));

describe("the docker run command line", () => {
  const base = { serverId: "notes-1a2b3c4d", spec: { kind: "npm" as const, packageName: "p", args: ["--dir", "/data"] }, mounts: [], env: [], allowNet: false, memory: "512m", cpus: "1", keepImageUser: false };

  it("is every option of the cage, in full", () => {
    const args = runArgs(base, "sha256:image", "linux");
    expect(args[7]).toMatch(/^mcpcage-notes-1a2b3c4d-[0-9a-f]{6}$/);
    expect(args.toSpliced(7, 1, "<name>")).toEqual([
      "run", "--rm", "-i", "--init",
      "--pull", "never",
      "--name", "<name>",
      "--label", "mcpcage.server=notes-1a2b3c4d",
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "128",
      "--memory", "512m",
      "--memory-swap", "512m",
      "--cpus", "1",
      "--ipc", "none",
      "--hostname", "mcpcage",
      "-e", "HOME=/tmp",
      "--user", "65532:65532",
      "sha256:image", "--dir", "/data",
    ]);
    // The image's own user only when asked for.
    expect(runArgs({ ...base, keepImageUser: true }, "sha256:image", "linux")).not.toContain("--user");
  });

  it.skipIf(windowsHost)("gives the server mcpcage's PATH, and every other variable by its name alone, on macOS and Linux", () => {
    vi.stubEnv("Path", "/elsewhere");
    expect(runArgs({ ...base, env: ["PATH", "TEMP", "Path", "API_KEY"] }, "img", "linux").slice(35, -3)).toEqual(["-e", `PATH=${process.env.PATH}`, "-e", "TEMP", "-e", "Path", "-e", "API_KEY"]);
  });

  it("gives the server mcpcage's own value of PATH and of Windows' places on Windows, each from its own variable", () => {
    vi.stubEnv("HOMEPATH", "\\Users\\me");
    vi.stubEnv("PATHEXT", ".COM;.EXE");
    const args = onWindows(() => runArgs({ ...base, env: ["Path", "HOMEPATH", "PATHEXT", "API_KEY"] }, "img", "win32"));
    expect(args.slice(35, -3)).toEqual(["-e", `Path=${process.env.PATH}`, "-e", "HOMEPATH=\\Users\\me", "-e", "PATHEXT=.COM;.EXE", "-e", "API_KEY"]);
  });

  it("gives a Windows server each argument in a mounted folder as its place in the cage: ~/, a path on the current drive, never a relative one", () => {
    // os.homedir() reads HOME on macOS and Linux, USERPROFILE on Windows.
    vi.stubEnv("HOME", "C:\\Users\\me");
    vi.stubEnv("USERPROFILE", "C:\\Users\\me");
    vi.spyOn(process, "cwd").mockReturnValue("C:\\work");
    const mounts = [ro("C:\\Users\\me\\notes"), ro("C:\\work")];
    const args = runArgs({ ...base, mounts, spec: { ...base.spec, args: ["~/notes", "~/notes/a b", "relative", "\\work\\x", "\\\\server\\share", "--flag"] } }, "img", "win32");
    expect(args.slice(args.indexOf("img") + 1)).toEqual(["/c/Users/me/notes", "/c/Users/me/notes/a b", "relative", "/c/work/x", "\\\\server\\share", "--flag"]);
  });
});

describe("a --mount", () => {
  it("refuses a path with a comma, which docker would read as more fields", () => {
    const dir = layout({ "a,b/": "" });
    expect(refusal(() => hostMount(join(dir, "a,b"), true))).toBe(`paths containing commas are not supported (${join(dir, "a,b")})`);
  });

  it("refuses on Windows a share before anything asks the network about it", () => {
    expect(onWindows(() => refusal(() => hostMount("\\\\server\\share", true)))).toContain(NOT_ON_A_DRIVE);
    // A drive letter after the start is no drive.
    expect(refusal(() => cagePath("\\Users\\me\\C:\\x", "win32"))).toContain(NOT_ON_A_DRIVE);
  });

  it("takes ~/ from the home directory and a relative path from the current directory", () => {
    const home = layout({ "notes/": "" });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(parseMount("~/notes")).toEqual({ source: join(home, "notes"), target: join(home, "notes"), readOnly: true });
    expect(parseMount("~/notes:rw")).toEqual({ source: join(home, "notes"), target: join(home, "notes"), readOnly: false });
    vi.spyOn(process, "cwd").mockReturnValue(home);
    expect(parseMount("notes")).toEqual({ source: join(home, "notes"), target: join(home, "notes"), readOnly: true });
  });

  it("is the directory Docker mounts when a .. follows a symlink, and the settings looked for are that directory's", () => {
    // Docker takes each `..` out of a bind mount's path as written: link/../proj is the proj next to
    // link. The system, asked for link/../proj, follows link first and finds the proj next to where
    // it leads, deep/proj. Read so, a writable mount of the repository proj got no read-only .git:
    // the settings were looked for in deep/proj, which holds none, and a server in the cage wrote
    // proj/.git/config. deep/proj's own .vscode became a read-only mount of a proj/.vscode that does
    // not exist. A link is a junction on Windows, which needs no privilege.
    const dir = layout({ "proj/.git/config": "[core]\n", "deep/a/": "", "deep/proj/.vscode/settings.json": "{}\n" });
    symlinkSync(join(dir, "deep", "a"), join(dir, "link"), "junction");
    // join would take the .. out itself.
    const written = [dir, "link", "..", "proj"].join(sep);
    const proj = join(dir, "proj");
    expect(hostMount(written, true)).toEqual(ro(proj));
    expect(parseMount(written)).toEqual(ro(proj));
    expect(parseMount(`${written}:rw`)).toEqual(rw(proj));
    expect(settings([parseMount(`${written}:rw`)])).toEqual([rw(proj), ro(join(proj, ".git"))]);
    // Where only the directory the link leads to exists, there is nothing for Docker to mount.
    const deepOnly = [dir, "link", "..", "proj", ".vscode"].join(sep);
    expect(refusal(() => parseMount(deepOnly))).toBe(`--mount: ${join(proj, ".vscode")} does not exist`);
  });
});

describe.skipIf(windowsHost)("the environment of docker and npm on macOS and Linux", () => {
  it("is made of the variables it names, with a PATH of the trusted places, each name with its case", () => {
    vi.stubEnv("Path", "/elsewhere");
    vi.stubEnv("HTTPS_PROXY", "http://one.example:3128");
    vi.stubEnv("https_proxy", "http://two.example:3128");
    vi.stubEnv("Https_Proxy", "http://three.example:3128");
    const env = dockerProgram()!.env;
    // Path is not PATH here, nor TMP the temporary directory: neither is given.
    expect(env.Path).toBeUndefined();
    expect(env.TMP).toBeUndefined();
    expect(env.TMPDIR).toBe(process.env.TMPDIR);
    expect([env.HTTPS_PROXY, env.https_proxy, env.Https_Proxy]).toEqual(["http://one.example:3128", "http://two.example:3128", undefined]);
    expect(env.PATH!.split(":")).toContain("/usr/bin");
  });
});

describe("the settings kept read-only in a writable mount, at their edges", () => {
  it("refuses on Windows a read-only mount inside a writable one, and nothing else of the kind", () => {
    const dir = layout({ "sub/": "" });
    const sub = join(dir, "sub");
    expect(refusal(() => settings([rw(dir), ro(sub)], "win32"))).toContain(`${sub}, mounted read-only, would not stay read-only inside it: on Windows, Docker Desktop lets`);
    // A writable one inside a writable one, and a folder mounted twice, are not one inside the other.
    expect(byTarget(settings([rw(dir), rw(sub)], "win32"))).toEqual(byTarget([rw(dir), rw(sub)]));
    expect(settings([rw(dir), ro(dir)], "win32")).toEqual([rw(dir), ro(dir)]);
  });

  it("looks through 100,000 entries in one writable mount, and adds 1,000 mounts in all, at most", () => {
    expect(SETTINGS_LIMITS).toEqual({ entries: 100_000, mounts: 1_000 });
  });

  it("looks through as many entries as the limit allows, and refuses one more", () => {
    const dir = layout({ a: "", b: "", c: "" });
    expect(withSettingsReadOnly([rw(dir)], { entries: 3, mounts: 10 }, "linux")).toEqual([rw(dir)]);
    expect(refusal(() => withSettingsReadOnly([rw(dir)], { entries: 2, mounts: 10 }, "linux"))).toContain("more than 2 entries to look through");
  });

  it("refuses a setting whose path holds a comma, with what to do", () => {
    const dir = layout({ "a,b/.vscode/settings.json": "{}" });
    expect(refusal(() => settings([rw(dir)]))).toBe(refused(dir, `${join(dir, "a,b", ".vscode")} cannot be kept read-only, because paths containing commas are not supported`, "Rename it"));
  });

  it.skipIf(windowsHost)("on macOS refuses a setting that is neither a directory nor a file", () => {
    const dir = layout({});
    execFileSync("mkfifo", [join(dir, ".mcp.json")]);
    expect(refusal(() => settings([rw(dir)], "darwin"))).toContain(`${join(dir, ".mcp.json")} is not a directory, and on macOS the server could change it as ${join(dir, ".MCP.JSON")}`);
  });

  it("puts a mount of / before the mounts inside it", () => {
    expect(settings([ro("/x"), ro("/")])).toEqual([ro("/"), ro("/x")]);
  });
});

describe("the repository a .git file leads to, at its edges", () => {
  const repository = { config: "[core]\n", "hooks/": "" };
  const at = (prefix: string, entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([path, text]) => [`${prefix}/${path}`, text]));

  it("refuses a .git file that does not say where its repository is, with an error", () => {
    const dir = layout({ "app/.git": "gitdir:../meta\n", ...at("meta", repository) });
    const file = join(dir, "app", ".git");
    expect(refusal(() => settings([rw(dir)]))).toBe(refused(dir, `${file} does not say where a git repository is in the form git writes (gitdir: <path>)`, "Fix or remove it"));
    // A line break inside the path, not only at its end, is no path git writes.
    writeFileSync(file, "gitdir: ../meta\nx");
    expect(refusal(() => settings([rw(dir)]))).toBe(refused(dir, `${file} does not say where a git repository is in the form git writes (gitdir: <path>)`, "Fix or remove it"));
    writeFileSync(file, "gitdir: ../meta\n");
    writeFileSync(join(dir, "meta", "commondir"), "\n");
    expect(refusal(() => settings([rw(dir)]))).toBe(refused(dir, `${join(dir, "meta", "commondir")} does not say where a git repository is in the form git writes (<path>)`, "Fix or remove it"));
  });

  it("refuses a .git file too large to be one, and reads one of the largest size", () => {
    const dir = layout({ "app/": "" });
    const file = join(dir, "app", ".git");
    writeFileSync(file, `gitdir: ${"a".repeat(64 * 1024 - 8)}\n`);
    expect(refusal(() => settings([rw(dir)]))).toBe(refused(dir, `${file} is too large to say where a git repository is`, "Fix or remove it"));
    writeFileSync(file, `gitdir: ${"a".repeat(64 * 1024 - 9)}\n`);
    expect(refusal(() => settings([rw(dir)]))).not.toContain("too large");
  });

  it("refuses a .git file that grows past the limit after its size was looked at", async () => {
    // Another cage can write in the same mount while mcpcage reads: the file is made to grow by 64 KiB
    // right after the first look at its size, by path or on the opened file, whichever comes first.
    const dir = layout({ "app/.git": "gitdir: ../meta\n", ...at("meta", repository) });
    const file = join(dir, "app", ".git");
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      let opened: number | undefined;
      let grown = false;
      const grow = () => {
        if (!grown) fs.appendFileSync(file, "a".repeat(64 * 1024));
        grown = true;
      };
      const statSync = ((path: PathLike, ...rest: unknown[]) => {
        const stat = (fs.statSync as (...args: unknown[]) => unknown)(path, ...rest);
        if (String(path) === file) grow();
        return stat;
      }) as typeof fs.statSync;
      const openSync = ((path: PathLike, ...rest: unknown[]) => {
        const fd = (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
        if (String(path) === file) opened = fd;
        return fd;
      }) as typeof fs.openSync;
      const fstatSync = ((fd: number, ...rest: unknown[]) => {
        const stat = (fs.fstatSync as (...args: unknown[]) => unknown)(fd, ...rest);
        if (fd === opened) grow();
        return stat;
      }) as typeof fs.fstatSync;
      return { ...fs, statSync, openSync, fstatSync };
    });
    try {
      const sandbox = await import("../src/sandbox.js");
      expect(refusal(() => sandbox.withSettingsReadOnly([rw(dir)], sandbox.SETTINGS_LIMITS, "linux"))).toBe(
        refused(dir, `${file} is too large to say where a git repository is`, "Fix or remove it"),
      );
      expect(statSync(file).size).toBeGreaterThan(64 * 1024);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("refuses a commondir that is not a file, with what to do", () => {
    const dir = layout({ "app/.git": "gitdir: ../meta\n", ...at("meta", repository), "meta/commondir/": "" });
    expect(refusal(() => settings([rw(dir)]))).toBe(
      refused(dir, `${join(dir, "meta", "commondir")}, which names the repository ${join(dir, "app", ".git")} shares, is not a file`, "Replace it with the file git writes"),
    );
  });

  it("refuses a repository whose path holds a comma, with what to do", () => {
    const dir = layout({ "app/.git": "gitdir: ../re,po\n", ...at("re,po", repository) });
    expect(refusal(() => settings([rw(dir)]))).toBe(
      refused(dir, `${join(dir, "re,po")}, the repository ${join(dir, "app", ".git")} leads to, cannot be kept read-only, because paths containing commas are not supported`, "Rename it"),
    );
  });

  it("holds in place each directory on the way to the repository, named as it is", () => {
    const dir = layout({ "app/.git": "gitdir: ../.repos/main\n", ...at(".repos/main", repository) });
    expect(byTarget(settings([rw(dir)]))).toEqual(byTarget([rw(dir), rw(join(dir, "app")), rw(join(dir, ".repos")), ro(join(dir, "app", ".git")), ro(join(dir, ".repos", "main"))]));
  });

  it.skipIf(windowsHost)("holds in place a directory whose name ends with a dot", () => {
    const dir = layout({ "app/.git": "gitdir: ../v1./repo\n", ...at("v1./repo", repository) });
    expect(byTarget(settings([rw(dir)]))).toEqual(byTarget([rw(dir), rw(join(dir, "app")), rw(join(dir, "v1.")), ro(join(dir, "app", ".git")), ro(join(dir, "v1.", "repo"))]));
  });

  it("keeps read-only a repository that is a file, without looking for a commondir inside it", () => {
    const dir = layout({ "app/.git": "gitdir: ../not-a-dir\n", "not-a-dir": "x" });
    expect(byTarget(settings([rw(dir)]))).toEqual(byTarget([rw(dir), rw(join(dir, "app")), ro(join(dir, "app", ".git")), ro(join(dir, "not-a-dir"))]));
  });

  it("needs nothing for a path through a file, outside any writable mount", () => {
    const top = layout({ "project/app/.git": "gitdir: <dir>/a-file/repo\n", "a-file": "x" });
    const project = join(top, "project");
    expect(byTarget(settings([rw(project)]))).toEqual(byTarget([rw(project), rw(join(project, "app")), ro(join(project, "app", ".git"))]));
  });

  it.skipIf(windowsHost)("follows a symlink a read-only mount holds, which the server cannot point elsewhere", () => {
    const dir = layout({ "app/.git": "gitdir: ../lib/meta-link\n", ...at("meta", repository), "lib/": "" });
    symlinkSync(join(dir, "meta"), join(dir, "lib", "meta-link"));
    const lib = join(dir, "lib");
    expect(byTarget(settings([rw(dir), ro(lib)]))).toEqual(byTarget([rw(dir), ro(lib), rw(join(dir, "app")), ro(join(dir, "app", ".git")), ro(join(dir, "meta"))]));
  });

  it.skipIf(windowsHost)("takes a backslash on macOS and Linux for part of a name", () => {
    const dir = layout({ "app/.git": "gitdir: ../a\\b\n", ...at("a\\b", repository) });
    expect(byTarget(settings([rw(dir)]))).toEqual(byTarget([rw(dir), rw(join(dir, "app")), ro(join(dir, "app", ".git")), ro(join(dir, "a\\b"))]));
  });

  it.skipIf(windowsHost)("follows up to 40 symlinks on the way, and refuses a way with more", () => {
    const top = layout({ "project/app/.git": "gitdir: <dir>/link1\n", ...at("repo", repository) });
    const project = join(top, "project");
    for (let index = 1; index <= 40; index++) symlinkSync(join(top, index === 40 ? "repo" : `link${index + 1}`), join(top, `link${index}`));
    const expected = byTarget([rw(project), rw(join(project, "app")), ro(join(project, "app", ".git"))]);
    expect(byTarget(settings([rw(project)]))).toEqual(expected);
    // Two links that lead to each other.
    writeFileSync(join(project, "app", ".git"), "gitdir: <dir>/loop-a\n".replace("<dir>", top));
    symlinkSync(join(top, "loop-b"), join(top, "loop-a"));
    symlinkSync(join(top, "loop-a"), join(top, "loop-b"));
    expect(refusal(() => settings([rw(project)]))).toBe(refused(project, `cannot follow ${join(project, "app", ".git")} to the repository it names (ELOOP)`, "Fix or remove it"));
  });

  it.skipIf(windowsHost || asRoot)("refuses a way it cannot look along, and a commondir it cannot read", () => {
    const top = layout({ "project/app/.git": "gitdir: <dir>/locked/repo\n", "locked/repo/config": "" });
    const project = join(top, "project");
    const file = join(project, "app", ".git");
    chmodSync(join(top, "locked"), 0o000);
    try {
      expect(refusal(() => settings([rw(project)]))).toBe(refused(project, `cannot follow ${file} to the repository it names (EACCES)`, "Fix or remove it"));
    } finally {
      chmodSync(join(top, "locked"), 0o755);
    }
    // The repository under node_modules, which the walk leaves alone, where its commondir cannot be read.
    const dir = layout({ "app/.git": "gitdir: ../node_modules/repo\n", ...at("node_modules/repo", repository) });
    chmodSync(join(dir, "node_modules", "repo"), 0o000);
    try {
      expect(refusal(() => settings([rw(dir)]))).toBe(
        refused(dir, `cannot read ${join(dir, "node_modules", "repo", "commondir")}, which names the repository ${join(dir, "app", ".git")} shares (EACCES)`, "Fix or remove it"),
      );
    } finally {
      chmodSync(join(dir, "node_modules", "repo"), 0o755);
    }
  });
});
