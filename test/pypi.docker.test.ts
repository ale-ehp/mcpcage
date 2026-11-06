// Runs only with `npm run test:docker`: needs a working Docker daemon and the network, for PyPI and
// for the managed Python.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listTools } from "../src/inspect.js";
import { parseLaunch, type PypiLaunch } from "../src/launch.js";
import { buildPypiImage, checkLock, lockPypi, MANAGED_PYTHON, managedPython, preparePypiImage, pypiDockerfile, realDocker, wheelPlatform, type DockerRunner } from "../src/pypi.js";
import { dockerAvailable, prepareSandbox, PYPI_RESOLVE_BASE, type SandboxOptions } from "../src/sandbox.js";
import { builtImages } from "./docker-images.js";
import { connect, freshHome, mcpcage } from "./helpers.js";

const docker = dockerAvailable();
const home = freshHome();
const images = builtImages();

function pypi(...argv: string[]): PypiLaunch {
  const spec = parseLaunch(argv, undefined, "linux");
  if (spec.kind !== "pypi") throw new Error("not a pypi spec");
  return spec;
}

/** The real docker, with what a build prints kept for `images` instead of streamed. */
function noting(): DockerRunner {
  return (args, options = {}) => {
    const result = realDocker(args, { ...options, stream: false });
    if (options.stream) images.note(`${result.stdout}\n${result.stderr}`);
    if (options.stream && result.status !== 0) console.error(`${result.stdout}\n${result.stderr}`);
    return options.stream ? { ...result, stderr: `${result.stdout}\n${result.stderr}` } : result;
  };
}

/** Runs docker and returns what it printed, failing the test on an exit code other than `status`. */
function dockerOut(args: string[], status = 0): { stdout: string; stderr: string } {
  const result = realDocker(args);
  expect(result.status, `docker ${args.join(" ")}: ${result.stderr}`).toBe(status);
  return result;
}

const options = (serverId: string, spec: PypiLaunch): SandboxOptions => ({
  serverId, spec, mounts: [], env: [], allowNet: false, memory: "512m", cpus: "1", keepImageUser: false, rebuild: false, log: () => {},
});

beforeAll(() => {
  vi.stubEnv("MCPCAGE_HOME", home);
});
afterAll(() => {
  vi.unstubAllEnvs();
  images.remove();
}, 120_000);

