import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dockerProgram, npmProgram, runArgs } from "../src/sandbox.js";
import { fakePrograms, isProgram, STANDARD_PLACES, standardDocker } from "./fake-programs.js";
import { freshHome, mcpcageWithEnv } from "./helpers.js";

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
afterEach(() => {
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
  delete process.env.MCPCAGE_TEST_KEPT;
});

describe("docker and npm on the host, whatever an entry's PATH puts first", () => {
  it.skipIf(standardDocker === undefined)("finds docker in the standard places before the PATH, and runs it with a PATH of those places", () => {
    const fake = fakePrograms();
    process.env.PATH = fake.path;
    process.env.MCPCAGE_TEST_KEPT = "kept";
    const docker = dockerProgram();
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
    const npm = npmProgram();
    expect(npm.file).toBe(trustedNpm);
    expect(npm.args).toEqual([]);
    expect(npm.env.PATH?.split(delimiter)).toEqual([...new Set([dirname(trustedNpm!), ...STANDARD_PLACES])]);
    // npm's script starts with `#!/usr/bin/env node`.
    const version = spawnSync(npm.file, [...npm.args, "--version"], { encoding: "utf8", env: npm.env });
    expect(version.status, version.stderr).toBe(0);
    expect(fake.ran()).toBe("");
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
