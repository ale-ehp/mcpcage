import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cageCheck, hostVariable, unwrapEntry, wrapEntry, type ServerEntry } from "../src/config.js";
import { idleProgram, onWindows } from "./fake-programs.js";

describe("the variables of an entry that act on the host", () => {
  it("each say what they would do there, and where they go", () => {
    const loads = "can load code into mcpcage on your machine before the cage starts";
    const table: Array<[string, unknown, ReturnType<typeof hostVariable>]> = [
      ["NODE_OPTIONS", "--require ./x.cjs", { to: "container", what: "can make Node run code on your machine before the cage starts" }],
      // A value that only looks like a local socket is no reason to leave any other variable alone.
      ["NODE_OPTIONS", "unix://x", { to: "container", what: "can make Node run code on your machine before the cage starts" }],
      ["NODE_ENV", "production", undefined],
      ["NODE_ENV_X", "1", { to: "container", what: "can make Node run code on your machine before the cage starts" }],
      ["NODE_NODE_ENV", "1", { to: "container", what: "can make Node run code on your machine before the cage starts" }],
      ["LD_PRELOAD", "/tmp/x.so", { to: "container", what: loads }],
      ["DYLD_INSERT_LIBRARIES", "/tmp/x.dylib", { to: "container", what: loads }],
      ["GCONV_PATH", "/tmp", { to: "container", what: loads }],
      ["OPENSSL_CONF", "/tmp/x.cnf", { to: "container", what: "can make OpenSSL load code into mcpcage on your machine before the cage starts" }],
      ["OPENSSL_MODULES_DIR", "/tmp", { to: "container", what: "configures OpenSSL in mcpcage on your machine" }],
      ["OPENSSL_OPENSSL_CONF", "/tmp", { to: "container", what: "configures OpenSSL in mcpcage on your machine" }],
      ["DOCKER_HOST", "unix:///var/run/docker.sock", undefined],
      ["DOCKER_HOST", "npipe:////./pipe/docker_engine", undefined],
      ["DOCKER_HOST", "tcp://198.51.100.7:2375", { to: "container", what: "chooses the Docker that builds and runs the cage" }],
      // A remote daemon whose address ends like a socket's, and a socket given as a list, are no local socket.
      ["DOCKER_HOST", "tcp://198.51.100.7:2375/unix://", { to: "container", what: "chooses the Docker that builds and runs the cage" }],
      ["DOCKER_HOST", ["unix:///var/run/docker.sock"], { to: "container", what: "chooses the Docker that builds and runs the cage" }],
      ["DOCKER_CONTEXT", "remote", { to: "container", what: "chooses the Docker that builds and runs the cage" }],
      ["DOCKER_CONFIG", "/tmp", { to: "container", what: "configures the Docker that builds and runs the cage" }],
      ["DOCKER_HOST_X", "unix:///x", { to: "container", what: "configures the Docker that builds and runs the cage" }],
      ["DOCKER_DOCKER_HOST", "unix:///x", { to: "container", what: "configures the Docker that builds and runs the cage" }],
      ["npm_config_registry", "https://registry.example", { to: "container", what: "configures npm, which mcpcage runs on your machine" }],
      ["HOME", "/tmp/empty", { to: "drop", what: "changes the home directory mcpcage protects" }],
      ["MCPCAGE_HOME", "/tmp/empty", { to: "drop", what: "moves mcpcage's pins and audit log, so approvals start over" }],
    ];
    for (const [name, value, expected] of table) expect(hostVariable(name, value), `${name}=${JSON.stringify(value)}`).toEqual(expected);
  });

  it("on Windows also include the places Windows keeps its own code and settings", () => {
    onWindows(() => {
      expect(hostVariable("SystemRoot", "C:\\x")).toEqual({ to: "container", what: "is where Windows keeps its own code, which node loads from there as it starts mcpcage, before the cage starts" });
      expect(hostVariable("ProgramData", "C:\\x")).toEqual({ to: "container", what: "tells docker, npm and node on your machine where to find programs, plugins and settings" });
    });
  });
});

