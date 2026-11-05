import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/canonical.js";
import { parseLaunch, type PypiLaunch } from "../src/launch.js";
import { managedPython, preparePypiImage, pypiDockerfile, uvVersion, type DockerResult, type DockerRunner } from "../src/pypi.js";
import { PYPI_INSTALL_BASE, PYPI_RUNTIME_BASE, UV_BASE, type SandboxOptions, type ServerRecord } from "../src/sandbox.js";

/*
 * How a PyPI server's image is built from its lock: the Dockerfile mcpcage writes, and when it
 * resolves and builds again. Docker is a fake here; test/pypi.docker.test.ts builds for real.
 */

/** The instructions of a Dockerfile, comments and blank lines left out. */
function instructions(dockerfile: string): Array<{ keyword: string; rest: string }> {
  return dockerfile
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const [keyword, ...rest] = line.split(" ");
      return { keyword: keyword!, rest: rest.join(" ") };
    });
}

/** The argv of each RUN, which must be the exec form: a JSON array of strings. */
function runs(dockerfile: string): string[][] {
  return instructions(dockerfile)
    .filter((instruction) => instruction.keyword === "RUN")
    .map((instruction) => {
      expect(instruction.rest.startsWith("["), instruction.rest).toBe(true);
      const argv = JSON.parse(instruction.rest) as unknown;
      expect(Array.isArray(argv) && argv.every((word) => typeof word === "string")).toBe(true);
      return argv as string[];
    });
}

const isUv = (argv: string[]) => /(^|\/)uvx?$/.test(argv[0]!);
const isPython = (argv: string[]) => /(^|\/)python[0-9.]*$/.test(argv[0]!);

/** The Dockerfile of `uvx mcp-server-time`. */
const timeDockerfile = () => pypiDockerfile({ command: "mcp-server-time", python: "3.13" });

