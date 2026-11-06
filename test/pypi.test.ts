import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLaunch, type PypiLaunch } from "../src/launch.js";
import { checkLock, comparePypiVersions, lockPypi, noWheel, resolveArgs, resolvePypi, wheelPlatform, type DockerResult, type DockerRunner } from "../src/pypi.js";
import { PYPI_RESOLVE_BASE } from "../src/sandbox.js";

/*
 * The resolve of a PyPI server, with a fake docker in place of the real one: what mcpcage asks uv,
 * in which container, and what it accepts of the answers. test/pypi.docker.test.ts asks the real one.
 */

interface Call {
  args: string[];
  input?: string;
  stream?: boolean;
}

const hex = (seed: number) => seed.toString(16).padStart(2, "0").repeat(32);

/** A lock as uv writes it with --generate-hashes --no-header --no-annotate. */
function lockOf(pins: Array<[string, string]>): string {
  return pins.map(([name, version], index) => `${name}==${version} \\\n    --hash=sha256:${hex(2 * index)} \\\n    --hash=sha256:${hex(2 * index + 1)}\n`).join("");
}

const DBT_NO_SOLUTION = `error: No solution found when resolving dependencies
  cause: Because uuid==1.30 has no usable wheels and all versions of dbtlabs-vortex depend on uuid==1.30, we can conclude that all versions of dbtlabs-vortex cannot be used.
         And because dbt-mcp>=2.10.1 depends on dbtlabs-vortex and you require dbt-mcp==2.10.1, we can conclude that your requirements are unsatisfiable.

hint: Wheels are required for \`uuid\` because building from source is disabled for all packages (i.e., with \`--no-build\`)
`;

const ok = (stdout: string): DockerResult => ({ status: 0, stdout, stderr: "" });
const noSolution = (stderr: string): DockerResult => ({ status: 1, stdout: "", stderr });

/** The value of `flag` in a docker run's uv arguments. */
function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * A docker whose engine is `arch`, whose uv answers step 1 (--no-deps) with `roots[python]` and step
 * 3 with `lock(input, python)`.
 */
function fakeDocker(answers: { arch?: string; roots?: Record<string, DockerResult>; lock?: (input: string, python: string) => DockerResult; resolveImage?: boolean; pull?: DockerResult }) {
  const calls: Call[] = [];
  // Docker has the resolve image unless `resolveImage` is false; a pull gets it, unless `pull` says otherwise.
  let present = answers.resolveImage ?? true;
  const runner: DockerRunner = (args, options = {}) => {
    calls.push({ args, input: options.input, stream: options.stream });
    if (args[0] === "version") return ok(`${answers.arch ?? "arm64"}\n`);
    if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === PYPI_RESOLVE_BASE) return present ? ok("sha256:resolve\n") : { status: 1, stdout: "", stderr: "Error: No such image" };
    if (args[0] === "pull") {
      const pulled = answers.pull ?? ok(`${PYPI_RESOLVE_BASE}\n`);
      present = pulled.status === 0;
      return pulled;
    }
    const python = flag(args, "--python-version") ?? "";
    if (args.includes("--no-deps")) return answers.roots?.[python] ?? noSolution(`error: No solution found when resolving dependencies\n  cause: nothing on ${python}\n`);
    if (args.includes("--generate-hashes")) return answers.lock?.(options.input ?? "", python) ?? { status: 2, stdout: "", stderr: "unexpected" };
    return { status: 125, stdout: "", stderr: `unexpected docker ${args.join(" ")}` };
  };
  return { calls, runner, compiles: () => calls.filter((call) => call.args[0] === "run") };
}

function pypi(...argv: string[]): PypiLaunch {
  const spec = parseLaunch(argv, undefined, "linux");
  if (spec.kind !== "pypi") throw new Error("not a pypi spec");
  return spec;
}

