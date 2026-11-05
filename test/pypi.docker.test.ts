// Runs only with `npm run test:docker`: needs a working Docker daemon and the network, for PyPI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLaunch, type PypiLaunch } from "../src/launch.js";
import { checkLock, lockPypi, wheelPlatform } from "../src/pypi.js";
import { dockerAvailable } from "../src/sandbox.js";
import { freshHome } from "./helpers.js";

const docker = dockerAvailable();
const home = freshHome();

function pypi(...argv: string[]): PypiLaunch {
  const spec = parseLaunch(argv, undefined, "linux");
  if (spec.kind !== "pypi") throw new Error("not a pypi spec");
  return spec;
}

describe.skipIf(!docker.ok)("resolving PyPI servers (real Docker, PyPI)", () => {
  beforeAll(() => {
    vi.stubEnv("MCPCAGE_HOME", home);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("locks mcp-server-time on Python 3.13, every package hashed, the server at the version step 1 chose", () => {
    const log: string[] = [];
    const locked = lockPypi("time", pypi("uvx", "mcp-server-time"), { log: (line) => log.push(line) });
    expect(locked.packageName).toBe("mcp-server-time");
    expect(locked.version).toMatch(/^\d+(\.\d+)+$/);
    expect(locked.python).toBe("3.13");
    expect(locked.platform).toBe(wheelPlatform());
    const lock = readFileSync(join(home, "servers", "time", "requirements.lock"), "utf8");
    expect(lock).toBe(locked.lock);
    expect(() => checkLock(lock, { name: "mcp-server-time", version: locked.version })).not.toThrow();
    expect(lock).toMatch(new RegExp(`^mcp-server-time==${locked.version.replace(/\./g, "\\.")} \\\\$`, "m"));
    expect(lock).toMatch(/^mcp==/m);
    expect(log.join("\n")).toContain(`mcp-server-time ${locked.version} on Python 3.13`);
  }, 180_000);

  // uvx would build uuid 1.30 from its 2008 source distribution on the host, running its setup.py.
  it("refuses dbt-mcp 2.10.1, whose uuid dependency ships no wheel, naming it", () => {
    expect(() => lockPypi("dbt", pypi("uvx", "dbt-mcp==2.10.1"), { log: () => {} })).toThrow(
      /^dbt-mcp cannot be installed from PyPI wheels on Python 3\.13, and the cage never builds a package from source: Because uuid==1\.30 has no usable wheels/,
    );
  }, 180_000);
});