describe("the Dockerfile of a PyPI server", () => {

  it("runs every command in exec form: the bases have no shell, and nothing may be read as shell", () => {
    const dockerfile = timeDockerfile();
    for (const { keyword, rest } of instructions(dockerfile)) {
      expect(["FROM", "COPY", "ENV", "RUN", "WORKDIR", "USER", "ENTRYPOINT"]).toContain(keyword);
      if (keyword === "RUN" || keyword === "ENTRYPOINT") expect(() => JSON.parse(rest), rest).not.toThrow();
    }
    expect(runs(dockerfile).length).toBeGreaterThan(0);
    expect(dockerfile).not.toMatch(/^(SHELL|CMD|ADD|ARG|ONBUILD)\b/m);
  });

  it("installs the exact managed Python, then makes the venv, then runs exactly one uv command on it: pip sync of the lock, hashes required, nothing built", () => {
    const dockerfile = timeDockerfile();
    const argvs = runs(dockerfile);
    const venv = argvs.findIndex((argv) => isUv(argv) && argv[1] === "venv");
    expect(argvs.slice(0, venv)).toEqual([["uv", "python", "install", "3.13.18"]]);
    expect(argvs[venv]).toEqual(["uv", "venv", "--python", "3.13.18", "/app/venv"]);
    const after = argvs.slice(venv + 1).filter(isUv);
    expect(after).toEqual([["uv", "pip", "sync", "--require-hashes", "--no-build", "--python", "/app/venv/bin/python", "/app/requirements.lock"]]);
    // The lock is the only thing copied into the install stage before the sync.
    expect(instructions(dockerfile).filter((instruction) => instruction.keyword === "COPY").map((instruction) => instruction.rest)).toEqual([
      "--from=uv /uv /usr/local/bin/uv",
      "requirements.lock /app/requirements.lock",
      "--from=install /opt/python /opt/python",
      "--from=install /app/venv /app/venv",
    ]);
  });

  it("never compiles bytecode with uv, which runs the venv's Python with its .pth files", () => {
    const dockerfile = timeDockerfile();
    expect(dockerfile).not.toMatch(/compile-bytecode|COMPILE_BYTECODE/i);
  });

  it("starts every Python with -I -S, so no .pth file, sitecustomize or PYTHON* variable runs", () => {
    const dockerfile = timeDockerfile();
    const pythons = runs(dockerfile).filter(isPython);
    expect(pythons.length).toBe(3);
    for (const argv of pythons) expect(argv.slice(1, 3), argv.join(" ")).toEqual(["-I", "-S"]);
    // Bytecode for the packages and for the standard library, which python-build-standalone ships
    // without; a file that does not compile is left as it is, not a failed build (`-m compileall`
    // exits 1 for it).
    const compile = pythons.find((argv) => argv.join(" ").includes("compile_dir"));
    expect(compile?.slice(-2)).toEqual(["/app/venv/lib/python3.13/site-packages", "/opt/python"]);
    expect(pythons.some((argv) => argv.includes("-m"))).toBe(false);
    // pip goes from the managed Python's own site-packages, and the command is looked for.
    expect(pythons.some((argv) => argv.join(" ").includes("site-packages/pip"))).toBe(true);
    expect(pythons.at(-1)!.at(-1)).toBe("mcp-server-time");
  });

  it("builds from the pinned bases and starts the console script itself, as 65532, from a runtime with the interpreter and the venv only", () => {
    const dockerfile = timeDockerfile();
    const from = instructions(dockerfile).filter((instruction) => instruction.keyword === "FROM").map((instruction) => instruction.rest);
    expect(from).toEqual([`${UV_BASE} AS uv`, `${PYPI_INSTALL_BASE} AS install`, PYPI_RUNTIME_BASE]);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
    expect(runtime).not.toMatch(/^RUN/m);
    expect(runtime).toMatch(/^ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1$/m);
    expect(runtime).toMatch(/^USER 65532:65532$/m);
    expect(runtime).toMatch(/^ENTRYPOINT \["\/app\/venv\/bin\/mcp-server-time"\]$/m);
    expect(dockerfile).toMatch(/^ENV UV_NO_CONFIG=1 UV_NO_CACHE=1 UV_NO_BUILD=1 UV_NO_PROGRESS=1 UV_LINK_MODE=copy UV_PYTHON_INSTALL_DIR=\/opt\/python UV_PYTHON_PREFERENCE=only-managed UV_PYTHON_INSTALL_BIN=0 UV_PYTHON_INSTALL_REGISTRY=0$/m);
  });

  it("puts the wheels a test gives in the context before the lock, and changes nothing else", () => {
    const dockerfile = timeDockerfile();
    const withWheels = pypiDockerfile({ command: "mcp-server-time", python: "3.13", wheels: true });
    expect(withWheels.replace("COPY wheels /app/wheels\n", "")).toBe(dockerfile);
    expect(withWheels.indexOf("COPY wheels /app/wheels")).toBeLessThan(withWheels.indexOf("COPY requirements.lock"));
  });

  it.each([["3.10", "3.10.22"], ["3.11", "3.11.18"], ["3.12", "3.12.16"], ["3.13", "3.13.18"], ["3.14", "3.14.10"], ["3.15", "3.15.2"], ["3.12.4", "3.12.4"]])("installs CPython %s as %s", (asked, installed) => {
    expect(managedPython(asked)).toBe(installed);
    const text = pypiDockerfile({ command: "x", python: asked });
    expect(runs(text)[0]).toEqual(["uv", "python", "install", installed]);
    expect(text).toContain(`/app/venv/lib/python${installed.split(".").slice(0, 2).join(".")}/site-packages`);
  });

  it.each(["3.9", "3.16", "3", "3.13.", "3.13.1a1", "3.13; id", "3.13\nRUN id", "__proto__", "toString", ""])("refuses to write the Python %j", (python) => {
    expect(() => pypiDockerfile({ command: "x", python })).toThrow(/^the cage runs CPython 3\.10 to 3\.15/);
  });

  it.each(["a b", "x\"]", "x\nRUN id", "$(id)", "-x", ".hidden", "../x", "x/y", "x\\y", "", "é", "x;y", "x".repeat(129)])("refuses to write the command %j", (command) => {
    expect(() => pypiDockerfile({ command, python: "3.13" })).toThrow("the command of a PyPI server must be a plain file name");
  });

  it.each(["mcp-server-time", "awslabs.aws-api-mcp-server", "mcp_for_unity", "python", "x2"])("writes the command %s as the entry point", (command) => {
    expect(pypiDockerfile({ command, python: "3.13" })).toContain(`ENTRYPOINT ["/app/venv/bin/${command}"]`);
  });
});

const hex = (seed: number) => seed.toString(16).padStart(2, "0").repeat(32);
const lockOf = (version: string) => `mcp-server-time==${version} \\\n    --hash=sha256:${hex(1)}\ntzdata==2026.2 \\\n    --hash=sha256:${hex(2)}\n`;

/**
 * A Docker engine of `arch` whose uv resolves mcp-server-time to `version`, and that builds: it keeps
 * the images by tag, and gives each build a new id.
 */
