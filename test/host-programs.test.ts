import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dockerAvailable, dockerProgram, npmProgram, npxProgram, runArgs } from "../src/sandbox.js";
import { WINDOWS_PLACES, windowsEnv } from "../src/windows-places.js";
import { fakePrograms, isProgram, onWindows, STANDARD_PLACES, standardDocker } from "./fake-programs.js";
import { connect, fakeServer, freshHome, mcpcageWithEnv } from "./helpers.js";

// A client starts mcpcage with the PATH a server entry's `env` sets. The docker, the credential
// helper, the npm and the node that PATH puts first must not be the ones mcpcage runs.

/** Whether the docker in a standard place reaches a daemon, with the user's own configuration. */
const daemon = standardDocker !== undefined && spawnSync(standardDocker, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status === 0;

/** The daemon the user's docker reaches, for a docker given a configuration directory of its own. */
function dockerHost(): string {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  return spawnSync(standardDocker!, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" }).stdout.trim();
}

const path = process.env.PATH;
const cwd = process.cwd();
afterEach(() => {
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
  delete process.env.MCPCAGE_TEST_OTHER;
  process.chdir(cwd);
});

describe("docker and npm on the host, whatever an entry's PATH puts first", () => {
  it.skipIf(standardDocker === undefined)("finds docker in the standard places before the PATH, and runs it with a PATH of those places", () => {
    const fake = fakePrograms();
    process.env.PATH = fake.path;
    process.env.MCPCAGE_TEST_OTHER = "other";
    const docker = dockerProgram()!;
    expect(docker.file).toBe(standardDocker);
    expect(docker.args).toEqual([]);
    expect(docker.env.PATH?.split(delimiter)).toEqual([...new Set([dirname(standardDocker!), ...STANDARD_PLACES])]);
    // The rest of mcpcage's environment only by name (see host-env.test.ts).
    expect(docker.env.MCPCAGE_TEST_OTHER).toBeUndefined();
  });

  it.skipIf(standardDocker === undefined)("doctor does not start the docker or the credential helper that come first on the PATH", () => {
    const fake = fakePrograms();
    const result = mcpcageWithEnv({ ...process.env, MCPCAGE_HOME: freshHome(), PATH: fake.path }, "doctor");
    expect(fake.ran()).toBe("");
    expect(result.stdout).toMatch(daemon ? /^ok {4}docker {7}server \S+$/m : /^FAIL {2}docker /m);
  });

  it.skipIf(!daemon)("pulls an image with the docker of a standard place, which runs no credential helper from the PATH", () => {
    const fake = fakePrograms();
    const config = mkdtempSync(join(tmpdir(), "mcpcage-docker-config-"));
    // Docker Desktop's configuration: the credentials of every registry through docker-credential-desktop.
    writeFileSync(join(config, "config.json"), JSON.stringify({ credsStore: "desktop" }));
    const env: NodeJS.ProcessEnv = { ...process.env, MCPCAGE_HOME: freshHome(), PATH: fake.path, DOCKER_CONFIG: config, DOCKER_HOST: dockerHost() };
    // The contexts are kept in the configuration directory that this one replaces.
    delete env.DOCKER_CONTEXT;
    // Nothing listens on port 9: the pull fails, after docker has asked for the registry's credentials.
    const result = mcpcageWithEnv(env, "prepare", "--id", "pull", "--image", "127.0.0.1:9/mcpcage-no-such-image:1");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("docker pull failed");
    expect(fake.ran()).toBe("");
  });

  // The npm installed with the node running mcpcage, else the first in a standard place.
  const trustedNpm = [dirname(process.execPath), ...STANDARD_PLACES].map((dir) => join(dir, "npm")).find(isProgram);
  it.skipIf(process.platform === "win32" || trustedNpm === undefined)("runs the npm next to the node running mcpcage or in a standard place, which then finds no node from the PATH", () => {
    const fake = fakePrograms();
    process.env.PATH = fake.path;
    const npm = npmProgram()!;
    expect(npm.file).toBe(trustedNpm);
    expect(npm.args).toEqual([]);
    expect(npm.env.PATH?.split(delimiter)).toEqual([...new Set([dirname(trustedNpm!), ...STANDARD_PLACES])]);
    // npm's script starts with `#!/usr/bin/env node`.
    const version = spawnSync(npm.file, [...npm.args, "--version"], { encoding: "utf8", env: npm.env });
    expect(version.status, version.stderr).toBe(0);
    expect(fake.ran()).toBe("");
  });

  // A program found nowhere is started by its bare name, which execvp looks for in the current
  // directory only through an empty or relative entry of the PATH it is given.
  it.skipIf(process.platform === "win32")("runs docker and npm with a PATH of absolute directories only, whatever mcpcage's PATH holds", () => {
    process.env.PATH = ["", ".", "bin"].join(delimiter);
    for (const program of [dockerProgram()!, npmProgram()!]) {
      const dirs = program.env.PATH?.split(delimiter) ?? [];
      expect(dirs.length).toBeGreaterThan(0);
      expect(dirs.filter((dir) => !isAbsolute(dir)), program.file).toEqual([]);
    }
  });
});

describe("on Windows, a docker or an npm found nowhere", () => {
  // Windows looks for a bare program name in the current directory first, whatever the PATH says, and
  // a client starts mcpcage in the project's: a cloned repository can hold a docker.exe or an npm.exe.
  /** That project, the current directory, with decoys that note when they run and answer like the real ones. */
  function projectWithDecoys(): { dir: string; ran: () => string } {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-decoys-"));
    const dir = join(top, "project");
    const marker = join(top, "ran");
    mkdirSync(dir);
    for (const name of ["docker.exe", "npm.exe", "npm"]) {
      writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${marker}'\necho 28.5.1\n`);
      chmodSync(join(dir, name), 0o755);
    }
    process.chdir(dir);
    return { dir, ran: () => (existsSync(marker) ? readFileSync(marker, "utf8") : "") };
  }

  it("starts no docker.exe from the current directory: Docker counts as not found", () => {
    const project = projectWithDecoys();
    // Empty and relative entries all name the current directory; the absolute one holds no docker.
    process.env.PATH = ["", ".", join("..", "project"), mkdtempSync(join(tmpdir(), "mcpcage-no-docker-"))].join(delimiter);
    expect(onWindows(() => dockerAvailable())).toEqual({ ok: false, error: "docker.exe not found in the PATH" });
    expect(project.ran()).toBe("");
    // Only the file is compared: the whole program would print mcpcage's environment on a failure.
    expect(onWindows(() => dockerProgram())?.file).toBeUndefined();
  });

  it("finds docker.exe only in an absolute directory of the PATH, never through an empty or relative entry", () => {
    projectWithDecoys();
    const bin = mkdtempSync(join(tmpdir(), "mcpcage-docker-bin-"));
    writeFileSync(join(bin, "docker.exe"), "");
    process.env.PATH = ["", ".", join("..", "project"), bin].join(delimiter);
    const docker = onWindows(() => dockerProgram());
    expect(docker?.file).toBe(join(bin, "docker.exe"));
    expect(docker?.env.PATH).toBe(bin);
  });

  it("gives no npm when npm's script is not next to node, where Node's installer puts it", () => {
    projectWithDecoys();
    const node = join(mkdtempSync(join(tmpdir(), "mcpcage-nodejs-")), "node.exe");
    expect(onWindows(() => npmProgram(), node)?.file).toBeUndefined();
  });
});

describe("on Windows, the places docker and npm are given", () => {
  // docker.exe loads its plugins from %ProgramData%\Docker\cli-plugins and
  // %ProgramFiles%\Docker\cli-plugins, and with ProgramData not set, as the MCP SDK leaves it on
  // Windows, from Docker\cli-plugins in the current directory, the project's: a cloned repository's
  // docker-buildx.exe ran on the host at `docker build`. mcpcage gave docker its own environment,
  // with only the PATH replaced.
  const names = [...WINDOWS_PLACES, "USERPROFILE", "HOME", "NoDefaultCurrentDirectoryInExePath"];
  const registry: Record<string, string> = {
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion": [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion",
      "    ProgramFilesDir    REG_SZ    D:\\Programs",
      "    CommonFilesDir    REG_SZ    D:\\Programs\\Common Files",
      "    ProgramFilesDir (x86)    REG_SZ    D:\\Programs (x86)",
      "    CommonFilesDir (x86)    REG_SZ    D:\\Programs (x86)\\Common Files",
      "    CommonW6432Dir    REG_SZ    D:\\Programs\\Common Files",
      "    ProgramW6432Dir    REG_SZ    D:\\Programs",
      "    MediaPathUnexpanded    REG_EXPAND_SZ    %SystemRoot%\\Media",
      "",
    ].join("\r\n"),
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders":
      "\r\n    AppData    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\r\n    Local AppData    REG_EXPAND_SZ    F:\\Local\r\n",
  };

  it("are Windows' own, from its registry and the account's home directory, else where Windows puts them", () => {
    const sources = { windows: "E:\\Windows", home: "E:\\Users\\me", registry: (key: string) => registry[key] };
    const values = {
      SystemRoot: "E:\\Windows",
      windir: "E:\\Windows",
      SystemDrive: "E:",
      ComSpec: "E:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      ProgramData: "E:\\ProgramData",
      ALLUSERSPROFILE: "E:\\ProgramData",
      ProgramFiles: "D:\\Programs",
      "ProgramFiles(x86)": "D:\\Programs (x86)",
      ProgramW6432: "D:\\Programs",
      CommonProgramFiles: "D:\\Programs\\Common Files",
      "CommonProgramFiles(x86)": "D:\\Programs (x86)\\Common Files",
      CommonProgramW6432: "D:\\Programs\\Common Files",
      APPDATA: "E:\\Users\\me\\AppData\\Roaming",
      LOCALAPPDATA: "F:\\Local",
      TEMP: "F:\\Local\\Temp",
      TMP: "F:\\Local\\Temp",
      HOMEDRIVE: "E:",
      HOMEPATH: "\\Users\\me",
      USERPROFILE: "E:\\Users\\me",
      HOME: "E:\\Users\\me",
      NoDefaultCurrentDirectoryInExePath: "1",
    };
    expect(windowsEnv(sources)).toEqual(values);
    expect(Object.keys(values).sort()).toEqual([...names].sort());
    // A registry that cannot be read, or a value that names another variable, is relative, or was not read whole: Windows' defaults.
    const defaults = {
      ...values,
      ProgramData: "E:\\ProgramData",
      ProgramFiles: "E:\\Program Files",
      "ProgramFiles(x86)": "E:\\Program Files (x86)",
      ProgramW6432: "E:\\Program Files",
      CommonProgramFiles: "E:\\Program Files\\Common Files",
      "CommonProgramFiles(x86)": "E:\\Program Files (x86)\\Common Files",
      CommonProgramW6432: "E:\\Program Files\\Common Files",
      LOCALAPPDATA: "E:\\Users\\me\\AppData\\Local",
      TEMP: "E:\\Users\\me\\AppData\\Local\\Temp",
      TMP: "E:\\Users\\me\\AppData\\Local\\Temp",
    };
    expect(windowsEnv({ ...sources, registry: () => undefined })).toEqual(defaults);
    const odd = (value: string) => (key: string) => registry[key]?.replace("D:\\Programs\r\n    CommonFilesDir", `${value}\r\n    CommonFilesDir`).replace("F:\\Local", value);
    for (const value of ["%PUBLIC%\\Programs", "Programs", "D:\\Progr\uFFFDms", "D:\\Programs\\%x"]) {
      expect(windowsEnv({ ...sources, registry: odd(value) })).toMatchObject({ ProgramFiles: "E:\\Program Files", LOCALAPPDATA: "E:\\Users\\me\\AppData\\Local" });
    }
  });

  it("take each folder from its own registry value, wherever on a drive it is, and never from a share", () => {
    // The values above are where Windows would put each folder anyway: here none is, so each one read shows.
    const own: Record<string, string> = {
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion": [
        "    ProgramFilesDir    REG_SZ    D:\\Programs",
        "    ProgramFilesDir (x86)    REG_SZ    D:\\Programs (x86)",
        "    CommonFilesDir    REG_SZ    G:\\Common",
        "    CommonFilesDir (x86)    REG_SZ    G:\\Common (x86)",
        "    CommonW6432Dir    REG_SZ    G:\\Common 64",
        "    ProgramW6432Dir    REG_SZ    G:\\Programs 64",
      ].join("\r\n"),
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders": "    AppData    REG_EXPAND_SZ    G:\\Roaming\r\n    Local AppData    REG_EXPAND_SZ    G:\\Local\r\n",
    };
    const sources = { windows: "E:\\Windows", home: "E:\\Users\\me", registry: (key: string) => own[key] };
    expect(windowsEnv(sources)).toMatchObject({
      ProgramFiles: "D:\\Programs",
      "ProgramFiles(x86)": "D:\\Programs (x86)",
      CommonProgramFiles: "G:\\Common",
      "CommonProgramFiles(x86)": "G:\\Common (x86)",
      CommonProgramW6432: "G:\\Common 64",
      ProgramW6432: "G:\\Programs 64",
      APPDATA: "G:\\Roaming",
      LOCALAPPDATA: "G:\\Local",
      TEMP: "G:\\Local\\Temp",
    });
    // A folder redirected to a share is where Windows puts it by default for docker and npm, which would
    // reach the server with the user's credentials (see networkPath); uv's settings there are read apart.
    const shared = (key: string) => own[key]?.replace("G:\\Roaming", "\\\\fs01\\profiles$\\me\\AppData\\Roaming").replace("G:\\Local", "//fs01/local");
    expect(windowsEnv({ ...sources, registry: shared })).toMatchObject({ APPDATA: "E:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "E:\\Users\\me\\AppData\\Local" });
  });

  it("replace, each once whatever its case, those of mcpcage's environment for docker and npm", () => {
    const bin = mkdtempSync(join(tmpdir(), "mcpcage-docker-bin-"));
    writeFileSync(join(bin, "docker.exe"), "");
    const npm = join(mkdtempSync(join(tmpdir(), "mcpcage-nodejs-")), "nodejs");
    mkdirSync(join(npm, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(npm, "node_modules", "npm", "bin", "npm-cli.js"), "");
    // As an entry's env, or a client, could leave them: chosen elsewhere, relative, or not there.
    const chosen = "C:\\never-chosen";
    for (const name of names) vi.stubEnv(name, chosen);
    vi.stubEnv("ProgramData", undefined);
    vi.stubEnv("TEMP", "temp");
    vi.stubEnv("PATH", bin);
    // Spelled otherwise, which Windows takes for the same variable: on Windows itself one of each is kept.
    if (process.platform !== "win32") {
      vi.stubEnv("Path", chosen);
      vi.stubEnv("programfiles", chosen);
    }
    vi.stubEnv("MCPCAGE_TEST_OTHER", "other");
    try {
      for (const program of [onWindows(() => dockerProgram())!, onWindows(() => npmProgram(), join(npm, "node.exe"))!]) {
        const env = program.env;
        // HOMEDRIVE and HOMEPATH only for a home directory on a drive, which the account's here, on macOS or Linux, is not.
        const homeOnDrive = process.platform === "win32";
        for (const name of [...names, "PATH"]) {
          const spelled = Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());
          expect(spelled, name).toEqual(/^HOME(?:DRIVE|PATH)$/.test(name) && !homeOnDrive ? [] : [name]);
          expect(env[name], name).not.toBe(chosen);
        }
        for (const name of names.filter((name) => !["PATHEXT", "SystemDrive", "HOMEDRIVE", "NoDefaultCurrentDirectoryInExePath"].includes(name))) {
          if (name === "HOMEPATH" && !homeOnDrive) continue;
          expect(win32.isAbsolute(env[name]!), `${name}=${env[name]}`).toBe(true);
        }
        expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1");
        expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
        // The rest of mcpcage's environment only by name (see host-env.test.ts).
        expect(env.MCPCAGE_TEST_OTHER).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("give the server mcpcage's own value of a place it is given with --env, as its PATH", () => {
    const base = { serverId: "x", spec: { kind: "npm" as const, packageName: "p", args: [] }, mounts: [], allowNet: false, memory: "512m", cpus: "1", keepImageUser: false };
    vi.stubEnv("TEMP", "C:\\server-temp");
    vi.stubEnv("APPDATA", "C:\\server-roaming");
    vi.stubEnv("LOCALAPPDATA", undefined);
    try {
      const args = onWindows(() => runArgs({ ...base, env: ["TEMP", "APPDATA", "LOCALAPPDATA", "OTHER"] }, "img", "win32"));
      expect(args).toContain("TEMP=C:\\server-temp");
      expect(args).toContain("APPDATA=C:\\server-roaming");
      expect(args).toContain("OTHER");
      expect(args.filter((arg) => /^(?:TEMP|APPDATA|LOCALAPPDATA)$/.test(arg))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /** What Windows' own API says of its folders (SHGetKnownFolderPath, through .NET), not its registry. */
  function knownFolders(): Record<string, string> {
    const folders = ["CommonApplicationData", "ProgramFiles", "ProgramFilesX86", "CommonProgramFiles", "ApplicationData", "LocalApplicationData", "Windows", "UserProfile"];
    const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = folders.map((folder) => `[Environment]::GetFolderPath('${folder}')`).join("; ");
    const listed = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    const lines = listed.stdout.trim().split(/\r?\n/);
    return Object.fromEntries(folders.map((folder, index) => [folder, lines[index]!]));
  }

  it.runIf(process.platform === "win32")("are on Windows what its own API says, whatever mcpcage's environment says", () => {
    const known = knownFolders();
    const bin = mkdtempSync(join(tmpdir(), "mcpcage-docker-bin-"));
    writeFileSync(join(bin, "docker.exe"), "");
    for (const name of ["ProgramData", "ProgramFiles", "APPDATA", "SystemRoot", "USERPROFILE"]) vi.stubEnv(name, "C:\\never-chosen");
    vi.stubEnv("LOCALAPPDATA", undefined);
    vi.stubEnv("PATH", bin);
    try {
      const env = dockerProgram()!.env;
      // Compared without case, as Windows compares paths: its API spells its own directory C:\WINDOWS.
      const same = (name: string, folder: string) => expect(env[name]?.toLowerCase(), name).toBe(known[folder]!.toLowerCase());
      same("ProgramData", "CommonApplicationData");
      same("ProgramFiles", "ProgramFiles");
      same("ProgramFiles(x86)", "ProgramFilesX86");
      same("CommonProgramFiles", "CommonProgramFiles");
      same("APPDATA", "ApplicationData");
      same("LOCALAPPDATA", "LocalApplicationData");
      same("SystemRoot", "Windows");
      same("USERPROFILE", "UserProfile");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  const dockerOnPath = process.platform === "win32" && (process.env.PATH ?? "").split(delimiter).some((dir) => isAbsolute(dir) && existsSync(join(dir, "docker.exe")));
  it.runIf(dockerOnPath)("never let docker.exe load a plugin from the current directory, ProgramData unset as the MCP SDK leaves it", () => {
    // The project a client starts the server in, with a docker-buildx.exe where docker would look:
    // node.exe under that name, which notes each start in a file (NODE_OPTIONS reaches it through docker).
    const project = mkdtempSync(join(tmpdir(), "mcpcage-plugin-project-"));
    const plugins = join(project, "Docker", "cli-plugins");
    mkdirSync(plugins, { recursive: true });
    const decoy = join(plugins, "docker-buildx.exe");
    try {
      linkSync(process.execPath, decoy);
    } catch {
      copyFileSync(process.execPath, decoy);
    }
    const marker = join(project, "ran");
    const preload = join(project, "note.cjs");
    writeFileSync(preload, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "docker-buildx.exe " + process.argv.slice(1).join(" ") + "\\n");\n`);
    // Inside quotes NODE_OPTIONS reads a backslash as an escape: the path is given with forward slashes.
    vi.stubEnv("NODE_OPTIONS", `--require "${preload.replace(/\\/g, "/")}"`);
    vi.stubEnv("ProgramData", undefined);
    process.chdir(project);
    try {
      const docker = dockerProgram()!;
      // What docker finds with this environment where there is no plugin of a project's: Docker
      // Desktop's buildx, or none on a machine with docker.exe alone (GitHub's Windows runner).
      const elsewhere = spawnSync(docker.file, ["buildx", "version"], { encoding: "utf8", env: docker.env, cwd: mkdtempSync(join(tmpdir(), "mcpcage-plugin-elsewhere-")) });
      const result = spawnSync(docker.file, ["buildx", "version"], { encoding: "utf8", env: docker.env, cwd: project });
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
      // In the project docker finds the same: that buildx, or none at all.
      if (elsewhere.status === 0) {
        expect(elsewhere.stdout).toMatch(/buildx/);
        expect(result.stdout, result.stderr).toBe(elsewhere.stdout);
      } else {
        expect(result.stderr).toMatch(/unknown command: docker buildx|'buildx' is not a docker command/);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("run --no-sandbox on Windows", () => {
  /** A node installed as Node's installer does it on Windows, with npm's npx-cli.js next to it or without. */
  function nodeInstall(withNpx: boolean): { node: string; script: string } {
    const dir = join(mkdtempSync(join(tmpdir(), "mcpcage-nodejs-")), "nodejs");
    const script = join(dir, "node_modules", "npm", "bin", "npx-cli.js");
    mkdirSync(dirname(script), { recursive: true });
    if (withNpx) writeFileSync(script, "");
    return { node: join(dir, "node.exe"), script };
  }

  it("starts npx as npm's npx-cli.js with the node running mcpcage, never by name, and nothing without it", () => {
    const { node, script } = nodeInstall(true);
    expect(onWindows(() => npxProgram(), node)).toEqual({ file: node, args: [script] });
    expect(onWindows(() => npxProgram(), nodeInstall(false).node)).toBeUndefined();
  });

  /** A package with a bin that runs the fake notes server, which npx installs from its directory, without the registry. */
  function notesPackage(): string {
    const dir = mkdtempSync(join(tmpdir(), "mcpcage-npx-pkg-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mcpcage-npx-notes", version: "1.0.0", type: "module", bin: { "mcpcage-npx-notes": "server.mjs" } }));
    writeFileSync(join(dir, "server.mjs"), `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(fakeServer).href)});\n`);
    return dir;
  }

  it.runIf(process.platform === "win32")("starts npx, which a plain spawn could not find, and a cmd /c npx without cmd", async () => {
    const home = freshHome();
    // npx installs the package in a cache of the run's own, not in the user's npm cache.
    const env = { FAKE_VARIANT: "v1", npm_config_cache: join(home, "npm-cache") };
    for (const server of [["npx", "-y", notesPackage()], ["cmd", "/c", "npx", "-y", notesPackage()]]) {
      const session = await connect({ home, runArgs: ["--no-sandbox", "--id", "notes"], server, env });
      try {
        expect((await session.client.listTools()).tools.map((tool) => tool.name)).toEqual(["add_note", "list_notes"]);
      } finally {
        await session.close();
      }
    }
  });

  it.runIf(process.platform === "win32")("refuses a batch file, named or found by a bare name, rather than start it through a shell", () => {
    const home = freshHome();
    const dir = mkdtempSync(join(tmpdir(), "mcpcage-batch-"));
    const batch = join(dir, "server.cmd");
    writeFileSync(batch, "@echo started\r\n");
    const why = "is a batch file, which Windows starts only through cmd.exe, a shell that would read the server's arguments as commands";
    const named = mcpcageWithEnv({ ...process.env, MCPCAGE_HOME: home }, "run", "--no-sandbox", "--", batch, "&", "calc");
    expect(named.stderr).toContain(`mcpcage: ${batch} ${why}`);
    expect(named.code).toBe(1);
    const bare = mcpcageWithEnv({ ...process.env, MCPCAGE_HOME: home, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` }, "run", "--no-sandbox", "--", "server");
    expect(bare.stderr).toContain(`mcpcage: ${batch} ${why}`);
    expect(bare.stdout).toBe("");
  });
});

describe("a server's --env PATH", () => {
  const base = { serverId: "x", spec: { kind: "npm" as const, packageName: "p", args: [] }, mounts: [], allowNet: false, memory: "512m", cpus: "1", keepImageUser: false };

  it("is mcpcage's PATH, which docker, run with a PATH of its own, would not give the server", () => {
    process.env.PATH = "/one/bin:/two/bin";
    const args = runArgs({ ...base, env: ["PATH", "OTHER", "PATHS"] }, "img");
    expect(args).toContain("PATH=/one/bin:/two/bin");
    expect(args).not.toContain("PATH");
    expect(args).toContain("OTHER");
    expect(args).toContain("PATHS");
    // Without one, the server keeps the image's own.
    delete process.env.PATH;
    expect(runArgs({ ...base, env: ["PATH", "OTHER"] }, "img").filter((arg) => /^PATH\b/.test(arg))).toEqual([]);
  });
});
