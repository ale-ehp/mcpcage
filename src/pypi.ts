import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./canonical.js";
import { pypiRequirement, type PypiLaunch } from "./launch.js";
import { serverDir } from "./paths.js";
import { dockerProgram, ensureDir, NONROOT, PYPI_RESOLVE_BASE } from "./sandbox.js";
import { terminalSafe } from "./terminal.js";

/*
 * A PyPI server (uvx) is built in two steps, neither of which runs a line of the package's code:
 * it is resolved into a requirements file that pins every package and the sha256 of every file of
 * it, in a hardened container of the resolve image (here), and the image is installed from that
 * file only. uv runs in containers only: mcpcage starts docker, never uv, pip or python, on the host.
 */

/** What a docker command gave: its exit status and what it printed. */
export interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs docker with `args`, `input` on its standard input, as mcpcage finds and starts it (see
 * dockerProgram). `stream` sends what it prints to mcpcage's stderr instead of returning it: stdout is
 * the MCP channel. Tests give their own.
 */
export type DockerRunner = (args: string[], options?: { input?: string; stream?: boolean }) => DockerResult;

/**
 * The docker of dockerProgram, with the environment of the docker commands that build and pull: the
 * allowlisted one, without the variables an entry gives its server (see trustedEnv). A resolve is not
 * the cage's run, and a credential helper started for the pull of the resolve image must not get them.
 */