function fakeEngine(state: { arch: string; version: string }) {
  const images = new Map<string, string>();
  const calls: string[][] = [];
  let built = 0;
  const runner: DockerRunner = (args, options = {}) => {
    calls.push(args);
    const ok = (stdout: string): DockerResult => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "version") return ok(`${state.arch}\n`);
    if (args[0] === "run" && args.includes("--no-deps")) return ok(`mcp-server-time==${state.version}\n`);
    if (args[0] === "run" && args.includes("--generate-hashes")) return ok(lockOf(state.version));
    if (args[0] === "image" && args[1] === "inspect") {
      const id = images.get(args.at(-1)!);
      return id === undefined ? { status: 1, stdout: "", stderr: "No such image" } : ok(`${id}\n`);
    }
    if (args[0] === "build") {
      expect(options.stream).toBe(true);
      built++;
      images.set(args[args.indexOf("-t") + 1]!, `sha256:${hex(100 + built)}`);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 125, stdout: "", stderr: `unexpected docker ${args.join(" ")}` };
  };
  return {
    runner,
    images,
    resolves: () => calls.filter((args) => args[0] === "run").length,
    builds: () => calls.filter((args) => args[0] === "build"),
    reset: () => {
      calls.length = 0;
    },
  };
}

function pypi(...argv: string[]): PypiLaunch {
  const spec = parseLaunch(argv, undefined, "linux");
  if (spec.kind !== "pypi") throw new Error("not a pypi spec");
  return spec;
}