describe.skipIf(!docker.ok)("resolving PyPI servers (real Docker, PyPI)", () => {
  it("locks mcp-server-time on Python 3.13, every package hashed, the server at the version step 1 chose", () => {
    const log: string[] = [];
    const locked = lockPypi("time-lock", pypi("uvx", "mcp-server-time"), { log: (line) => log.push(line) });
    expect(locked.packageName).toBe("mcp-server-time");
    expect(locked.version).toMatch(/^\d+(\.\d+)+$/);
    expect(locked.python).toBe("3.13");
    expect(locked.platform).toBe(wheelPlatform());
    const lock = readFileSync(join(home, "servers", "time-lock", "requirements.lock"), "utf8");
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

/** A ZIP of `files`, stored without compression, as a wheel may be (with the CRC-32 of each file). */
function zip(files: Array<[string, string]>): Buffer {
  const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text);
    const path = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    parts.push(local, path, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, path);
    offset += local.length + path.length + data.length;
  }
  const size = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/**
 * A wheel whose evilpth.pth does what a malicious package's can: site executes its `import` line at
 * every start of a Python that has it in site-packages. It writes PTH_RAN on stderr and leaves a
 * file in /app/venv/pth-ran, which the runtime image copies, for every process that ran it.
 */
function evilWheel(dir: string): { file: string; sha256: string } {
  const files: Array<[string, string]> = [
    ["evilpth/__init__.py", "def main():\n    print('evilpth main')\n"],
    // A file written for Python 2, as olefile still ships one (olefile2.py, in excel-mcp-server's
    // dependencies): it does not compile, and must not fail the build, since nothing imports it.
    ["evilpth/legacy2.py", 'MAXREGSECT = 0xFFFFFFFAL\nprint "written for Python 2"\n'],
    ["evilpth.pth", 'import os, sys; sys.stderr.write("PTH_RAN\\n"); os.makedirs("/app/venv/pth-ran", exist_ok=True); open("/app/venv/pth-ran/%d" % os.getpid(), "w").write(" ".join(sys.argv))\n'],
    ["evilpth-0.1.dist-info/METADATA", "Metadata-Version: 2.1\nName: evilpth\nVersion: 0.1\n"],
    ["evilpth-0.1.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: mcpcage-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"],
    ["evilpth-0.1.dist-info/entry_points.txt", "[console_scripts]\nevilpth = evilpth:main\n"],
  ];
  const digest = (text: string) => createHash("sha256").update(text).digest("base64url");
  const record = `${files.map(([name, text]) => `${name},sha256=${digest(text)},${Buffer.byteLength(text)}\n`).join("")}evilpth-0.1.dist-info/RECORD,,\n`;
  const wheel = zip([...files, ["evilpth-0.1.dist-info/RECORD", record]]);
  const file = join(dir, "evilpth-0.1-py3-none-any.whl");
  writeFileSync(file, wheel);
  return { file, sha256: createHash("sha256").update(wheel).digest("hex") };
}

describe.skipIf(!docker.ok)("building PyPI servers (real Docker, PyPI)", () => {
  // compileall compiles in worker processes, which multiprocessing starts in a way that changed in
  // 3.14: the build is checked on both, and the workers must not run site either.
  it.each(["3.13", "3.14"])("runs no .pth file of a package while it builds, on Python %s", (python) => {
    const wheel = evilWheel(mkdtempSync(join(home, "wheel-")));
    const serverId = `evilpth-${python.replace(".", "")}`;
    const tag = `mcpcage/${serverId}:test`;
    const output: string[] = [];
    const runner: DockerRunner = (args, more = {}) => {
      const result = noting()(args, more);
      if (more.stream) output.push(result.stderr);
      return result;
    };
    // The lock names the local wheel, which the test gives the builder; the Dockerfile is the one
    // every PyPI server gets, with the wheels copied in (see pypiDockerfile).
    const lock = `/app/wheels/evilpth-0.1-py3-none-any.whl \\\n    --hash=sha256:${wheel.sha256}\n`;
    buildPypiImage({ serverId, tag, dockerfile: pypiDockerfile({ command: "evilpth", python, wheels: true }), lock }, { log: () => {}, runner, wheels: [wheel.file] });
    images.note("", tag);
    expect(output.join("\n")).not.toContain("PTH_RAN");
    const python3 = `/app/venv/lib/python${python}/site-packages`;
    const inside = dockerOut([
      "run", "--rm", "--network", "none", "--entrypoint", "/app/venv/bin/python", tag, "-I", "-S", "-c",
      `import os, sys; print(sys.version.split()[0]); print(os.path.exists('/app/venv/pth-ran')); print(os.path.exists('${python3}/evilpth.pth')); print(sorted(os.listdir('${python3}/evilpth/__pycache__')))`,
    ]).stdout.trim().split("\n");
    expect(inside[0]).toBe(managedPython(python));
    // No marker: neither uv, nor the pip removal, compileall and its workers, nor the command check ran it.
    expect(inside[1]).toBe("False");
    // And yet the .pth is there, the package compiled but for its Python 2 file.
    expect(inside[2]).toBe("True");
    expect(inside[3]).toMatch(/__init__\.cpython-31[34]\.pyc/);
    expect(inside[3]).not.toMatch(/legacy2/);
    // The proof that the wheel's .pth works: the console script, which starts Python with its site, runs it.
    const started = realDocker(["run", "--rm", "--network", "none", tag]);
    expect(started.stderr).toContain("PTH_RAN");
    expect(started.stdout).toContain("evilpth main");
  }, 600_000);

  it("leaves no stopped container when a step of the build fails", () => {
    // uv pip sync refuses the wheel: the lock gives it another sha256.
    const wheel = evilWheel(mkdtempSync(join(home, "wheel-")));
    const output: string[] = [];
    const runner: DockerRunner = (args, more = {}) => {
      const result = noting()(args, more);
      if (more.stream) output.push(result.stderr);
      return result;
    };
    const lock = `/app/wheels/evilpth-0.1-py3-none-any.whl \\\n    --hash=sha256:${"0".repeat(64)}\n`;
    const build = () => buildPypiImage({ serverId: "failing", tag: "mcpcage/failing:test", dockerfile: pypiDockerfile({ command: "evilpth", python: "3.13", wheels: true }), lock }, { log: () => {}, runner, wheels: [wheel.file] });
    expect(build).toThrow(/^docker build failed for failing/);
    // The classic builder names the container of each step; BuildKit runs none that outlives the build.
    const steps = [...output.join("\n").matchAll(/^ ---> Running in ([0-9a-f]{12})$/gm)].map((match) => match[1]!);
    // Either builder's steps are in what it printed: the check below is not vacuous.
    expect(steps.length > 0 || /^#\d+ \[/m.test(output.join("\n"))).toBe(true);
    expect(output.join("\n")).toMatch(/hash|Hash/);
    for (const id of steps) expect(realDocker(["container", "inspect", id]).status, `container ${id}`).not.toBe(0);
  }, 600_000);

  it("builds mcp-server-time from its lock and lists its tools in the cage, without network", async () => {
    const spec = pypi("uvx", "mcp-server-time");
    const record = preparePypiImage(options("time", spec), noting());
    images.note("", record.imageId);
    expect(record).toMatchObject({ packageName: "mcp-server-time", python: "3.13.18", platform: wheelPlatform(), uvVersion: "0.13.7" });
    expect(record.image).toMatch(/^mcpcage\/time:[0-9a-f]{12}$/);
    writeFileSync(join(home, "servers", "time", "server.json"), JSON.stringify(record));
    // The next start reuses the image, through prepareSandbox as `mcpcage run` does.
    const prepared = prepareSandbox(options("time", spec));
    expect(prepared.record.imageId).toBe(record.imageId);
    expect(prepared.record.builtAt).toBe(record.builtAt);
    expect(prepared.args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "65532:65532", record.imageId]));
    const tools = (await listTools(prepared.command, prepared.args, prepared.env, 60_000)).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["get_current_time", "convert_time"]));
    // The runtime: user 65532, the console script as entry point, no shell, no pip.
    expect(dockerOut(["image", "inspect", "--format", "{{.Config.User}} {{json .Config.Entrypoint}}", record.imageId]).stdout.trim()).toBe('65532:65532 ["/app/venv/bin/mcp-server-time"]');
    expect(realDocker(["run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", record.imageId, "-c", "true"]).status).not.toBe(0);
    const pip = dockerOut(["run", "--rm", "--network", "none", "--entrypoint", "/app/venv/bin/python", record.imageId, "-I", "-S", "-c", "import glob; print(glob.glob('/opt/python/*/lib/python3.*/site-packages/pip*') + glob.glob('/opt/python/*/bin/pip*') + glob.glob('/app/venv/lib/python3.*/site-packages/pip*'))"]);
    expect(pip.stdout.trim()).toBe("[]");
    // Bytecode for the server's package and for the standard library, which the read-only root keeps Python from writing.
    const compiled = dockerOut(["run", "--rm", "--network", "none", "--entrypoint", "/app/venv/bin/python", record.imageId, "-I", "-S", "-c", "import glob; print(len(glob.glob('/opt/python/cpython-3.13.18-*/lib/python3.13/__pycache__/os.cpython-313.pyc')), len(glob.glob('/app/venv/lib/python3.13/site-packages/mcp_server_time/__pycache__/*.cpython-313.pyc')) > 0)"]);
    expect(compiled.stdout.trim()).toBe("1 True");
  }, 600_000);

  it("starts mcp-server-time through `mcpcage run` after `mcpcage prepare`, and records its Python in the audit log", async () => {
    const prepared = images.track(mcpcage(home, "prepare", "--id", "time-cli", "--", "uvx", "mcp-server-time"), home);
    expect(prepared.code, prepared.stderr).toBe(0);
    // The build's lines, without the color codes the classic builder puts around what uv writes on
    // stderr (seen only when the steps are not taken from Docker's cache) or anything else a terminal acts on.
    expect(prepared.stderr).toContain("mcpcage: building the sandbox image for time-cli");
    expect(prepared.stderr).not.toMatch(/[\u001b\u009b]/);
    expect(prepared.stdout).toMatch(new RegExp(`^time-cli: mcp-server-time@[0-9.]+ -> mcpcage/time-cli:[0-9a-f]{12}\n  python 3\.13\.18, wheels for ${wheelPlatform()}\n$`));
    const session = await connect({ home, runArgs: ["--id", "time-cli"], server: ["uvx", "mcp-server-time"] });
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_current_time", "convert_time"]));
    const result = await session.client.callTool({ name: "get_current_time", arguments: { timezone: "UTC" } });
    expect(JSON.stringify(result.content)).toContain("UTC");
    await session.close();
    expect(mcpcage(home, "audit", "verify", "time-cli").code).toBe(0);
    const shown = mcpcage(home, "audit", "show", "time-cli", "--lines", "200").stdout;
    for (const field of ['"mode":"docker"', '"network":"none"', '"package":"mcp-server-time"', '"python":"3.13.18"', `"platform":"${wheelPlatform()}"`, '"uvVersion":"0.13.7"']) {
      expect(shown).toContain(field);
    }
  }, 600_000);

  // uv checks each download against the sha256 it ships with; the table must follow the pinned uv.
  it("installs, for each minor version, the newest CPython that the pinned uv knows", () => {
    const listed = dockerOut([
      "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp", "--user", "65532:65532", "-e", "HOME=/tmp", "-e", "UV_NO_CONFIG=1", "-e", "UV_PYTHON_DOWNLOADS=never",
      "--entrypoint", "uv", PYPI_RESOLVE_BASE, "python", "list", "--only-downloads", "--output-format", "json",
    ]).stdout;
    const newest = new Map<string, number[]>();
    for (const entry of JSON.parse(listed) as Array<{ implementation: string; variant?: string; version: string }>) {
      if (entry.implementation !== "cpython" || (entry.variant ?? "default") !== "default" || !/^\d+\.\d+\.\d+$/.test(entry.version)) continue;
      const parts = entry.version.split(".").map(Number);
      const minor = parts.slice(0, 2).join(".");
      const known = newest.get(minor);
      if (known === undefined || parts[2]! > known[2]!) newest.set(minor, parts);
    }
    expect(new Map([...MANAGED_PYTHON].map(([minor]) => [minor, newest.get(minor)?.join(".")]))).toEqual(MANAGED_PYTHON);
  }, 120_000);
});
