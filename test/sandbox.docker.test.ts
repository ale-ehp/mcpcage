// Runs only with `npm run test:docker`: needs a working Docker daemon and network for the first build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "../src/sandbox.js";
import { fakePrograms, standardDocker } from "./fake-programs.js";
import { connect, freshHome, mcpcage, mcpcageWithEnv, root } from "./helpers.js";

const probePackage = join(root, "demo", "probe-server");
const docker = dockerAvailable();
const home = freshHome();
const server = ["npx", "-y", probePackage, "--greeting", "hello"];

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
    const prepared = mcpcage(home, "prepare", "--id", "probe", "--", ...server);
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(prepared.stdout).toContain("mcpcage-probe@1.0.0");
  }, 600_000);

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
    const prepared = mcpcageWithEnv({ ...process.env, MCPCAGE_HOME: home, PATH: fake.path }, "prepare", "--id", "probe-path", "--", ...server);
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
