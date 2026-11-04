import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { envFileOf, foreignPath, MAX_ENV_FILE_BYTES, mcpcageAt, nodeScript, parseEnvFile } from "../src/installed.js";
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
      expect(mcpcageAt({ command: "mcpcage" }, command)).toBe("installed");
      expect(mcpcageAt({ command: "mcpcage", env: { PATH: bin } }, command)).toBe("installed");
      expect(mcpcageAt({ command }, "mcpcage")).toBe("installed");
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