describe("building a PyPI server's image", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mcpcage-pypi-build-"));
    vi.stubEnv("MCPCAGE_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const options = (spec: PypiLaunch, more: Partial<SandboxOptions> = {}): SandboxOptions => ({
    serverId: "time", spec, mounts: [], env: [], allowNet: false, memory: "512m", cpus: "1", keepImageUser: false, rebuild: false, log: () => {}, ...more,
  });

  /** preparePypiImage, keeping the record where prepareSandbox keeps it. */
  function prepare(engine: ReturnType<typeof fakeEngine>, spec: PypiLaunch, more: Partial<SandboxOptions> = {}): ServerRecord {
    const record = preparePypiImage(options(spec, more), engine.runner);
    writeFileSync(join(home, "servers", "time", "server.json"), JSON.stringify(record));
    return record;
  }

  it("resolves, builds from the lock with Docker's cache, and records the server, its Python, platform and uv", () => {
    const engine = fakeEngine({ arch: "arm64", version: "2026.11.4" });
    const spec = pypi("uvx", "mcp-server-time");
    const record = prepare(engine, spec);
    const lock = readFileSync(join(home, "servers", "time", "requirements.lock"), "utf8");
    expect(lock).toBe(lockOf("2026.11.4"));
    const tag = `mcpcage/time:${sha256(`${lock}\n${pypiDockerfile({ command: "mcp-server-time", python: "3.13.18" })}`).slice(0, 12)}`;
    expect(record).toMatchObject({
      serverId: "time", spec, image: tag, imageId: `sha256:${hex(101)}`, packageName: "mcp-server-time", version: "2026.11.4",
      lockfileSha256: sha256(lock), python: "3.13.18", platform: "aarch64-manylinux_2_40", uvVersion: "0.13.7",
    });
    expect(record.integrity).toBeUndefined();
    const [build] = engine.builds();
    expect(build!.slice(0, 5)).toEqual(["build", "--label", "mcpcage.server=time", "-t", tag]);
    // Nothing in the build resolves, so a cached layer is the same as a fresh one (see buildPypiImage).
    expect(build).not.toContain("--no-cache");
  });

  it("reuses the lock and the image at the next start: nothing resolved, nothing built", () => {
    const engine = fakeEngine({ arch: "arm64", version: "2026.11.4" });
    const first = prepare(engine, pypi("uvx", "mcp-server-time"));
    engine.reset();
    // A newer release on PyPI changes nothing until --rebuild, as uvx without @latest.
    engine.images.set("unrelated", "x");
    const second = prepare(engine, pypi("uvx", "mcp-server-time"));
    expect(second).toEqual(first);
    expect(engine.resolves()).toBe(0);
    expect(engine.builds()).toEqual([]);
  });

  it("keeps @latest at the version of its first build", () => {
    const state = { arch: "arm64", version: "2026.11.4" };
    const engine = fakeEngine(state);
    prepare(engine, pypi("uvx", "mcp-server-time@latest"));
    state.version = "2026.12.1";
    engine.reset();
    expect(prepare(engine, pypi("uvx", "mcp-server-time@latest")).version).toBe("2026.11.4");
    expect(engine.resolves()).toBe(0);
  });

  it("resolves and builds again with --rebuild", () => {
    const state = { arch: "arm64", version: "2026.11.4" };
    const engine = fakeEngine(state);
    prepare(engine, pypi("uvx", "mcp-server-time"));
    state.version = "2026.12.1";
    engine.reset();
    const record = prepare(engine, pypi("uvx", "mcp-server-time"), { rebuild: true });
    expect(record.version).toBe("2026.12.1");
    expect(engine.resolves()).toBeGreaterThan(0);
    expect(engine.builds()).toHaveLength(1);
  });

  it.each([
    ["the requirement", ["uvx", "mcp-server-time==2026.12.1"]],
    ["a --with", ["uvx", "--with", "rich", "mcp-server-time"]],
    ["the Python", ["uvx", "--python", "3.12", "mcp-server-time"]],
    ["a resolution option", ["uvx", "--exclude-newer", "2026-11-01", "mcp-server-time"]],
  ])("resolves again when %s changes", (_what, argv) => {
    const state = { arch: "arm64", version: "2026.11.4" };
    const engine = fakeEngine(state);
    prepare(engine, pypi("uvx", "mcp-server-time"));
    state.version = "2026.12.1";
    engine.reset();
    expect(prepare(engine, pypi(...argv)).version).toBe("2026.12.1");
    expect(engine.resolves()).toBeGreaterThan(0);
  });

  it("keeps the lock when only the server's arguments change", () => {
    const state = { arch: "arm64", version: "2026.11.4" };
    const engine = fakeEngine(state);
    prepare(engine, pypi("uvx", "mcp-server-time"));
    state.version = "2026.12.1";
    engine.reset();
    const record = prepare(engine, pypi("uvx", "mcp-server-time", "--local-timezone", "Europe/Rome"));
    expect(record.version).toBe("2026.11.4");
    expect(record.spec.args).toEqual(["--local-timezone", "Europe/Rome"]);
    expect(engine.resolves()).toBe(0);
  });

  it("resolves again on an engine of another architecture: the wheels of the lock are for the old one", () => {
    const state = { arch: "arm64", version: "2026.11.4" };
    const engine = fakeEngine(state);
    prepare(engine, pypi("uvx", "mcp-server-time"));
    state.arch = "amd64";
    engine.reset();
    const record = prepare(engine, pypi("uvx", "mcp-server-time"));
    expect(record.platform).toBe("x86_64-manylinux_2_40");
    expect(engine.resolves()).toBeGreaterThan(0);
  });

  it("resolves again when the lock on disk is not the one recorded", () => {
    const engine = fakeEngine({ arch: "arm64", version: "2026.11.4" });
    prepare(engine, pypi("uvx", "mcp-server-time"));
    writeFileSync(join(home, "servers", "time", "requirements.lock"), lockOf("0.1"));
    engine.reset();
    expect(prepare(engine, pypi("uvx", "mcp-server-time")).version).toBe("2026.11.4");
    expect(engine.resolves()).toBeGreaterThan(0);
  });

  it("builds again from the same lock, without resolving, when the image is gone", () => {
    const engine = fakeEngine({ arch: "arm64", version: "2026.11.4" });
    const first = prepare(engine, pypi("uvx", "mcp-server-time"));
    engine.images.clear();
    engine.reset();
    const second = prepare(engine, pypi("uvx", "mcp-server-time"));
    expect(engine.resolves()).toBe(0);
    expect(engine.builds()).toHaveLength(1);
    expect(second.image).toBe(first.image);
    expect(second.imageId).not.toBe(first.imageId);
    expect(second.lockfileSha256).toBe(first.lockfileSha256);
  });

  it("tags the image by the lock and the Dockerfile, which names the Python and the bases", () => {
    const tag = (lock: string, python: string) => `mcpcage/time:${sha256(`${lock}\n${pypiDockerfile({ command: "mcp-server-time", python })}`).slice(0, 12)}`;
    const engine = fakeEngine({ arch: "arm64", version: "2026.11.4" });
    const on313 = prepare(engine, pypi("uvx", "mcp-server-time"));
    const on312 = prepare(engine, pypi("uvx", "--python", "3.12", "mcp-server-time"));
    expect(on313.image).toBe(tag(lockOf("2026.11.4"), "3.13.18"));
    expect(on312.image).toBe(tag(lockOf("2026.11.4"), "3.12.16"));
    expect(on312.python).toBe("3.12.16");
    expect(on313.image).not.toBe(on312.image);
    expect(on313.image).toMatch(/^mcpcage\/time:[0-9a-f]{12}$/);
  });

  it("names the uv release of the pinned uv image", () => {
    expect(uvVersion()).toBe(/^ghcr\.io\/astral-sh\/uv:(\d+\.\d+\.\d+)@/.exec(UV_BASE)![1]);
  });
});