export const realDocker: DockerRunner = (args, options = {}) => {
  const program = dockerProgram();
  if (program === undefined) throw new Error("docker.exe not found in the PATH");
  const result = spawnSync(program.file, [...program.args, ...args], {
    encoding: "utf8",
    env: program.env,
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", options.stream ? 2 : "pipe", options.stream ? 2 : "pipe"],
    // A lock pins every file of every package: tens of thousands of lines for a server with numpy,
    // onnxruntime and friends, more than the 1 MiB spawnSync keeps by default.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** What a resolve found: the server's own package and version, and the lock. */
export interface PypiResolution {
  /** The server's package, in the normal form uv prints: `awslabs-aws-documentation-mcp-server`. */
  packageName: string;
  version: string;
  /** The Python the lock is for, as uv was given it: 3.13, or the version --python asks for. */
  python: string;
  /** The wheels' platform: `x86_64-manylinux_2_40` or `aarch64-manylinux_2_40`. */
  platform: string;
  /** The requirements file: every package pinned with `==`, each with the sha256 of its files. */
  lock: string;
}

/** The Python a server is resolved for when --python names none; see choosePython for when a newer one is taken. */
export const DEFAULT_PYTHON = "3.13";

/**
 * The platform the wheels are chosen for: the Docker engine's architecture, with the manylinux tag
 * of the runtime's glibc (2.41; 2_40 is the newest uv 0.13.7 names, which only leaves out wheels that
 * need a newer glibc still). Asked of the engine, not of this machine: Docker Desktop on an Intel
 * Mac or a remote DOCKER_HOST can run another architecture than node's.
 */
export function wheelPlatform(runner: DockerRunner = realDocker): string {
  const result = runner(["version", "--format", "{{.Server.Arch}}"]);
  if (result.status !== 0) throw new Error(`docker version failed: ${firstLines(result.stderr)}`);
  const arch = result.stdout.trim();
  const machine = arch === "amd64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  if (machine === undefined) throw new Error(`Docker runs ${terminalSafe(arch)} containers, and the cage builds PyPI servers for amd64 and arm64 only`);
  return `${machine}-manylinux_2_40`;
}

/**
 * The `docker run` of the resolve image for one `uv pip compile`, the requirements on stdin and the
 * result on stdout. Hardened like the cage, with the network on, which PyPI needs: nonroot, a
 * read-only root with a small /tmp, no capabilities, no new privileges, bounded processes and memory
 * (the same value for swap, or Docker allows as much again). No host file is mounted, and the
 * container gets four variables of mcpcage's choosing and no other: uv reads no settings file
 * (UV_NO_CONFIG), keeps no cache, downloads no Python (the image's own is only queried for its
 * platform), and finds its home in /tmp. `uv pip compile --no-build` reads metadata only: it never
 * builds a package, so no package code runs here.
 */
export function resolveArgs(compile: string[]): string[] {
  return [
    "run", "--rm", "-i",
    "--network", "bridge",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", NONROOT,
    "--pids-limit", "128",
    "--memory", "1g",
    "--memory-swap", "1g",
    "-e", "HOME=/tmp",
    "-e", "UV_NO_CONFIG=1",
    "-e", "UV_NO_CACHE=1",
    "-e", "UV_PYTHON_DOWNLOADS=never",
    "--entrypoint", "uv",
    PYPI_RESOLVE_BASE,
    "pip", "compile", ...compile, "-",
  ];
}

/**
 * Resolves a PyPI server from PyPI wheels only, in three steps (DESIGN: the build pipeline):
 *
 * 1. The server's own version: the newest release whose wheel fits, its dependencies left out
 *    (--no-deps). With --no-build uv does not fail when a dependency has no wheel: it goes back to
 *    older releases, the server's own included, until every package has one. dbt-mcp 2.10.1 became
 *    0.2.1 so, silently. Pinned first, the server's version cannot move, and a dependency without
 *    a wheel fails the resolve with uv's own reason.
 * 2. The Python: the one --python names, else 3.13, unless the newest release needs a newer one
 *    (see choosePython).
 * 3. The lock: the server pinned to that version, with its extras and the --with requirements,
 *    every package with the sha256 of each of its files (--generate-hashes).
 *
 * Every answer of uv is checked before it is used (see rootPin and checkLock).
 */
export function resolvePypi(spec: PypiLaunch, options: { log: (message: string) => void; runner?: DockerRunner; platform?: string }): PypiResolution {
  const runner = options.runner ?? realDocker;
  const platform = options.platform ?? wheelPlatform(runner);
  const parsed = checkedRequirement(spec.requirement);
  for (const requirement of spec.with) checkedRequirement(requirement);
  options.log(`mcpcage: resolving ${spec.project} from PyPI, wheels only...`);
  const { root, python } = choosePython(spec, platform, runner, options.log);
  const extras = parsed.extras.length > 0 ? `[${parsed.extras.join(",")}]` : "";
  const input = [`${root.name}${extras}==${root.version}`, ...spec.with].map((line) => `${line}\n`).join("");
  const answer = compile(runner, input, python, platform, spec, ["--generate-hashes"]);
  if ("unsolvable" in answer) throw unsolvable(spec.project, python, answer.unsolvable);
  checkLock(answer.stdout, root);
  options.log(`mcpcage: ${root.name} ${root.version} on Python ${python}, ${pins(answer.stdout)} packages locked with their hashes`);
  return { packageName: root.name, version: root.version, python, platform, lock: answer.stdout };
}

/**
 * Resolves `spec` (see resolvePypi) and keeps the lock as `requirements.lock` next to the server's
 * pin, where the build reads it and every later build of the same spec reuses it.
 */
export function lockPypi(
  serverId: string,
  spec: PypiLaunch,
  options: { log: (message: string) => void; runner?: DockerRunner; platform?: string },
): PypiResolution & { lockfileSha256: string } {
  const resolution = resolvePypi(spec, options);
  const dir = serverDir(serverId);
  ensureDir(dir);
  writeFileSync(join(dir, "requirements.lock"), resolution.lock, { mode: 0o600 });
  return { ...resolution, lockfileSha256: sha256(resolution.lock) };
}

/** A pin of the lock: a package's normal name and its version. */
export interface Pin {
  name: string;
  version: string;
}

/**
 * Step 1 and 2: the server's version, and the Python it is resolved for. --python is taken as given.
 * Without it, 3.13 (of 40 popular servers, 36 resolve wheel-only at their newest release on 3.13, 35
 * on 3.14 and fewer on 3.15, whose wheels are still missing for pyyaml, cffi, orjson...), unless the
 * newest release needs a newer one, as `requires-python >=3.14` says: windows-mcp is 0.8.5 on 3.13
 * and 0.8.8 on 3.14 and 3.15. Then the first of 3.14 and 3.15 that gives the newest release, said in
 * the log, because uvx would run that release on a machine whose Python is new enough. 3.14 is asked
 * only when 3.15 gives a newer release than 3.13, or when one of them gives none (a release whose
 * wheels are all for older Pythons can be missing on 3.15).
 */
function choosePython(spec: PypiLaunch, platform: string, runner: DockerRunner, log: (message: string) => void): { root: Pin; python: string } {
  const ask = (python: string): Pin | { unsolvable: string } => {
    const answer = compile(runner, `${spec.requirement}\n`, python, platform, spec, ["--no-deps"]);
    return "unsolvable" in answer ? answer : rootPin(answer.stdout, spec.project);
  };
  if (spec.python !== undefined) {
    const root = ask(spec.python);
    if ("unsolvable" in root) throw unsolvable(spec.project, spec.python, root.unsolvable);
    return { root, python: spec.python };
  }
  const answers = new Map<string, Pin | { unsolvable: string }>();
  answers.set(DEFAULT_PYTHON, ask(DEFAULT_PYTHON));
  answers.set("3.15", ask("3.15"));
  const onDefault = answers.get(DEFAULT_PYTHON)!;
  const onNewest = answers.get("3.15")!;
  if ("unsolvable" in onNewest || "unsolvable" in onDefault || comparePypiVersions(onNewest.version, onDefault.version) > 0) answers.set("3.14", ask("3.14"));
  const found = ["3.13", "3.14", "3.15"].flatMap((python) => {
    const answer = answers.get(python);
    return answer === undefined || "unsolvable" in answer ? [] : [{ python, root: answer }];
  });
  if (found.length === 0) throw unsolvable(spec.project, DEFAULT_PYTHON, (onDefault as { unsolvable: string }).unsolvable);
  const newest = found.reduce((best, next) => (comparePypiVersions(next.root.version, best.root.version) > 0 ? next : best));
  if (newest.python !== DEFAULT_PYTHON) {
    const before = "unsolvable" in onDefault ? "" : ` (on Python ${DEFAULT_PYTHON} it would be ${onDefault.version})`;
    log(`mcpcage: Python ${newest.python} for ${newest.root.name} ${newest.root.version}, which needs it${before}`);
  }
  return newest;
}

/**
 * One `uv pip compile` in the resolve image: what it printed, or why uv found no solution. Any other
 * failure throws. `--quiet` keeps uv's warnings out of what is checked, `--no-header` and
 * `--no-annotate` keep the output to the pins themselves.
 */
function compile(runner: DockerRunner, input: string, python: string, platform: string, spec: PypiLaunch, step: string[]): { stdout: string } | { unsolvable: string } {
  const flags = [
    "--quiet", "--no-build", ...step, "--no-header", "--no-annotate",
    "--python-version", python,
    "--python-platform", platform,
    ...(spec.resolution.prerelease === undefined ? [] : ["--prerelease", spec.resolution.prerelease]),
    ...(spec.resolution.excludeNewer === undefined ? [] : ["--exclude-newer", spec.resolution.excludeNewer]),
  ];
  const result = runner(resolveArgs(flags), { input });
  if (result.status === 0) return { stdout: result.stdout };
  const reason = noSolution(result.stderr);
  if (reason !== undefined) return { unsolvable: reason };
  throw new Error(`the resolve of ${spec.project} failed (exit code ${result.status}): ${firstLines(result.stderr)}`);
}

/**
 * uv's explanation when it finds no solution, on one line: what follows its "No solution found"
 * line, the causes and hints, with its layout taken out. undefined when uv failed for another reason.
 */
function noSolution(stderr: string): string | undefined {
  const start = stderr.search(/No solution found when resolving dependencies/);
  if (start === -1) return undefined;
  const rest = stderr.slice(start).split(/\r?\n/).slice(1).join(" ");
  const reason = rest.replace(/(?:^|\s)(?:cause:|[\u2570\u2500\u25b6]+)\s*/g, " ").replace(/\s+/g, " ").trim();
  return clip(reason === "" ? "uv gives no reason" : reason, 2000);
}

/** The refusal for a server uv finds no wheels for: its name, the Python, and uv's own reason. */
function unsolvable(project: string, python: string, reason: string): Error {
  return new Error(terminalSafe(`${project} cannot be installed from PyPI wheels on Python ${python}, and the cage never builds a package from source: ${reason}`));
}

/**
 * The server's own pin, from step 1: uv printed one `name==version` line and nothing else (comments and
 * blank lines aside), naming the server's package.
 */
function rootPin(output: string, project: string): Pin {
  const lines = output.split("\n").filter((line) => line.trim() !== "" && !/^\s*#/.test(line));
  const pin = lines.length === 1 ? /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$/.exec(lines[0]!) : null;
  if (pin === null || !isPin(pin[1]!, pin[2]!) || normalName(pin[1]!) !== project) {
    throw new Error(`the resolve of ${project} printed something other than the version of ${project}`);
  }
  return { name: normalName(pin[1]!), version: pin[2]! };
}

/**
 * Checks a lock uv wrote before it is kept: only `name==version \` lines, each followed by its
 * `    --hash=sha256:<64 hex>` lines (a ` \` after each but the last), comments and blank lines; every
 * pin hashed, no package twice, and the server pinned to the version step 1 chose. Anything else is
 * a failed resolve: `uv pip sync --require-hashes` would refuse some of it, but other lines (an
 * index URL, an option, a path or a URL of a package) would change where the build takes its code
 * from. Nothing of the line is quoted, only where it is.
 */
export function checkLock(lock: string, root: Pin): void {
  const refuse = (problem: string) => new Error(`the lock uv wrote for ${root.name} ${problem}`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(lock)) throw refuse("holds a control character");
  const lines = lock.split("\n");
  const seen = new Set<string>();
  let rootFound = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+) \\$/.exec(line);
    if (pin === null || !isPin(pin[1]!, pin[2]!)) throw refuse(`has line ${index + 1}, which is not a package pinned with ==, followed by its hashes`);
    const name = normalName(pin[1]!);
    if (seen.has(name)) throw refuse(`pins one package twice, at line ${index + 1}`);
    seen.add(name);
    if (name === root.name) {
      if (pin[2] !== root.version) throw refuse(`pins ${root.name} to another version than ${root.version}`);
      rootFound = true;
    }
    // Its hashes, at least one, up to the one that ends without a backslash.
    for (;;) {
      index++;
      const hash = /^ {4}--hash=sha256:[0-9a-f]{64}( \\)?$/.exec(lines[index] ?? "");
      if (hash === null) throw refuse(`has a pin without its hashes, or something else among them, at line ${index + 1}`);
      if (hash[1] === undefined) break;
    }
  }
  if (!rootFound) throw refuse(`does not pin ${root.name} ${root.version}`);
}

/** The packages a checked lock pins. */
function pins(lock: string): number {
  return lock.split("\n").filter((line) => /^[A-Za-z0-9]/.test(line)).length;
}

/** Whether `name==version` is a requirement of the subset the cage takes, with one exact version. */
function isPin(name: string, version: string): boolean {
  const parsed = pypiRequirement(`${name}==${version}`);
  return parsed !== undefined && parsed.extras.length === 0 && parsed.specifiers.length === 1 && !version.includes("*");
}

/** A requirement of the spec, checked again before it is written on uv's stdin, one per line. */
function checkedRequirement(requirement: string): { name: string; extras: string[] } {
  const parsed = /[\u0000-\u001f\u007f]/.test(requirement) ? undefined : pypiRequirement(requirement);
  if (parsed === undefined) throw new Error("not a PyPI requirement: give a name, optional [extras] and versions");
  return parsed;
}

/** A package name in PEP 503 normal form, as uv prints it. */
function normalName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** PEP 440 versions, as written: epoch, release, pre, post and dev parts, a local label. */
const VERSION_PARTS =
  /^v?(?:([0-9]+)!)?([0-9]+(?:\.[0-9]+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?([0-9]*))?(?:-([0-9]+)|[-_.]?(?:post|rev|r)[-_.]?([0-9]*))?(?:[-_.]?(dev)[-_.]?([0-9]*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;

/**
 * How two PEP 440 versions sort: negative when `left` comes first, 0 when they are equal, positive
 * when `left` is newer. A dev release comes before the pre-releases of its version, which come before
 * the release, which comes before its post releases; local labels are left out (PyPI refuses them).
 * A version that does not parse sorts first, so that it is never taken as the newest.
 */
export function comparePypiVersions(left: string, right: string): number {
  const a = versionKey(left);
  const b = versionKey(right);
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const PRE = new Map([["a", 0], ["alpha", 0], ["b", 1], ["beta", 1], ["c", 2], ["rc", 2], ["pre", 2], ["preview", 2]]);

/** A version as numbers that sort as PEP 440 says: epoch, release (eight parts), pre, post, dev. */
function versionKey(version: string): number[] | undefined {
  const match = VERSION_PARTS.exec(version);
  if (match === null) return undefined;
  const [, epoch, release, pre, preNumber, postDash, postNumber, dev, devNumber] = match;
  const parts = release!.split(".").map(Number);
  if (parts.length > 8) return undefined;
  // A part that is not written is undefined; one written without its number ("1.0.post") is "".
  const post = postDash ?? postNumber;
  const hasPost = post !== undefined;
  const key = [Number(epoch ?? 0), ...parts, ...Array<number>(8 - parts.length).fill(0)];
  // Without a pre-release part a version sorts after its pre-releases, unless it is a dev release
  // of it alone (1.0.dev1), which sorts before them.
  if (pre !== undefined) key.push(PRE.get(pre.toLowerCase())!, Number(preNumber || 0));
  else if (dev !== undefined && !hasPost) key.push(-1, 0);
  else key.push(3, 0);
  key.push(hasPost ? Number(post || 0) : -1);
  key.push(dev !== undefined ? Number(devNumber || 0) : Number.MAX_SAFE_INTEGER);
  return key;
}

/** The first lines of what a program printed on stderr, for an error message. */
function firstLines(text: string): string {
  return clip(terminalSafe(text.trim().split(/\r?\n/).slice(0, 4).join(" ").replace(/\s+/g, " ")) || "it printed nothing", 500);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
