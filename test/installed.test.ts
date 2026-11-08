// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { envFileOf, foreignPath, MAX_ENV_FILE_BYTES, mcpcageAt, nodeScript, parseEnvFile, temporaryMcpcage } from "../src/installed.js";
import { idleProgram, onWindows } from "./fake-programs.js";

// What an entry's own env decides on the host for the mcpcage it starts. The report's lines and
// --fix's plan for them are in protect.test.ts.

describe("the PATH an entry sets", () => {
  it("compares directories as they resolve, and never takes a relative one of the user's PATH for theirs", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-path-"));
    const real = join(top, "real");
    mkdirSync(real);
    symlinkSync(real, join(top, "link"));
    const missing = join(top, "missing");
    vi.stubEnv("PATH", [join(top, "link"), "relative", missing].join(delimiter));
    try {
      expect(foreignPath({ PATH: real })).toBeUndefined();
      // Not there: compared as written, `..` and a final separator resolved.
      expect(foreignPath({ PATH: `${join(missing, "..", "missing")}${sep}` })).toBeUndefined();
      expect(foreignPath({ PATH: `relative${delimiter}${real}${delimiter}${delimiter}relative` })).toEqual({ dirs: ["relative", ""] });
      expect(foreignPath({ PATH: join(top, "other") })).toEqual({ dirs: [join(top, "other")] });
      expect(foreignPath({ PATH: ["x"] })).toEqual({ dirs: [], notString: true });
      expect([foreignPath({}), foreignPath(undefined), foreignPath({ Path: join(top, "other") })]).toEqual([undefined, undefined, process.platform === "win32" ? { dirs: [join(top, "other")] } : undefined]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the PATH an entry sets, on Windows", () => {
  it.runIf(process.platform === "win32")("compares directories by the names Windows keeps on disk, not by their 8.3 short names", () => {
    // Installers put directories on the PATH by their short names too (C:\PROGRA~1\...).
    const dir = join(mkdtempSync(join(tmpdir(), "mcpcage-path-")), "Program Files");
    mkdirSync(dir);
    const short = execSync(`for %I in ("${dir}") do @echo %~sI`, { encoding: "utf8" }).trim();
    vi.stubEnv("PATH", short);
    try {
      expect(foreignPath({ PATH: dir })).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the mcpcage an entry starts", () => {
  it("is the command --fix writes when a bare mcpcage finds that file, however its name is spelled there", () => {
    // On Windows a bare name is found with an extension of PATHEXT, which Windows spells in capitals,
    // while `where`, from which --fix takes its command, spells the file as it is on disk: mcpcage.cmd.
    const bin = join(mkdtempSync(join(tmpdir(), "mcpcage-which-")), "bin");
    const command = idleProgram(bin, "mcpcage");
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
    try {
      // In an entry, a bare name is looked up as the client looks it up: on Windows its current
      // directory comes first, so there it is never taken for mcpcage (see the test below).
      const bare = process.platform === "win32" ? "other program" : "installed";
      expect(mcpcageAt({ command: "mcpcage" }, command)).toBe(bare);
      expect(mcpcageAt({ command: "mcpcage", env: { PATH: bin } }, command)).toBe(bare);
      expect(mcpcageAt({ command }, "mcpcage")).toBe("installed");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is never a bare mcpcage on Windows, which looks in the client's current directory first", () => {
    // npm's mcpcage.cmd, on the PATH.
    const bin = mkdtempSync(join(tmpdir(), "mcpcage-which-"));
    const command = join(bin, "mcpcage.cmd");
    writeFileSync(command, "@exit /b 0\r\n");
    vi.stubEnv("PATH", bin);
    try {
      expect(onWindows(() => [mcpcageAt({ command: "mcpcage" }, command), mcpcageAt({ command: "MCPCAGE.CMD" }, command)])).toEqual(["other program", "other program"]);
      // mcpcage's own lookup of the command --fix writes still finds it in the PATH.
      expect(onWindows(() => mcpcageAt({ command }, "mcpcage"))).toBe("installed");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /** A node install and an mcpcage install as files: nothing here starts them. */
  function installs() {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-node-form-"));
    const file = (path: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "");
      return path;
    };
    return {
      top,
      node: file(join(top, "nodejs", "node.exe")),
      script: file(join(top, "npm", "node_modules", "mcpcage", "dist", "cli.js")),
      otherNode: file(join(top, "evil", "node.exe")),
      otherScript: file(join(top, "evil", "dist", "cli.js")),
    };
  }
  const server = ["--", "npx", "-y", "@acme/notes-mcp"];

  it("is node.exe with cli.js, as --fix writes on Windows, only when both are the ones mcpcage trusts", () => {
    const { top, node, script, otherNode, otherScript } = installs();
    const own = { node, script };
    // The node running mcpcage (process.execPath) is `node`; the PATH finds no other.
    vi.stubEnv("PATH", join(top, "no-node-here"));
    try {
      const at = (command: string, first: string) => onWindows(() => mcpcageAt({ command, args: [first, "run", ...server] }, own), node);
      expect(at(node, script)).toBe("installed");
      // A configuration can name any node.exe, which need not run the script, and any cli.js.
      expect(at(otherNode, script)).toBe("other program");
      expect(at(node, otherScript)).toBe("other program");
      // Through a link to it, the script is the same file.
      const link = join(top, "link", "cli.js");
      mkdirSync(join(link, ".."));
      symlinkSync(script, link);
      expect(at(node, link)).toBe("installed");
      // A bare node is looked for in the client's directory first; a relative script depends on it.
      expect(at("node.exe", script)).toBe("other program");
      expect(at(node, join("dist", "cli.js"))).toBe("other program");
      expect(at(join(top, "gone", "node.exe"), script)).toBe("not found");
      expect(at(node, join(top, "gone", "cli.js"))).toBe("not found");
      // Without --fix's own command, the running node and mcpcage are the ones trusted: here neither is.
      expect(onWindows(() => mcpcageAt({ command: node, args: [script, "run", ...server] }), otherNode)).toBe("other program");
      // The node the user's PATH finds counts as theirs.
      vi.stubEnv("PATH", dirname(otherNode));
      expect(at(otherNode, script)).toBe("installed");
      // On macOS and Linux this is a node server like any other.
      expect(nodeScript({ command: node, args: [script, "run", ...server] }, "linux")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a mcpcage in a temporary place", () => {
  it("is one a package runner put there for one run, never one installed to stay", () => {
    const tmp = tmpdir();
    const hash = "b489b5c1fe5d71f4d93d787598fab2c36fd70050c32eecae19857c1e3f765bae";
    // Where npx, pnpm dlx, bunx and yarn dlx put mcpcage (seen with npm 11.19, pnpm 11.1.3, bun
    // 1.4.0 and yarn 4.18.1), and the system's temporary directory however it is spelled.
    const temporary = [
      "/Users/me/.npm/_npx/42a5f783a5f9e73f/node_modules/.bin/mcpcage",
      "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9ca5ed00adf12b8e\\node_modules\\mcpcage\\dist\\cli.js",
      `/Users/me/Library/Caches/pnpm/dlx/${hash}/1a1a8215878-1303d/node_modules/.bin/mcpcage`,
      `C:\\Users\\me\\AppData\\Local\\pnpm-cache\\dlx\\${hash}\\1a1a8215878-1303d\\node_modules\\.bin\\mcpcage.cmd`,
      join(tmp, "bunx-501-mcpcage@latest", "node_modules", ".bin", "mcpcage"),
      join(realpathSync.native(tmp), "xfs-dc57caf4", "dlx-78139", ".yarn", "cache", "mcpcage-npm-0.6.0-6a7fe3cc27-705fa9ae40.zip", "node_modules", "mcpcage", "dist", "cli.js"),
      join(tmp, "xfs-a043b06b", "mcpcage"),
      join(tmp, "mcpcage"),
    ];
    if (process.platform === "darwin" || process.platform === "win32") temporary.push(join(tmp.toUpperCase(), "bunx-501-mcpcage@latest", "node_modules", ".bin", "mcpcage"));
    for (const path of temporary) expect(temporaryMcpcage(path), path).toBe(path);
    expect(temporaryMcpcage({ node: "C:\\Program Files\\nodejs\\node.exe", script: temporary[1]! })).toBe(temporary[1]);

    // Where npm -g (Homebrew's node too), pnpm add -g, bun add -g, Volta and nvm install it, and
    // npm link of a clone; and a bare name, which the client looks up in its own PATH.
    const installed = [
      "/usr/local/bin/mcpcage",
      "/usr/local/lib/node_modules/mcpcage/dist/cli.js",
      "/opt/homebrew/bin/mcpcage",
      "/opt/homebrew/lib/node_modules/mcpcage/dist/cli.js",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\mcpcage.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\mcpcage\\dist\\cli.js",
      "/Users/me/Library/pnpm/mcpcage",
      "/Users/me/Library/pnpm/global/v11/1309c-1a1a821d9dd/node_modules/mcpcage/dist/cli.js",
      "/Users/me/Library/pnpm/store/v11/links/@/mcpcage/0.6.0/ec517a99282abea554de827deab9e30378de79624e846ace8ee50ea2feb9e6f9/node_modules/mcpcage/dist/cli.js",
      "C:\\Users\\me\\AppData\\Local\\pnpm\\mcpcage.cmd",
      "/Users/me/.bun/bin/mcpcage",
      "/Users/me/.bun/install/global/node_modules/mcpcage/dist/cli.js",
      "/Users/me/.volta/bin/mcpcage",
      "/Users/me/.volta/tools/image/packages/mcpcage/lib/node_modules/mcpcage/dist/cli.js",
      "/Users/me/.nvm/versions/node/v22.20.0/bin/mcpcage",
      "/Users/me/.nvm/versions/node/v22.20.0/lib/node_modules/mcpcage/dist/cli.js",
      "/Users/me/src/mcpcage/dist/cli.js",
      "/Users/me/src/dlx/notes/node_modules/.bin/mcpcage",
      "mcpcage",
    ];
    for (const path of installed) expect(temporaryMcpcage(path), path).toBeUndefined();
    expect(temporaryMcpcage({ node: "C:\\Program Files\\nodejs\\node.exe", script: installed[5]! })).toBeUndefined();
  });

  it("is a link into one, whatever the link's own path", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-temporary-"));
    const cache = join(top, "npm-cache", "_npx", "4d1f392c9a3fd6e1", "node_modules", "mcpcage", "dist");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "cli.js"), "");
    // A link outside every temporary place: tmpdir() is the one the tests share, the PATH is not.
    const stable = join(top, "stable");
    vi.stubEnv("TMPDIR", stable);
    vi.stubEnv("TMP", stable);
    vi.stubEnv("TEMP", stable);
    try {
      const link = join(top, "bin", "mcpcage");
      mkdirSync(dirname(link));
      symlinkSync(join(cache, "cli.js"), link);
      expect(temporaryMcpcage(link)).toBe(link);
      expect(temporaryMcpcage(join(top, "bin", "other"))).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the envFile an entry names", () => {
  it("finds every variable of a dotenv file that VS Code could find, and keeps a value it could cut whole", () => {
    const text = [
      "# a comment",
      "",
      "API_KEY=sk-live-0123456789",
      "export NODE_OPTIONS=--require ./x.cjs",
      "  DOCKER_HOST = 'unix:///var/run/docker.sock' # the local socket",
      'PATH="/usr/bin:/bin"',
      "BASH_ENV: /tmp/x",
      "BASH_FUNC_dirname%%=() { touch /tmp/x; }",
      // Parsers differ on a comment after a value that is not quoted: kept, rather than cut.
      "PLAIN=value # a comment",
      'MULTI="first line',
      // Inside a value quoted over two lines: counted all the same, rather than missed.
      "LD_PRELOAD=/tmp/hook.so",
      'last line"',
      "not a variable",
      "#COMMENTED=1",
      "KEY:no-space",
    ].join("\r\n");
    expect(parseEnvFile(text)).toEqual({
      API_KEY: "sk-live-0123456789",
      NODE_OPTIONS: "--require ./x.cjs",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PATH: "/usr/bin:/bin",
      BASH_ENV: "/tmp/x",
      "BASH_FUNC_dirname%%": "() { touch /tmp/x; }",
      PLAIN: "value # a comment",
      MULTI: '"first line',
      LD_PRELOAD: "/tmp/hook.so",
    });
    expect(JSON.stringify(parseEnvFile("__proto__=x\n"))).toBe('{"__proto__":"x"}');
  });

  it("finds the file of a project's configuration, and calls unknown what it cannot name or read", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-envfile-"));
    const project = join(top, "work");
    mkdirSync(project);
    const vscode = join(project, ".vscode", "mcp.json");
    writeFileSync(join(project, ".env"), "NODE_OPTIONS=--require ./x.cjs\n");
    const variables = { NODE_OPTIONS: "--require ./x.cjs" };
    expect(envFileOf({ envFile: "${workspaceFolder}/.env" }, vscode)).toEqual({ path: "${workspaceFolder}/.env", variables });
    expect(envFileOf({ envFile: "${workspaceFolder}${/}.env" }, join(project, ".cursor", "mcp.json"))).toEqual({ path: "${workspaceFolder}${/}.env", variables });
    expect(envFileOf({ envFile: join(project, ".env") }, join(top, "anywhere.json"))).toEqual({ path: join(project, ".env"), variables });
    const unknown = (envFile: unknown, file = vscode) => {
      const found = envFileOf({ envFile }, file);
      expect(found).toBeDefined();
      expect(found!.variables).toBeUndefined();
      return found!.path;
    };
    // In a user's configuration, the folder the editor has open is not known: ~/.cursor/mcp.json is Cursor's.
    expect(unknown("${workspaceFolder}/.env", join(top, "Code", "User", "mcp.json"))).toBe("${workspaceFolder}/.env");
    unknown("${workspaceFolder}/.env", join(homedir(), ".cursor", "mcp.json"));
    unknown(".env");
    unknown("${env:HOME}/.env");
    unknown(join(project, "missing.env"));
    unknown(project);
    // Over 1 MiB: sparse, nothing written.
    const large = join(top, "large.env");
    writeFileSync(large, "NODE_OPTIONS=--require ./x.cjs\n");
    truncateSync(large, MAX_ENV_FILE_BYTES + 1);
    unknown(large);
    expect(unknown(1)).toBeUndefined();
    expect([envFileOf({}, vscode), envFileOf({ envFile: null }, vscode)]).toEqual([undefined, undefined]);
  });

  // Opening a FIFO waits for a writer: one in place of the .env would have stopped protect.
  it.skipIf(process.platform === "win32")("reads no FIFO", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-envfile-"));
    const fifo = join(top, ".env");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    expect(envFileOf({ envFile: fifo }, join(top, "mcp.json"))).toEqual({ path: fifo });
  });
});
