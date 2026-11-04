import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dockerAvailable, dockerProgram, npmProgram, npxProgram, runArgs } from "../src/sandbox.js";
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
  delete process.env.MCPCAGE_TEST_KEPT;
  process.chdir(cwd);
});

describe("docker and npm on the host, whatever an entry's PATH puts first", () => {
  it.skipIf(standardDocker === undefined)("finds docker in the standard places before the PATH, and runs it with a PATH of those places", () => {
    const fake = fakePrograms();
    process.env.PATH = fake.path;
    process.env.MCPCAGE_TEST_KEPT = "kept";
    const docker = dockerProgram()!;
    expect(docker.file).toBe(standardDocker);
    expect(docker.args).toEqual([]);
    expect(docker.env.PATH?.split(delimiter)).toEqual([...new Set([dirname(standardDocker!), ...STANDARD_PLACES])]);
    // The rest of the environment is mcpcage's: DOCKER_HOST and the like are the user's own here.
    expect(docker.env.MCPCAGE_TEST_KEPT).toBe("kept");
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
