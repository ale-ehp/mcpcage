import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchFile,
  commandOnPath,
  envFileOf,
  foreignPath,
  inTemporaryPlace,
  installedScript,
  MAX_ENV_FILE_BYTES,
  mcpcageAt,
  movedPlaces,
  nodeScript,
  parseEnvFile,
  runningFrom,
  temporaryMcpcage,
} from "../src/installed.js";
import { idleProgram, onWindows } from "./fake-programs.js";

const windowsHost = process.platform === "win32";
const run = ["run", "--", "npx", "-y", "notes"];

/** A new directory of this system, spelled as the system spells it. */
const fresh = (name: string) => realpathSync.native(mkdtempSync(join(tmpdir(), `mcpcage-${name}-`)));

let argv1: string | undefined;
beforeEach(() => {
  argv1 = process.argv[1];
});
afterEach(() => {
  if (argv1 === undefined) process.argv.length = 1;
  else process.argv[1] = argv1;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Directories made before this are no temporary place any more: the temporary directory is a new one. */
function moveTemporaryDirectory(): string {
  const temporary = fresh("tmp");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, temporary);
  return temporary;
}

describe("the node and cli.js --fix writes on Windows", () => {
  it("is node or node.exe itself, a file named cli.js, then run", () => {
    expect(nodeScript({ command: "C:\\Program Files\\nodejs\\NODE.EXE", args: ["C:\\m\\CLI.JS", "run"] }, "win32")).toBe("C:\\m\\CLI.JS");
    for (const entry of [
      { command: 42, args: ["C:\\m\\cli.js", "run"] },
      { command: "C:\\x\\mynode.exe", args: ["C:\\m\\cli.js", "run"] },
      { command: "C:\\x\\node.exe.bak", args: ["C:\\m\\cli.js", "run"] },
      { command: "C:\\x\\uvx.exe", args: ["C:\\m\\cli.js", "run"] },
      { command: "node", args: ["C:\\m\\other.js", "run"] },
      { command: "node", args: ["C:\\m\\cli.js", "list"] },
    ]) {
      expect(nodeScript(entry, "win32"), JSON.stringify(entry)).toBeUndefined();
    }
  });
});

describe("a batch file on Windows", () => {
  it("is a .cmd or .bat at the end of a string command, on Windows only", () => {
    expect(batchFile("C:\\npm\\mcpcage.CMD", "win32")).toBe(".cmd");
    expect(batchFile("mcpcage.cmd", "linux")).toBeUndefined();
    expect(batchFile(["mcpcage.cmd"], "win32")).toBeUndefined();
    expect(batchFile("mcpcage.cmd.exe", "win32")).toBeUndefined();
  });
});

describe("a temporary place", () => {
  it("is the cache of npx or pnpm dlx wherever it is, its node_modules included", () => {
    expect(inTemporaryPlace("_npx/0a1b/node_modules/mcpcage")).toBe(true);
    expect(inTemporaryPlace("/Users/me/.npm/_npx/0a1b/node_modules")).toBe(true);
    expect(inTemporaryPlace("/Users/me/Library/Caches/pnpm/dlx/0123456789abcdef0123456789abcdef/x/node_modules/.bin")).toBe(true);
    expect(inTemporaryPlace("/Users/me/my_npx/0a1b/node_modules")).toBe(false);
  });

  it("is never a relative path, wherever the current directory is", () => {
    vi.spyOn(process, "cwd").mockReturnValue(tmpdir());
    expect(inTemporaryPlace(join(tmpdir(), "mcpcage"))).toBe(true);
    expect(inTemporaryPlace("mcpcage")).toBe(false);
  });
});

describe.skipIf(windowsHost)("the mcpcage that runs from a package runner", () => {
  /** pnpm dlx: the package runs from pnpm's store, through a bin in its dlx cache put first on the PATH. */
  function pnpmDlx() {
    const store = fresh("store");
    const script = join(store, "cli.js");
    writeFileSync(script, "");
    const bin = join(fresh("cache"), "dlx", "0123456789abcdef0123456789abcdef", "x", "node_modules", ".bin");
    const shim = idleProgram(bin, "mcpcage");
    moveTemporaryDirectory();
    process.argv[1] = script;
    return { script, bin, shim };
  }

  it("is its bin in the runner's cache, for the command that names the running mcpcage", () => {
    // Not process.execPath, which is itself in npx's cache when the tests run under `npx node@22`.
    const other = join(fresh("other"), "mcpcage");
    const { script, bin, shim } = pnpmDlx();
    vi.stubEnv("PATH", ["relative-dir", bin].join(delimiter));
    expect(runningFrom()).toBe(shim);
    expect(temporaryMcpcage({ node: other, script })).toBe(shim);
    expect(temporaryMcpcage(other)).toBeUndefined();
    expect(temporaryMcpcage({ node: other, script: other })).toBeUndefined();
  });

  it("is its script when that is in a temporary place, written in full or in a runner's cache", () => {
    const elsewhere = join(fresh("elsewhere"), "mcpcage");
    moveTemporaryDirectory();
    const script = join(tmpdir(), "bunx-501-mcpcage", "node_modules", "mcpcage", "dist", "cli.js");
    process.argv[1] = script;
    expect(runningFrom()).toBe(script);
    expect(temporaryMcpcage(elsewhere)).toBeUndefined();
    process.argv[1] = "_npx/0a1b/node_modules/mcpcage/dist/cli.js";
    vi.stubEnv("PATH", "");
    expect(runningFrom()).toBeUndefined();
  });

  it("is nothing for a running mcpcage whose script is not known, and asks no file about it", () => {
    const gone = join(fresh("gone"), "mcpcage");
    const { bin } = pnpmDlx();
    vi.stubEnv("PATH", bin);
    process.argv[1] = "relative.js";
    expect(temporaryMcpcage(gone)).toBeUndefined();
    process.argv.length = 1;
    expect(temporaryMcpcage(gone)).toBeUndefined();
    expect(mcpcageAt({ command: resolve("package.json"), args: run })).toBe("other program");
    process.argv[1] = "package.json";
    expect(mcpcageAt({ command: resolve("package.json"), args: run })).toBe("other program");
  });

  it("leaves the runner's directories out of the user's PATH", () => {
    const project = fresh("project");
    const projectBin = join(project, "node_modules", ".bin");
    idleProgram(projectBin, "mcpcage");
    const user = fresh("user");
    const mine = idleProgram(user, "mcpcage");
    const temporary = moveTemporaryDirectory();
    idleProgram(join(temporary, "xfs-1234"), "mcpcage");
    // Not a runner's: a directory whose name only starts like one.
    const tools = join(project, "node_modules", ".bin-tools");
    const theirs = idleProgram(tools, "mcpcage");
    vi.stubEnv("PATH", [projectBin, `${projectBin}/`, join(temporary, "xfs-1234"), "relative", tools, user].join(delimiter));
    // Not run from a runner: the user's PATH as it is.
    expect(commandOnPath("mcpcage")).toBe(join(projectBin, "mcpcage"));
    process.argv[1] = join(temporary, "bunx-501-mcpcage", "node_modules", "mcpcage", "dist", "cli.js");
    expect(commandOnPath("mcpcage")).toBe(theirs);
    vi.stubEnv("PATH", [projectBin, `${projectBin}/`, join(temporary, "xfs-1234"), "relative", user].join(delimiter));
    expect(commandOnPath("mcpcage")).toBe(mine);
  });
});

describe.skipIf(windowsHost)("what an entry's command starts", () => {
  /** The user's mcpcage, first on their PATH, and an entry that starts mcpcage by its bare name. */
  function installed() {
    const user = fresh("user");
    const mine = idleProgram(user, "mcpcage");
    const evil = fresh("evil");
    idleProgram(evil, "mcpcage");
    vi.stubEnv("PATH", user);
    return { user, mine, evil };
  }

  it("is the user's mcpcage only when wrap's command finds the same file", () => {
    const { mine } = installed();
    expect(mcpcageAt({ command: "mcpcage", args: run }, "mcpcage")).toBe("installed");
    expect(mcpcageAt({ command: mine, args: run }, "mcpcage")).toBe("installed");
    // Without a command of wrap's, only the running mcpcage counts.
    expect(mcpcageAt({ command: "mcpcage", args: run })).toBe("other program");
  });

  it("looks a bare name up in the PATH the entry sets, where a relative or unreadable directory leaves it unknown", () => {
    const { user, evil } = installed();
    expect(mcpcageAt({ command: "mcpcage", args: run, env: { PATH: evil } }, "mcpcage")).toBe("other program");
    expect(mcpcageAt({ command: "mcpcage", args: run, env: { PATH: ["relative", user].join(delimiter) } }, "mcpcage")).toBe("other program");
    expect(mcpcageAt({ command: "mcpcage", args: run, env: { PATH: 5 } }, "mcpcage")).toBe("other program");
  });

  it("skips a relative directory of the user's own PATH when it looks for wrap's command", () => {
    const { user, mine } = installed();
    vi.stubEnv("PATH", ["relative", user].join(delimiter));
    expect(mcpcageAt({ command: mine, args: run }, "mcpcage")).toBe("installed");
  });

  it("finds a program in an absolute directory only, and only one that can be run", () => {
    const { user, mine } = installed();
    expect(commandOnPath("mcpcage", ["relative", user].join(delimiter))).toBe(mine);
    expect(commandOnPath("x/mcpcage", user)).toBeUndefined();
    expect(commandOnPath("vitest", join("node_modules", ".bin"))).toBeUndefined();
    writeFileSync(join(user, "plain"), "data\n");
    chmodSync(join(user, "plain"), 0o644);
    expect(commandOnPath("plain", user)).toBeUndefined();
  });

  it("takes for mcpcage's own the cli.js npm installs next to the mcpcage the user's PATH finds", () => {
    const { user } = installed();
    expect(installedScript()).toBeUndefined();
    const script = join(user, "node_modules", "mcpcage", "dist", "cli.js");
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    expect(installedScript()).toBe(script);
    vi.stubEnv("PATH", fresh("empty"));
    expect(installedScript()).toBeUndefined();
  });
});

describe("what an entry's command starts on Windows", () => {
  it("is mcpcage for the node and cli.js --fix wrote, whichever node that is", () => {
    const dir = fresh("fix");
    const script = join(dir, "cli.js");
    const node = join(dir, "node");
    writeFileSync(script, "");
    writeFileSync(node, "");
    expect(onWindows(() => mcpcageAt({ command: node, args: [script, ...run] }, { node, script }))).toBe("installed");
    expect(onWindows(() => mcpcageAt({ command: node, args: [script, ...run] }))).toBe("other program");
  });

  it("reads the PATH of an entry under any case of its name", () => {
    expect(onWindows(() => foreignPath({ Path: "\\evil\\bin" }))).toEqual({ dirs: ["\\evil\\bin"] });
  });

  it("finds a program by the extensions Windows starts, spelled as npm writes them, and a name with its own as it is", () => {
    const first = fresh("first");
    const second = fresh("second");
    writeFileSync(join(first, "mcpcage"), "");
    writeFileSync(join(second, "mcpcage.cmd"), "");
    writeFileSync(join(second, "tool.cmd"), "");
    vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD;");
    expect(onWindows(() => commandOnPath("mcpcage", [first, second].join(delimiter)))).toBe(join(second, "mcpcage.cmd"));
    expect(onWindows(() => commandOnPath("tool.cmd", second))).toBe(join(second, "tool.cmd"));
  });
});

describe.skipIf(windowsHost)("the PATH an entry sets", () => {
  it("is not the user's for a directory the user's PATH names only relatively", () => {
    vi.stubEnv("PATH", "relbin");
    expect(foreignPath({ PATH: join(process.cwd(), "relbin") })).toEqual({ dirs: [join(process.cwd(), "relbin")] });
  });

  it("is the user's for a directory written in another case, where the system ignores case", () => {
    vi.stubEnv("PATH", "/nowhere-mcpcage/BIN");
    expect(foreignPath({ PATH: "/nowhere-mcpcage/bin" })).toEqual(process.platform === "darwin" ? undefined : { dirs: ["/nowhere-mcpcage/bin"] });
  });
});

describe.skipIf(windowsHost)("the variables of an entry that move the clients' configurations", () => {
  it("are those that move them for this system, under their own names, or that are not strings", () => {
    expect(movedPlaces({ COPILOT_HOME: "/elsewhere/copilot", API_KEY: "x" })).toEqual(["COPILOT_HOME"]);
    expect(movedPlaces({ copilot_home: "/elsewhere/copilot" })).toEqual([]);
    expect(movedPlaces({ APPDATA: 5, LOCALAPPDATA: 5, XDG_CONFIG_HOME: 5, COPILOT_HOME: 5, OTHER: 5 })).toEqual(["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "COPILOT_HOME"]);
    expect(movedPlaces({ XDG_CONFIG_HOME: "/elsewhere/config" })).toEqual(process.platform === "linux" ? ["XDG_CONFIG_HOME"] : []);
    expect(movedPlaces("COPILOT_HOME=/x")).toEqual([]);
  });
});

describe("an envFile", () => {
  const configFile = (dir: string) => join(dir, "mcp.json");

  it("fills in ${userHome} and the path separator, and reads nothing named with another variable", () => {
    const dir = fresh("envfile");
    writeFileSync(join(dir, ".env"), "A=1\n");
    writeFileSync(join(dir, "${other}.env"), "B=2\n");
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    expect(envFileOf({ envFile: "${userHome}/.env" }, configFile(dir))?.variables).toEqual({ A: "1" });
    expect(envFileOf({ envFile: `${dir}\${pathSeparator}.env` }, configFile(dir))?.variables).toEqual({ A: "1" });
    expect(envFileOf({ envFile: `${dir}\${/}.env` }, configFile(dir))?.variables).toEqual({ A: "1" });
    expect(envFileOf({ envFile: `${dir}/\${other}.env` }, configFile(dir))).toEqual({ path: `${dir}/\${other}.env`, variables: undefined });
    expect(envFileOf({ envFile: `${dir}/\${env:X}` }, configFile(dir))?.variables).toBeUndefined();
    // A relative path depends on what the editor has open.
    expect(envFileOf({ envFile: "package.json" }, configFile(dir))?.variables).toBeUndefined();
  });

  it("knows ${workspaceFolder} in a project's own configuration only", () => {
    const home = fresh("home");
    const project = join(home, "project");
    mkdirSync(join(project, ".vscode"), { recursive: true });
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(project, ".env"), "A=1\n");
    writeFileSync(join(home, ".env"), "B=2\n");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(envFileOf({ envFile: "${workspaceFolder}/.env" }, join(project, ".vscode", "mcp.json"))?.variables).toEqual({ A: "1" });
    mkdirSync(join(home, "elsewhere", "conf"), { recursive: true });
    writeFileSync(join(home, "elsewhere", ".env"), "C=3\n");
    expect(envFileOf({ envFile: "${workspaceFolder}/.env" }, join(home, "elsewhere", "conf", "mcp.json"))?.variables).toBeUndefined();
    // ~/.cursor/mcp.json is Cursor's user configuration.
    expect(envFileOf({ envFile: "${workspaceFolder}/.env" }, join(home, ".cursor", "mcp.json"))?.variables).toBeUndefined();
  });

  it("is read up to its size limit, and not past it", () => {
    const dir = fresh("big");
    const line = "A=1\n";
    writeFileSync(join(dir, "full.env"), line + "#".repeat(MAX_ENV_FILE_BYTES - line.length));
    writeFileSync(join(dir, "over.env"), line + "#".repeat(MAX_ENV_FILE_BYTES - line.length + 1));
    expect(envFileOf({ envFile: join(dir, "full.env") }, configFile(dir))?.variables).toEqual({ A: "1" });
    expect(envFileOf({ envFile: join(dir, "over.env") }, configFile(dir))?.variables).toBeUndefined();
  });

  it("is read line by line as dotenv reads it, whatever ends the lines", () => {
    expect(parseEnvFile("A=1\rB=2\r\nC=3")).toEqual({ A: "1", B: "2", C: "3" });
    expect(parseEnvFile("  export D=4\nexport  E: 5\nF=export x\n=nameless")).toEqual({ D: "4", E: "5", F: "export x" });
    expect(parseEnvFile("G=h: i")).toEqual({ G: "h: i" });
    expect(parseEnvFile('J=x "y"\nK="k" l\nL="l" # note')).toEqual({ J: 'x "y"', K: '"k" l', L: "l" });
  });
});