const TIME_LOCK = lockOf([["annotated-types", "0.8.0"], ["mcp-server-time", "2026.11.4"], ["tzdata", "2026.2"]]);
const timeDocker = () => fakeDocker({ roots: { "3.13": ok("mcp-server-time==2026.11.4\n"), "3.15": ok("mcp-server-time==2026.11.4\n") }, lock: () => ok(TIME_LOCK) });

describe("resolving a PyPI server", () => {
  it("pulls uv's image first when Docker does not have it, saying so, and only then", () => {
    const docker = fakeDocker({ resolveImage: false, roots: { "3.13": ok("mcp-server-time==2026.11.4\n"), "3.15": ok("mcp-server-time==2026.11.4\n") }, lock: () => ok(TIME_LOCK) });
    const log: string[] = [];
    resolvePypi(pypi("uvx", "mcp-server-time"), { log: (line) => log.push(line), runner: docker.runner });
    expect(log.slice(0, 2)).toEqual([
      "mcpcage: resolving mcp-server-time from PyPI, wheels only...",
      `mcpcage: pulling uv's image, which PyPI servers are resolved in, once: ${PYPI_RESOLVE_BASE}...`,
    ]);
    const pulls = docker.calls.filter((call) => call.args[0] === "pull");
    // Its progress on mcpcage's stderr (stdout is the MCP channel), before the first docker run.
    expect(pulls).toEqual([{ args: ["pull", "--quiet", PYPI_RESOLVE_BASE], input: undefined, stream: true }]);
    expect(docker.calls.indexOf(pulls[0]!)).toBeLessThan(docker.calls.findIndex((call) => call.args[0] === "run"));
    // The next resolve finds it.
    log.length = 0;
    resolvePypi(pypi("uvx", "mcp-server-time"), { log: (line) => log.push(line), runner: docker.runner });
    expect(log.join("\n")).not.toContain("pulling");
    expect(docker.calls.filter((call) => call.args[0] === "pull")).toHaveLength(1);
  });

  it("stops at a pull that fails, before any docker run", () => {
    const docker = fakeDocker({ resolveImage: false, pull: { status: 1, stdout: "", stderr: "" } });
    expect(() => resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner })).toThrow(`docker pull ${PYPI_RESOLVE_BASE} failed`);
    expect(docker.compiles()).toEqual([]);
  });

  it("pins the server's own version first, without its dependencies, then locks that version with hashes", () => {
    const docker = timeDocker();
    const resolved = resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner });
    expect(resolved).toEqual({ packageName: "mcp-server-time", version: "2026.11.4", python: "3.13", platform: "aarch64-manylinux_2_40", lock: TIME_LOCK });
    const [first, ...rest] = docker.compiles();
    expect(first!.args).toContain("--no-deps");
    expect(first!.args).not.toContain("--generate-hashes");
    expect(first!.input).toBe("mcp-server-time\n");
    const last = rest.at(-1)!;
    expect(last.args).toContain("--generate-hashes");
    expect(last.args).not.toContain("--no-deps");
    // The root pin of step 1, not the requirement as written: without it uv could move the server back.
    expect(last.input).toBe("mcp-server-time==2026.11.4\n");
    expect(flag(last.args, "--python-version")).toBe("3.13");
    expect(flag(last.args, "--python-platform")).toBe("aarch64-manylinux_2_40");
  });

  it("keeps the extras on the pinned server and adds each --with requirement after it", () => {
    const docker = fakeDocker({
      roots: { "3.13": ok("duckduckgo-mcp-server==0.7.0\n"), "3.15": ok("duckduckgo-mcp-server==0.7.0\n") },
      lock: () => ok(lockOf([["duckduckgo-mcp-server", "0.7.0"], ["httpx", "0.28.1"]])),
    });
    const resolved = resolvePypi(pypi("uvx", "--with", "httpx>=0.27,<1", "--with", "rich", "Duckduckgo_MCP.Server[browser]"), { log: () => {}, runner: docker.runner });
    expect(docker.compiles()[0]!.input).toBe("Duckduckgo_MCP.Server[browser]\n");
    expect(docker.compiles().at(-1)!.input).toBe("duckduckgo-mcp-server[browser]==0.7.0\nhttpx>=0.27,<1\nrich\n");
    expect(resolved.packageName).toBe("duckduckgo-mcp-server");
  });

  it("asks uv in a hardened container of the resolve image: nonroot, read-only, no capabilities, no host file, only uv's own settings", () => {
    const docker = timeDocker();
    resolvePypi(pypi("uvx", "--prerelease", "allow", "--exclude-newer", "30 days", "mcp-server-time"), { log: () => {}, runner: docker.runner });
    expect(docker.compiles().length).toBeGreaterThan(0);
    for (const { args } of docker.compiles()) {
      const image = args.indexOf(PYPI_RESOLVE_BASE);
      expect(image).toBeGreaterThan(0);
      const own = args.slice(0, image);
      expect(own.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
      expect(flag(own, "--network")).toBe("bridge");
      expect(own).toContain("--read-only");
      expect(flag(own, "--tmpfs")).toBe("/tmp:rw,noexec,nosuid,nodev,size=256m");
      expect(flag(own, "--cap-drop")).toBe("ALL");
      expect(flag(own, "--security-opt")).toBe("no-new-privileges");
      expect(flag(own, "--user")).toBe("65532:65532");
      expect(flag(own, "--pids-limit")).toBe("128");
      expect(flag(own, "--memory")).toBe("1g");
      expect(flag(own, "--memory-swap")).toBe("1g");
      expect(flag(own, "--entrypoint")).toBe("uv");
      // Exactly these variables, each with its value: no `-e NAME` that docker would fill in from its own environment.
      const variables = own.flatMap((arg, index) => (arg === "-e" || arg === "--env" ? [own[index + 1]] : []));
      expect(variables).toEqual(["HOME=/tmp", "UV_NO_CONFIG=1", "UV_NO_CACHE=1", "UV_PYTHON_DOWNLOADS=never"]);
      for (const forbidden of ["-v", "--volume", "--mount", "--env-file", "--privileged", "--pid", "--ipc", "--device", "--cap-add", "--volumes-from", "-w", "--workdir"]) {
        expect(own).not.toContain(forbidden);
      }
      expect(own.filter((arg) => arg.startsWith("-")).sort()).toEqual(
        ["--rm", "-i", "--network", "--read-only", "--tmpfs", "--cap-drop", "--security-opt", "--user", "--pids-limit", "--memory", "--memory-swap", "-e", "-e", "-e", "-e", "--entrypoint"].sort(),
      );
      const uv = args.slice(image + 1);
      expect(uv.slice(0, 2)).toEqual(["pip", "compile"]);
      expect(uv).toContain("--no-build");
      expect(uv.at(-1)).toBe("-");
      expect(flag(uv, "--prerelease")).toBe("allow");
      expect(flag(uv, "--exclude-newer")).toBe("30 days");
    }
    expect(resolveArgs(["--no-deps"])).toEqual(expect.arrayContaining(["--entrypoint", "uv", PYPI_RESOLVE_BASE, "pip", "compile", "--no-deps", "-"]));
  });

  it("refuses a server whose dependencies have no wheel, with uv's reason on one line", () => {
    const docker = fakeDocker({ roots: { "3.13": ok("dbt-mcp==2.10.1\n"), "3.15": ok("dbt-mcp==2.10.1\n") }, lock: () => noSolution(DBT_NO_SOLUTION) });
    const refused = () => resolvePypi(pypi("uvx", "dbt-mcp==2.10.1"), { log: () => {}, runner: docker.runner });
    expect(refused).toThrow(
      "dbt-mcp cannot be installed from PyPI wheels on Python 3.13 for Linux on ARM (linux/arm64), and the cage never builds a package from source: Because uuid==1.30 has no usable wheels and all versions of dbtlabs-vortex depend on uuid==1.30, " +
        "we can conclude that all versions of dbtlabs-vortex cannot be used. And because dbt-mcp>=2.10.1 depends on dbtlabs-vortex and you require dbt-mcp==2.10.1, we can conclude that your requirements are unsatisfiable. " +
        "hint: Wheels are required for `uuid` because building from source is disabled for all packages (i.e., with `--no-build`)",
    );
  });

  it("names the platform the wheels were looked for, the engine's: another machine may have them", () => {
    // guardpycfn 0.1.0 ships a wheel for Linux on x86_64 and none for Linux on ARM, which is what
    // Docker runs on Apple silicon: awslabs.aws-iac-mcp-server 1.0.26 is refused there only.
    const reason = "error: No solution found when resolving dependencies\n  cause: Because guardpycfn==0.1.0 has no usable wheels, nope.\n";
    for (const [arch, words] of [["arm64", "Linux on ARM (linux/arm64)"], ["amd64", "Linux on x86_64 (linux/amd64)"]]) {
      const docker = fakeDocker({ arch, roots: { "3.13": ok("awslabs-aws-iac-mcp-server==1.0.26\n"), "3.15": ok("awslabs-aws-iac-mcp-server==1.0.26\n") }, lock: () => noSolution(reason) });
      expect(() => resolvePypi(pypi("uvx", "awslabs.aws-iac-mcp-server"), { log: () => {}, runner: docker.runner }), arch).toThrow(
        `awslabs-aws-iac-mcp-server cannot be installed from PyPI wheels on Python 3.13 for ${words}, and the cage never builds a package from source: Because guardpycfn==0.1.0 has no usable wheels, nope.`,
      );
    }
  });

  it("refuses a server that has no release with a wheel for the Python --python names", () => {
    const docker = fakeDocker({ roots: { "3.12": noSolution("error: No solution found when resolving dependencies\n  ╰─▶ Because windows-mcp>=0.8.6 depends on Python>=3.14, nope.\n") } });
    expect(() => resolvePypi(pypi("uvx", "--python", "3.12", "windows-mcp==0.8.8"), { log: () => {}, runner: docker.runner })).toThrow(
      "windows-mcp cannot be installed from PyPI wheels on Python 3.12 for Linux on ARM (linux/arm64), and the cage never builds a package from source: Because windows-mcp>=0.8.6 depends on Python>=3.14, nope.",
    );
    expect(docker.compiles().map((call) => flag(call.args, "--python-version"))).toEqual(["3.12"]);
  });

  it("spells out what a terminal would act on in uv's reason", () => {
    const docker = fakeDocker({ roots: { "3.13": ok("x==1\n"), "3.15": ok("x==1\n") }, lock: () => noSolution("error: No solution found when resolving dependencies\n  cause: \u001b[2Jgone‮\n") });
    expect(() => resolvePypi(pypi("uvx", "x"), { log: () => {}, runner: docker.runner })).toThrow(/: \[U\+001B\]\[2Jgone\[U\+202E\]$/);
  });

  it("refuses any other failure of uv or docker, with the exit code", () => {
    const docker = fakeDocker({ roots: { "3.13": { status: 2, stdout: "", stderr: "error: Failed to fetch: `https://pypi.org/simple/mcp-server-time/`\n  Caused by: dns error\n" } } });
    expect(() => resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner })).toThrow(
      "the resolve of mcp-server-time failed (exit code 2): error: Failed to fetch: `https://pypi.org/simple/mcp-server-time/` Caused by: dns error",
    );
    const locked = fakeDocker({ roots: { "3.13": ok("mcp-server-time==1\n"), "3.15": ok("mcp-server-time==1\n") }, lock: () => ({ status: 137, stdout: TIME_LOCK, stderr: "" }) });
    expect(() => resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: locked.runner })).toThrow("the resolve of mcp-server-time failed (exit code 137): it printed nothing");
  });

  it.each([
    ["a second line", "mcp-server-time==2026.11.4\nother==1\n"],
    ["another package", "mcp-server-tim==2026.11.4\n"],
    ["a range", "mcp-server-time>=2026\n"],
    ["a URL", "mcp-server-time @ https://example.com/x.whl\n"],
    ["nothing", ""],
  ])("refuses a step 1 answer with %s", (_what, stdout) => {
    const docker = fakeDocker({ roots: { "3.13": ok(stdout), "3.15": ok(stdout) }, lock: () => ok(TIME_LOCK) });
    expect(() => resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner })).toThrow("the resolve of mcp-server-time printed something other than the version of mcp-server-time");
  });

  it("refuses a lock that pins the server to another version than step 1 chose", () => {
    const docker = fakeDocker({ roots: { "3.13": ok("mcp-server-time==2026.11.4\n"), "3.15": ok("mcp-server-time==2026.11.4\n") }, lock: () => ok(lockOf([["mcp-server-time", "0.6.2"]])) });
    expect(() => resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner })).toThrow("the lock uv wrote for mcp-server-time pins mcp-server-time to another version than 2026.11.4");
  });
});

