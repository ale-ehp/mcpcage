// Runs only with `npm run test:docker`: needs a working Docker daemon and network for the first build.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "../src/sandbox.js";
import { builtImages } from "./docker-images.js";
import { fakePrograms, standardDocker } from "./fake-programs.js";
import { connect, freshHome, mcpcage, mcpcageWithEnv, root } from "./helpers.js";

const probePackage = join(root, "test", "fixtures", "probe-server");
const docker = dockerAvailable();
const home = freshHome();
const server = ["npx", "-y", probePackage, "--greeting", "hello"];
const images = builtImages();

interface Probe {
  uid: number;
  gid: number;
  home: string;
  args: string[];
  env: string[];
  writeOwnCode: true | string;
  writeTmp: true | string;
  hostUsersDirVisible: boolean;
  postinstallRan: boolean;
  network: string;
}

async function probe(runArgs: string[], env: Record<string, string> = {}): Promise<Probe> {
  const session = await connect({ home, runArgs: ["--id", "probe", ...runArgs], server, env });
  await session.client.listTools(); // like every MCP client does before calling tools
  const result = await session.client.callTool({ name: "probe", arguments: {} });
  await session.close();
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Probe;
}

describe.skipIf(!docker.ok)("caged npm server (real Docker)", () => {
  beforeAll(() => {
    const prepared = images.track(mcpcage(home, "prepare", "--id", "probe", "--", ...server), home);
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(prepared.stdout).toContain("mcpcage-probe@1.0.0");
  }, 600_000);

  // The images built here are used by the tests below and removed once they are done, failed or not.
  afterAll(() => images.remove(), 120_000);

  it("runs as nonroot, read-only, without network, host files or install scripts", async () => {
    const report = await probe(["--env", "PROBE_ALLOWED"], { PROBE_ALLOWED: "yes", SECRET_TOKEN: "must-not-leak" });
    expect(report.uid).toBe(65532);
    expect(report.gid).toBe(65532);
    expect(report.writeOwnCode).toBe("EROFS");
    expect(report.writeTmp).toBe(true);
    expect(report.home).toBe("/tmp");
    expect(report.hostUsersDirVisible).toBe(false);
    expect(report.postinstallRan).toBe(false);
    expect(report.network).toMatch(/^blocked/);
    expect(report.env).toContain("PROBE_ALLOWED");
    expect(report.env).not.toContain("SECRET_TOKEN");
    expect(report.args).toEqual(["--greeting", "hello"]);
  }, 120_000);

  it("reuses the pinned image instead of resolving the package again", async () => {
    const before = JSON.parse(readFileSync(join(home, "servers", "probe", "server.json"), "utf8"));
    await probe([]);
    const after = JSON.parse(readFileSync(join(home, "servers", "probe", "server.json"), "utf8"));
    expect(after.imageId).toBe(before.imageId);
    expect(after.builtAt).toBe(before.builtAt);
    expect(after.integrity).toMatch(/^sha512-/);
  }, 120_000);

  // Docker keys its build cache on the Dockerfile's lines and the files copied, which are the same in
  // every fresh build of a package: the install that any earlier build of it left in the cache came
  // back, so a new server, and --rebuild, got the version npm resolved then. The layers are compared,
  // not the image ids, which differ anyway with each server's label.
  it("resolves the package again for a new server and with --rebuild, not from Docker's build cache", () => {
    const layers = (id: string) => {
      const { image } = JSON.parse(readFileSync(join(home, "servers", id, "server.json"), "utf8")) as { image: string };
      const result = spawnSync("docker", ["image", "inspect", "--format", "{{json .RootFS.Layers}}", image], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as string[];
    };
    const fresh = images.track(mcpcage(home, "prepare", "--id", "probe-fresh", "--", ...server), home);
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(layers("probe-fresh")).not.toEqual(layers("probe"));
    const before = layers("probe-fresh");
    const rebuilt = images.track(mcpcage(home, "prepare", "--rebuild", "--id", "probe-fresh", "--", ...server), home);
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    expect(layers("probe-fresh")).not.toEqual(before);
  }, 600_000);

  it("gives network access only with --allow-net", async () => {
    const report = await probe(["--allow-net"]);
    expect(report.network).toMatch(/^reachable/);
  }, 120_000);

  it("cages an existing image with --image: nonroot, no network, pinned on first use", async () => {
    const { image } = JSON.parse(readFileSync(join(home, "servers", "probe", "server.json"), "utf8")) as { image: string };
    const session = await connect({ home, runArgs: ["--id", "probe-image", "--image", image], server: [] });
    await session.client.listTools();
    const result = await session.client.callTool({ name: "probe", arguments: {} });
    await session.close();
    const report = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Probe;
    expect(report.uid).toBe(65532);
    expect(report.network).toMatch(/^blocked/);
    expect(JSON.parse(readFileSync(join(home, "servers", "probe-image", "pin.json"), "utf8")).tools).toHaveProperty("probe");
  }, 120_000);

  it("records the sandbox in the audit log, intact", async () => {
    expect(mcpcage(home, "audit", "verify", "probe").code).toBe(0);
    const shown = mcpcage(home, "audit", "show", "probe", "--lines", "200").stdout;
    expect(shown).toContain('"mode":"docker"');
    expect(shown).toContain('"network":"none"');
    expect(shown).toContain('"package":"mcpcage-probe"');
  });

  // A client starts mcpcage with the PATH a server entry sets: what it puts first must not run.
  it.skipIf(standardDocker === undefined)("packs and builds with the npm next to node and the docker of a standard place, whatever comes first on the PATH", () => {
    const fake = fakePrograms();
    const prepared = images.track(mcpcageWithEnv({ ...process.env, MCPCAGE_HOME: home, PATH: fake.path }, "prepare", "--id", "probe-path", "--", ...server), home);
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(prepared.stdout).toContain("mcpcage-probe@1.0.0");
    expect(fake.ran()).toBe("");
  }, 600_000);

  it.skipIf(standardDocker === undefined)("starts the cage with the docker of a standard place, whatever comes first on the PATH", async () => {
    const fake = fakePrograms();
    const report = await probe(["--env", "PATH"], { PATH: fake.path });
    expect(report.uid).toBe(65532);
    expect(report.env).toContain("PATH");
    expect(fake.ran()).toBe("");
  }, 120_000);
});