describe("an entry wrap cannot cage", () => {
  it("says why, for each kind of entry", () => {
    expect(wrapEntry({ args: ["-y", "x"] }, { command: "mcpcage" })).toEqual({ skip: "no command" });
    expect(wrapEntry({ command: "", args: ["-y", "x"] }, { command: "mcpcage" })).toEqual({ skip: "no command" });
    expect(wrapEntry({ command: "uvx", args: ["mcp-server-time"] }, { command: "mcpcage" })).toEqual({ skip: "uvx: only npx servers can be caged in this version" });
    expect(wrapEntry({ command: "docker", args: ["run", "-i", "mcp/time"] }, { command: "mcpcage" })).toEqual({
      skip: "docker: already containerized; `mcpcage run --image` can add pinning and audit",
    });
    expect(wrapEntry({ command: "npx" }, { command: "mcpcage" })).toEqual({ skip: "npx needs a package name" });
    // Configuration files are not type-checked.
    expect(wrapEntry({ command: "npx", args: "-y x" } as unknown as ServerEntry, { command: "mcpcage" })).toEqual({ skip: "its args are not a list" });
  });

  it.skipIf(process.platform === "win32")("writes a path with :rw or :ro inside it, not at its end, as it is", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mcpcage-paths-")), "a:rwx", "notes");
    mkdirSync(dir, { recursive: true });
    expect(wrapEntry({ command: "npx", args: ["-y", "server", dir] }, { command: "mcpcage" })).toEqual({ entry: { command: "mcpcage", args: ["run", "--mount", dir, "--", "npx", "-y", "server", dir] } });
  });
});

describe("unwrap", () => {
  it("leaves an mcpcage entry without a command after -- as it is", () => {
    for (const args of [["run"], ["run", "--mount", "/x"], ["run", "--"]]) {
      expect(unwrapEntry({ command: "mcpcage", args }), JSON.stringify(args)).toEqual({ skip: "unexpected mcpcage arguments" });
    }
  });
});

describe("the check of an entry wrap is about to write", () => {
  const run = ["run", "--", "npx", "-y", "rogue"];

  it("says when the entry's PATH would start another program than mcpcage", () => {
    const evil = mkdtempSync(join(tmpdir(), "mcpcage-evil-"));
    idleProgram(evil, "mcpcage");
    const entry = { command: "mcpcage", args: run, env: { PATH: evil } };
    const where = "so what the client starts depends on the directory it starts the entry from: give the full path of mcpcage with --command";
    const bare = `mcpcage is a bare name, which Windows looks for in the client's current directory first, ${where}`;
    expect(cageCheck(entry, { command: "mcpcage", configFile: join(evil, "mcp.json") })).toBe(
      process.platform === "win32" ? bare : `its env sets a PATH that makes the client start another program than mcpcage: check that PATH, or remove it from its "env" by hand`,
    );
    expect(onWindows(() => cageCheck(entry, { command: "mcpcage", configFile: join(evil, "mcp.json") }))).toBe(bare);
    // On Windows, given node and its cli.js as --fix writes them, which are full paths, for an entry that starts another node.
    const other = { command: "node", args: ["cli.js", ...run] };
    const command = { node: "/nodejs/node.exe", script: "/mcpcage/dist/cli.js" };
    expect(onWindows(() => cageCheck(other, { command, configFile: join(evil, "mcp.json") }))).toBe(
      `its env sets a PATH that makes the client start another program than mcpcage: check that PATH, or remove it from its "env" by hand`,
    );
  });

  it("says when its envFile cannot be read", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "mcpcage-env-")), "missing.env");
    const entry = { command: join(tmpdir(), "no-mcpcage-here", "mcpcage"), args: run, envFile: missing };
    expect(cageCheck(entry, { command: entry.command, configFile: join(tmpdir(), "mcp.json") })).toBe(
      `its envFile ${missing} could not be read, so what it sets is unknown: check that file, or move what it sets into its "env"`,
    );
  });
});