describe("the lock uv writes", () => {
  const root = { name: "mcp-server-time", version: "2026.11.4" };

  it("is kept as written when it is pins with their hashes, comments and blank lines", () => {
    expect(() => checkLock(TIME_LOCK, root)).not.toThrow();
    expect(() => checkLock(`# a comment\n\n${TIME_LOCK}    # an indented comment\n\n`, root)).not.toThrow();
    // uv's normal form, or a name written otherwise: the same package.
    expect(() => checkLock(lockOf([["MCP_Server.Time", "2026.11.4"]]), root)).not.toThrow();
  });

  it.each([
    ["a pin without hash", `${TIME_LOCK}anyio==4.16.0\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["a pin whose hashes stop at a backslash", `mcp-server-time==2026.11.4 \\\n    --hash=sha256:${hex(1)} \\\n`, "has a pin without its hashes, or something else among them, at line 3"],
    ["a pin with no hash after its backslash", "mcp-server-time==2026.11.4 \\\n", "has a pin without its hashes, or something else among them, at line 2"],
    ["a short hash", `mcp-server-time==2026.11.4 \\\n    --hash=sha256:${hex(1).slice(1)}\n`, "has a pin without its hashes, or something else among them, at line 2"],
    ["an md5 hash", `mcp-server-time==2026.11.4 \\\n    --hash=md5:${hex(1).slice(32)}\n`, "has a pin without its hashes, or something else among them, at line 2"],
    ["an index", `--index-url https://example.com/simple\n${TIME_LOCK}`, "has line 1, which is not a package pinned with ==, followed by its hashes"],
    ["an extra index after a pin", `${TIME_LOCK}--extra-index-url https://example.com/simple\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["an option among the hashes", `mcp-server-time==2026.11.4 \\\n    --hash=sha256:${hex(1)} \\\n    --index-url=https://example.com\n`, "has a pin without its hashes, or something else among them, at line 3"],
    ["an editable", `-e ./server\n${TIME_LOCK}`, "has line 1, which is not a package pinned with ==, followed by its hashes"],
    ["a URL", `${TIME_LOCK}tzdata @ https://example.com/tzdata.whl \\\n    --hash=sha256:${hex(9)}\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["a path", `${TIME_LOCK}./wheels/x-1-py3-none-any.whl \\\n    --hash=sha256:${hex(9)}\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["a range", `${TIME_LOCK}tzdata>=2026 \\\n    --hash=sha256:${hex(9)}\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["a wildcard", `${TIME_LOCK}rich==15.* \\\n    --hash=sha256:${hex(9)}\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["a marker", `${TIME_LOCK}rich==15.0.0 ; python_version >= "3.8" \\\n    --hash=sha256:${hex(9)}\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["extras on a pin", `${TIME_LOCK}rich[jupyter]==15.0.0 \\\n    --hash=sha256:${hex(9)}\n`, "has line 10, which is not a package pinned with ==, followed by its hashes"],
    ["a package twice", `${TIME_LOCK}tzdata==2025.1 \\\n    --hash=sha256:${hex(9)}\n`, "pins one package twice, at line 10"],
    ["a carriage return", TIME_LOCK.replace("\n", "\r\n"), "holds a control character"],
    ["no pin of the server", lockOf([["tzdata", "2026.2"]]), "does not pin mcp-server-time 2026.11.4"],
    ["nothing", "", "does not pin mcp-server-time 2026.11.4"],
  ])("is refused with %s", (_what, lock, problem) => {
    expect(() => checkLock(lock, root)).toThrow(`the lock uv wrote for mcp-server-time ${problem}`);
  });

  it("is refused when uv printed it with anything else, before it is kept", () => {
    const docker = fakeDocker({ roots: { "3.13": ok("mcp-server-time==2026.11.4\n"), "3.15": ok("mcp-server-time==2026.11.4\n") }, lock: () => ok(`${TIME_LOCK}Resolved 31 packages in 1.2s\n`) });
    expect(() => resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner })).toThrow("has line 10, which is not a package pinned with ==");
  });
});

describe("the Python a PyPI server is resolved for", () => {
  const windows = (roots: Record<string, DockerResult>) => fakeDocker({ roots, lock: (_input, _python) => ok(lockOf([["windows-mcp", "0.8.8"]])) });

  it("is 3.13 when the newest release installs there, and 3.14 is not even asked", () => {
    const docker = timeDocker();
    const log: string[] = [];
    expect(resolvePypi(pypi("uvx", "mcp-server-time"), { log: (line) => log.push(line), runner: docker.runner }).python).toBe("3.13");
    expect(docker.compiles().map((call) => flag(call.args, "--python-version"))).toEqual(["3.13", "3.15", "3.13"]);
    expect(log.join("\n")).not.toMatch(/Python 3\.1[45]/);
  });

  it("is raised to 3.14 when the newest release needs it, and the log says so", () => {
    const docker = windows({ "3.13": ok("windows-mcp==0.8.5\n"), "3.14": ok("windows-mcp==0.8.8\n"), "3.15": ok("windows-mcp==0.8.8\n") });
    const log: string[] = [];
    const resolved = resolvePypi(pypi("uvx", "windows-mcp"), { log: (line) => log.push(line), runner: docker.runner });
    expect(resolved).toMatchObject({ packageName: "windows-mcp", version: "0.8.8", python: "3.14" });
    expect(log).toContain("mcpcage: Python 3.14 for windows-mcp 0.8.8, which needs it (on Python 3.13 it would be 0.8.5)");
    const lock = docker.compiles().at(-1)!;
    expect(flag(lock.args, "--python-version")).toBe("3.14");
    expect(lock.input).toBe("windows-mcp==0.8.8\n");
  });

  it("is raised to 3.15 when only 3.15 gives the newest release", () => {
    const docker = windows({ "3.13": ok("windows-mcp==0.8.5\n"), "3.14": ok("windows-mcp==0.8.6\n"), "3.15": ok("windows-mcp==0.8.8\n") });
    expect(resolvePypi(pypi("uvx", "windows-mcp"), { log: () => {}, runner: docker.runner }).python).toBe("3.15");
  });

  it("is raised when no release installs on 3.13, a pinned one included", () => {
    const docker = windows({ "3.14": ok("windows-mcp==0.8.8\n"), "3.15": ok("windows-mcp==0.8.8\n") });
    const log: string[] = [];
    expect(resolvePypi(pypi("uvx", "windows-mcp@0.8.8"), { log: (line) => log.push(line), runner: docker.runner }).python).toBe("3.14");
    expect(log).toContain("mcpcage: Python 3.14 for windows-mcp 0.8.8, which needs it");
  });

  it("is 3.14 when 3.15 has no wheel of the newest release and 3.14 has", () => {
    const docker = windows({ "3.13": ok("windows-mcp==0.8.5\n"), "3.14": ok("windows-mcp==0.8.8\n") });
    expect(resolvePypi(pypi("uvx", "windows-mcp"), { log: () => {}, runner: docker.runner }).python).toBe("3.14");
  });

  it("stays 3.13 when a newer Python only gives an older release", () => {
    const docker = windows({ "3.13": ok("windows-mcp==0.8.8\n"), "3.14": ok("windows-mcp==0.8.8\n"), "3.15": ok("windows-mcp==0.7.0\n") });
    expect(resolvePypi(pypi("uvx", "windows-mcp"), { log: () => {}, runner: docker.runner }).python).toBe("3.13");
    expect(docker.compiles().map((call) => flag(call.args, "--python-version"))).toEqual(["3.13", "3.15", "3.13"]);
  });

  it("is the one --python names, exactly, and nothing else is asked", () => {
    const docker = windows({ "3.12.4": ok("windows-mcp==0.8.8\n") });
    const resolved = resolvePypi(pypi("uvx", "--python", "3.12.4", "windows-mcp"), { log: () => {}, runner: docker.runner });
    expect(resolved.python).toBe("3.12.4");
    expect(docker.compiles().map((call) => flag(call.args, "--python-version"))).toEqual(["3.12.4", "3.12.4"]);
  });

  it("refuses with the reason uv gives on 3.13 when no Python has a release", () => {
    const docker = windows({});
    expect(() => resolvePypi(pypi("uvx", "windows-mcp"), { log: () => {}, runner: docker.runner })).toThrow("windows-mcp cannot be installed from PyPI wheels on Python 3.13 for Linux on ARM (linux/arm64), and the cage never builds a package from source: nothing on 3.13");
  });
});

describe("the platform of the wheels", () => {
  it("is the Docker engine's architecture, with the runtime's manylinux tag", () => {
    expect(wheelPlatform(fakeDocker({ arch: "amd64" }).runner)).toBe("x86_64-manylinux_2_40");
    expect(wheelPlatform(fakeDocker({ arch: "arm64" }).runner)).toBe("aarch64-manylinux_2_40");
  });

  it("refuses an engine of another architecture", () => {
    expect(() => wheelPlatform(fakeDocker({ arch: "s390x" }).runner)).toThrow("Docker runs s390x containers, and the cage builds PyPI servers for amd64 and arm64 only");
    expect(() => wheelPlatform(fakeDocker({ arch: "\u001b[2J" }).runner)).toThrow("Docker runs [U+001B][2J containers");
  });

  it("is the one the lock is resolved for", () => {
    const docker = fakeDocker({ arch: "amd64", roots: { "3.13": ok("mcp-server-time==2026.11.4\n"), "3.15": ok("mcp-server-time==2026.11.4\n") }, lock: () => ok(TIME_LOCK) });
    expect(resolvePypi(pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner }).platform).toBe("x86_64-manylinux_2_40");
    for (const call of docker.compiles()) expect(flag(call.args, "--python-platform")).toBe("x86_64-manylinux_2_40");
  });
});

describe("the lock of a PyPI server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is kept as requirements.lock next to the server's pin, readable by its owner only", () => {
    const home = mkdtempSync(join(tmpdir(), "mcpcage-pypi-"));
    vi.stubEnv("MCPCAGE_HOME", home);
    const docker = timeDocker();
    const locked = lockPypi("time", pypi("uvx", "mcp-server-time"), { log: () => {}, runner: docker.runner });
    const file = join(home, "servers", "time", "requirements.lock");
    expect(readFileSync(file, "utf8")).toBe(TIME_LOCK);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(locked).toMatchObject({ packageName: "mcp-server-time", version: "2026.11.4", python: "3.13", platform: "aarch64-manylinux_2_40" });
    expect(locked.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is not written when the resolve is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "mcpcage-pypi-"));
    vi.stubEnv("MCPCAGE_HOME", home);
    const docker = fakeDocker({ roots: { "3.13": ok("dbt-mcp==2.10.1\n"), "3.15": ok("dbt-mcp==2.10.1\n") }, lock: () => noSolution(DBT_NO_SOLUTION) });
    expect(() => lockPypi("dbt", pypi("uvx", "dbt-mcp==2.10.1"), { log: () => {}, runner: docker.runner })).toThrow("uuid==1.30 has no usable wheels");
    expect(() => statSync(join(home, "servers", "dbt", "requirements.lock"))).toThrow();
  });
});

describe("comparePypiVersions", () => {
  it.each([
    ["0.8.8", "0.8.5"],
    ["1.10", "1.9"],
    ["1.0.post1", "1.0"],
    ["1.0", "1.0rc1"],
    ["1.0rc1", "1.0b2"],
    ["1.0b2", "1.0a10"],
    ["1.0a1", "1.0.dev3"],
    ["1.0.dev3", "1.0.dev1"],
    ["1.0.post1.dev1", "1.0"],
    ["1.0.post1", "1.0.post1.dev1"],
    ["1.0rc1", "1.0rc1.dev1"],
    ["1!0.1", "2026.11.4"],
    ["2026.11.4", "2026.2.0"],
    ["1.0.1", "1.0"],
  ])("puts %s after %s", (newer, older) => {
    expect(comparePypiVersions(newer, older)).toBeGreaterThan(0);
    expect(comparePypiVersions(older, newer)).toBeLessThan(0);
  });

  it.each([
    ["1.0", "1.0.0"],
    ["1.0rc1", "1.0-rc.1"],
    ["1.0.post0", "1.0-0"],
    ["v1.2", "1.2"],
  ])("takes %s and %s for the same version", (left, right) => {
    expect(comparePypiVersions(left, right)).toBe(0);
  });

  it("never takes a version it cannot read for the newest", () => {
    expect(comparePypiVersions("not-a-version", "0.0.1")).toBeLessThan(0);
    expect(comparePypiVersions("0.0.1", "not-a-version")).toBeGreaterThan(0);
  });
});

describe("the package uv's reason says ships no wheel", () => {
  it("is named with its version when uv pins it, by name otherwise, from each form of uv 0.13.7's reasons", () => {
    const table: Array<[string, string | undefined]> = [
      ["Because uuid==1.30 has no usable wheels and all versions of dbtlabs-vortex depend on uuid==1.30, we can conclude that all versions of dbtlabs-vortex cannot be used.", "uuid 1.30"],
      ["Because pybars3==0.9.7 has no usable wheels and only pybars3<=0.9.7 is available, we can conclude that pybars3>=0.9.7 cannot be used.", "pybars3 0.9.7"],
      ["Because cffi{platform_python_implementation != 'PyPy'}==2.0.0 has no usable wheels and all versions of mcp-proxy-for-aws-cli depend on cffi", "cffi 2.0.0"],
      ["Because orjson>=3.10.13 has no usable wheels and leanclient>=0.1.7,<=0.2.0 depends on orjson>=3.10.13, we can conclude ...", "orjson"],
      ["Because all of: pyyaml<=5.1b5 pyyaml>=5.1 have no usable wheels and only the following versions of pyyaml are available: ...", "pyyaml"],
      ["Because all versions of proxy-tools have no usable wheels and pywebview==6.2 depends on proxy-tools, ...", "proxy-tools"],
      // Another reason: there is no wheel to name.
      ["Because there is no version of pglast==7.2.0 and postgres-mcp>=0.3.0 depends on pglast==7.2.0, we can conclude ...", undefined],
      ["uv gives no reason", undefined],
    ];
    for (const [reason, named] of table) expect(noWheel(reason), reason).toBe(named);
  });
});
