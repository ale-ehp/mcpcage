import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { pypiRequirement, type PypiLaunch } from "./launch.js";
import { cageHome, serverDir } from "./paths.js";
import { readJson } from "./pinstore.js";
import { dockerProgram, ensureDir, NONROOT, PYPI_INSTALL_BASE, PYPI_RESOLVE_BASE, PYPI_RUNTIME_BASE, UV_BASE, type SandboxOptions, type ServerRecord } from "./sandbox.js";
import { streamSafely, terminalSafe } from "./terminal.js";

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
 * dockerProgram). `stream` sends what it prints to mcpcage's stderr instead of returning it, spelled
 * out where a terminal would act on it (see streamSafely): stdout is the MCP channel. Tests give their own.
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
  if (options.stream) {
    if (options.input !== undefined) throw new Error("realDocker streams the output of a command without input only");
    return { ...streamSafely(program.file, [...program.args, ...args], program.env), stdout: "", stderr: "" };
  }
  const result = spawnSync(program.file, [...program.args, ...args], {
    encoding: "utf8",
    env: program.env,
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
  pullResolveImage(runner, options.log);
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
 * Pulls the resolve image when Docker does not have it, and says so. `docker run` pulled it by itself
 * at the first resolve on a machine, what it printed kept with the rest of the resolve's stderr and
 * never shown, so the user waited on "resolving ..." for as long as uv's image (61 MB unpacked) took
 * to come, with no word of why. It is pinned by its digest: once there, it is never pulled again.
 * Quietly, as Docker prints one line for a pull with --quiet; its error, when it fails.
 */
function pullResolveImage(runner: DockerRunner, log: (message: string) => void): void {
  if (runner(["image", "inspect", "--format", "{{.Id}}", PYPI_RESOLVE_BASE]).status === 0) return;
  log(`mcpcage: pulling uv's image, which PyPI servers are resolved in, once: ${PYPI_RESOLVE_BASE}...`);
  if (runner(["pull", "--quiet", PYPI_RESOLVE_BASE], { stream: true }).status !== 0) throw new Error(`docker pull ${PYPI_RESOLVE_BASE} failed`);
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

/**
 * The refusal for a server uv finds no solution for from PyPI's wheels (a dependency with no wheel,
 * a version PyPI does not have): its name, the Python, and uv's own reason, which `reason` keeps
 * alone. A server so refused is refused again at every start, unlike a resolve that failed for want
 * of Docker or the network: wrap and --fix leave its entry as it is (see checkPypi), and --inspect
 * names a package that ships no wheel (see noWheel).
 */
export class PypiUnsolvable extends Error {
  constructor(
    project: string,
    python: string,
    readonly reason: string,
  ) {
    super(terminalSafe(`${project} cannot be installed from PyPI wheels on Python ${python}, and the cage never builds a package from source: ${reason}`));
  }
}

/**
 * The package uv's reason says ships no wheel for the cage's Python and platform, as the report names
 * it: `uuid 1.30` for "Because uuid==1.30 has no usable wheels", `pyyaml` for "Because pyyaml>=5.1 has
 * no usable wheels" or "all of: pyyaml<=5.1b5 pyyaml>=5.1 have no usable wheels". uvx builds such a
 * package from its source distribution on the host, running its build code. Undefined when the reason
 * is another one (a version PyPI does not have).
 */
export function noWheel(reason: string): string | undefined {
  const name = "([A-Za-z0-9][A-Za-z0-9._-]*)";
  const one = new RegExp(`(?:^|\\s)${name}(?:\\{[^}]*\\})?(?:==([^\\s,]+)|(?:===|!=|<=|>=|~=|<|>)[^\\s,]+)? has no usable wheels`).exec(reason);
  if (one !== null) return one[2] === undefined ? one[1] : `${one[1]} ${one[2]}`;
  return new RegExp(`(?:all versions of |all of: )${name}\\S* .*?have no usable wheels`).exec(reason)?.[1];
}

function unsolvable(project: string, python: string, reason: string): PypiUnsolvable {
  return new PypiUnsolvable(project, python, reason);
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
export function checkLock(lock: string, root: Pin, what = `the lock uv wrote for ${root.name}`): void {
  const refuse = (problem: string) => new Error(`${what} ${problem}`);
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

/**
 * Builds (or reuses) the image of a PyPI server and returns its record. The lock is reused, and
 * nothing is resolved again, unless --rebuild, or the part of the spec that decides what is installed
 * changed (the requirement, --with, --python, the resolution options; the server's own arguments do
 * not), or the engine is of another architecture than the lock's wheels (a store copied to another
 * machine), or the lock on disk is not the one recorded. So `@latest` and an unpinned requirement
 * mean the newest release at the first build, kept until --rebuild, as uvx keeps the tool it cached.
 * The image is built again from the same lock when it is gone, and reused when its tag is there.
 */
export function preparePypiImage(options: SandboxOptions, runner: DockerRunner = realDocker): ServerRecord {
  const spec = options.spec as PypiLaunch;
  const previous = readJson<ServerRecord>(join(serverDir(options.serverId), "server.json"));
  const platform = wheelPlatform(runner);
  const kept = options.rebuild ? undefined : keptLock(options.serverId, spec, platform);
  const reuse = kept !== undefined && previous !== undefined;
  // A lock wrap or --fix made a moment ago (see checkPypi), for this very spec and platform: the
  // image is built from it, not from a second resolve.
  const fresh = options.pypiLock !== undefined && sameInstall(options.pypiLock.spec, spec) && options.pypiLock.platform === platform ? options.pypiLock : undefined;
  const locked = kept ?? fresh ?? lockPypi(options.serverId, spec, { log: options.log, runner, platform });
  const python = managedPython(locked.python);
  const dockerfile = pypiDockerfile({ command: spec.command, python });
  // The image is a function of the lock and the Dockerfile, which names the Python, the bases and the
  // command: the same tag is the same image, whoever built it.
  const tag = `mcpcage/${options.serverId}:${sha256(`${locked.lock}\n${dockerfile}`).slice(0, 12)}`;
  let id = imageIdOf(tag, runner);
  if (id === undefined || options.rebuild) {
    buildPypiImage({ serverId: options.serverId, tag, dockerfile, lock: locked.lock }, { log: options.log, runner });
    id = imageIdOf(tag, runner);
    if (id === undefined) throw new Error(`docker build left no image ${tag}`);
  }
  // The same image: the record stays, with the spec of this start (its arguments may differ).
  if (reuse && previous.image === tag && previous.imageId === id) return { ...previous, spec };
  return {
    serverId: options.serverId,
    spec,
    image: tag,
    imageId: id,
    packageName: locked.packageName,
    version: locked.version,
    lockfileSha256: sha256(locked.lock),
    python,
    platform,
    uvVersion: uvVersion(),
    builtAt: new Date().toISOString(),
  };
}

/** What of a PyPI spec decides what is installed: a change in any of it is a new resolve. */
function installed(spec: PypiLaunch): unknown {
  return { requirement: spec.requirement, with: spec.with, python: spec.python ?? null, resolution: spec.resolution };
}

/** Whether two PyPI specs install the same: the same requirement, --with, Python and resolution options. */
function sameInstall(left: PypiLaunch, right: PypiLaunch): boolean {
  return canonicalJson(installed(left)) === canonicalJson(installed(right));
}

/**
 * The lock kept for a server, when it can be reused for `spec` on `platform` (see preparePypiImage):
 * the server's record is for the same install, the same platform, and names the lock on disk by its
 * sha256. Undefined when it cannot, and the server is resolved again.
 *
 * A lock that can be reused is checked again as a fresh one is (see checkLock), against the spec's
 * package and the recorded version: the lock and the sha256 that names it are both in the store, so
 * the sha256 says only that the two agree, and the build fed `uv pip sync` any lock that came with
 * a record to match, an index URL or a package's URL among its lines. mcpcage never keeps a lock that
 * fails the check, so one that does was written by something else: it is refused, not resolved again
 * over, and --rebuild (which skips this) replaces it.
 */
function keptLock(serverId: string, spec: PypiLaunch, platform: string): { packageName: string; version: string; python: string; lock: string } | undefined {
  const dir = serverDir(serverId);
  const previous = readJson<ServerRecord>(join(dir, "server.json"));
  const lockfile = join(dir, "requirements.lock");
  const kept = existsSync(lockfile) ? readFileSync(lockfile, "utf8") : undefined;
  if (previous?.spec.kind !== "pypi" || !sameInstall(previous.spec, spec) || previous.platform !== platform) return undefined;
  if (previous.python === undefined || previous.packageName === undefined || previous.version === undefined) return undefined;
  if (kept === undefined || sha256(kept) !== previous.lockfileSha256) return undefined;
  // The record is read from the store too: its version is spelled out where the message quotes it.
  const what = `the lock kept for ${spec.project} in ${lockfile}`;
  const refused = (problem: string) => new Error(terminalSafe(`${problem}; mcpcage never keeps such a lock, and --rebuild resolves the server again`));
  if (previous.packageName !== spec.project) throw refused(`${what} is recorded for another package than ${spec.project}`);
  try {
    checkLock(kept, { name: spec.project, version: previous.version }, what);
  } catch (error) {
    throw refused((error as Error).message);
  }
  return { packageName: previous.packageName, version: previous.version, python: previous.python, lock: kept };
}

/** A lock made for a spec (see lockPypi), which the image of that spec can be built from. */
export type PypiLock = PypiResolution & { lockfileSha256: string; spec: PypiLaunch };

/** What a resolve gave wrap and --fix (see checkPypi): the lock, uv's reason for none, or another failure. */
export type PypiCheck = { locked: PypiLock } | { unsolvable: string } | { failed: string };

/** The resolve wrap and --fix ask for each uvx server they are about to write; tests give their own. */
export type PypiResolver = (serverId: string, spec: PypiLaunch) => PypiCheck;

/**
 * The resolve of a uvx server that wrap and protect --fix run before they write its entry: seconds,
 * no build. A lock that `run` would reuse is reused, so that an entry caged again does not move to
 * a newer release; otherwise the server is resolved and its lock kept (see lockPypi), for the build
 * that follows. uv's "No solution found" is `unsolvable`, with mcpcage's words and uv's reason: such
 * a server would fail at every start of the client, and its entry is left as it is. Any other
 * failure (Docker stopped, no network) is `failed`: the entry is written, and resolved and built at
 * its first start, as an npx server whose build failed is.
 */
export function checkPypi(serverId: string, spec: PypiLaunch, options: { log: (message: string) => void; runner?: DockerRunner }): PypiCheck {
  const runner = options.runner ?? realDocker;
  try {
    const platform = wheelPlatform(runner);
    const kept = keptLock(serverId, spec, platform);
    if (kept !== undefined) return { locked: { ...kept, platform, lockfileSha256: sha256(kept.lock), spec } };
    return { locked: { ...lockPypi(serverId, spec, { log: options.log, runner, platform }), spec } };
  } catch (error) {
    if (error instanceof PypiUnsolvable) return { unsolvable: error.message };
    return { failed: error instanceof Error ? error.message : "an unexpected error" };
  }
}

/**
 * Builds the image `tag` from `lock` with `dockerfile` (see pypiDockerfile). Docker's build cache is
 * used: the npm path builds a fresh install with --no-cache because `npm install` resolves inside the
 * build, so a cached layer of an earlier build held an older resolve; here nothing resolves in the
 * build. Each step is a function of what it is given: the Python by its exact version, which uv
 * checks against the sha256 it ships with, and the packages by the hashes of the lock, which
 * `uv pip sync --require-hashes` checks. A layer from the cache is the layer the step would make.
 * `wheels`, for tests alone: local wheel files put in the context under wheels/, for a lock that
 * names them in /app/wheels; mcpcage itself never passes any.
 */
export function buildPypiImage(
  build: { serverId: string; tag: string; dockerfile: string; lock: string },
  options: { log: (message: string) => void; runner?: DockerRunner; wheels?: string[] },
): void {
  const runner = options.runner ?? realDocker;
  ensureDir(cageHome());
  const context = mkdtempSync(join(cageHome(), "build-"));
  try {
    writeFileSync(join(context, "Dockerfile"), build.dockerfile);
    writeFileSync(join(context, "requirements.lock"), build.lock);
    if (options.wheels !== undefined && options.wheels.length > 0) {
      mkdirSync(join(context, "wheels"));
      for (const wheel of options.wheels) copyFileSync(wheel, join(context, "wheels", basename(wheel)));
    }
    options.log(`mcpcage: building the sandbox image for ${build.serverId} from its lock (wheels only, no package code runs)...`);
    // --force-rm, as the npm path builds: a failed step leaves no stopped container (see prepareNpmImage).
    const result = runner(["build", "--force-rm", "--label", `mcpcage.server=${build.serverId}`, "-t", build.tag, context], { stream: true });
    if (result.status !== 0) throw new Error(`docker build failed for ${build.serverId}${result.stderr.trim() === "" ? "" : `: ${firstLines(result.stderr)}`}`);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** The id of the image `reference`, or undefined when there is none. */
function imageIdOf(reference: string, runner: DockerRunner): string | undefined {
  const result = runner(["image", "inspect", "--format", "{{.Id}}", reference]);
  return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
}

/**
 * The CPython uv installs for each minor version the cage runs: the newest patch that the pinned uv
 * (0.13.7) knows, python-build-standalone 20261026, which uv checks against the sha256 it ships with.
 * test/pypi.docker.test.ts asks the pinned uv, so that a uv bump that knows newer ones fails until
 * this table follows it.
 */
export const MANAGED_PYTHON: ReadonlyMap<string, string> = new Map([
  ["3.10", "3.10.22"],
  ["3.11", "3.11.18"],
  ["3.12", "3.12.16"],
  ["3.13", "3.13.18"],
  ["3.14", "3.14.10"],
  ["3.15", "3.15.2"],
]);

/** The exact CPython to install for `python`: a minor version from MANAGED_PYTHON, or the patch --python names. */
export function managedPython(python: string): string {
  const exact = /^3\.1[0-5]\.(?:0|[1-9][0-9]{0,2})$/.test(python) ? python : MANAGED_PYTHON.get(python);
  if (exact === undefined) throw new Error(`the cage runs CPython 3.10 to 3.15, and ${terminalSafe(JSON.stringify(python))} is not one of them`);
  return exact;
}

/** The release of the uv that builds the image, from the tag of its pinned image. */
export function uvVersion(): string {
  const version = /^ghcr\.io\/astral-sh\/uv:([0-9]+\.[0-9]+\.[0-9]+)@sha256:/.exec(UV_BASE)?.[1];
  if (version === undefined) throw new Error(`runtime/bases.Dockerfile: ${UV_BASE} is not uv's image tagged with its release`);
  return version;
}

/** A console script's name as the cage starts it: a plain file name of the venv's bin. */
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/*
 * Removes pip from the managed Python's own site-packages, and its scripts: the venv never had it,
 * and the runtime keeps no package manager, as the npm path's keeps no npm. uv links each minor
 * version to its install (cpython-3.13-linux-... -> cpython-3.13.18-linux-...), which is skipped.
 */
const REMOVE_PIP = [
  "import glob, os, shutil",
  "for home in glob.glob('/opt/python/*'):",
  "    if os.path.islink(home):",
  "        continue",
  "    for path in glob.glob(home + '/lib/python3.*/site-packages/pip') + glob.glob(home + '/lib/python3.*/site-packages/pip-*.dist-info') + glob.glob(home + '/bin/pip*'):",
  "        if os.path.isdir(path) and not os.path.islink(path):",
  "            shutil.rmtree(path)",
  "        else:",
  "            os.remove(path)",
  "",
].join("\n");

/*
 * Compiles the bytecode of each directory given, in worker processes (compile_dir's workers=0), the
 * .pyc files valid whatever the sources' times say (the image never changes). A file that does not
 * compile is left without bytecode, as pip and uv leave it: nothing can import it anyway, and some
 * wheels still carry a file written for Python 2 (olefile's olefile2.py, which excel-mcp-server
 * depends on), for which `python -m compileall` exits 1 and failed the whole build.
 */
const COMPILE = [
  "import compileall, py_compile, sys",
  "for path in sys.argv[1:]:",
  "    compileall.compile_dir(path, quiet=2, workers=0, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)",
  "",
].join("\n");

/** Fails the build, naming the programs the venv has, when the command is not one of them. */
const COMMAND_EXISTS =
  "import os, sys; b = '/app/venv/bin'; p = os.path.join(b, sys.argv[1]); " +
  "sys.exit(0 if os.path.isfile(p) and os.access(p, os.X_OK) else 'no ' + sys.argv[1] + ' in the package; it has: ' + ', '.join(sorted(os.listdir(b))))";

/**
 * The Dockerfile of a PyPI server. The install stage puts the exact managed CPython in /opt/python,
 * makes an empty venv, and installs the lock into it with the one uv command that touches the venv:
 * `uv pip sync --require-hashes --no-build`, on the empty venv, which starts no Python of the venv
 * with packages in it. Nothing after it starts uv. Python itself runs only with -I -S: -S skips the
 * site module, so no .pth file of a package (whose `import` lines site executes at every start),
 * no sitecustomize; -I ignores the PYTHON* variables and the user's site. So no package code runs
 * in the build, which has the network. Bytecode is compiled so, never with uv's --compile-bytecode,
 * which runs the venv's Python with its site; the runtime's root is read-only, so Python could never
 * cache it there, and python-build-standalone ships the standard library without it. The runtime
 * stage gets the interpreter and the venv only, and starts the console script, whose
 * `#!/app/venv/bin/python` line the kernel follows: no shell, no uv, no pip there.
 *
 * Every RUN is in exec form: the distroless bases have no shell. The command and the Python are
 * checked before they are written, as the npm path quotes its install line. `wheels` adds the
 * context's wheels/ for a test's lock (see buildPypiImage), and nothing else.
 */
export function pypiDockerfile(build: { command: string; python: string; wheels?: boolean }): string {
  const python = managedPython(build.python);
  if (!COMMAND.test(build.command)) throw new Error("the command of a PyPI server must be a plain file name: letters, digits, dots, dashes and underscores, starting with a letter or digit");
  const minor = python.split(".").slice(0, 2).join(".");
  const venvPython = "/app/venv/bin/python";
  const run = (...argv: string[]) => `RUN ${JSON.stringify(argv)}`;
  return [
    "# Generated by mcpcage. The install stage installs the locked wheels with their hashes checked,",
    "# never building a package; the runtime stage gets the interpreter and the venv only.",
    `FROM ${UV_BASE} AS uv`,
    `FROM ${PYPI_INSTALL_BASE} AS install`,
    "COPY --from=uv /uv /usr/local/bin/uv",
    "ENV UV_NO_CONFIG=1 UV_NO_CACHE=1 UV_NO_BUILD=1 UV_NO_PROGRESS=1 UV_LINK_MODE=copy UV_PYTHON_INSTALL_DIR=/opt/python UV_PYTHON_PREFERENCE=only-managed UV_PYTHON_INSTALL_BIN=0 UV_PYTHON_INSTALL_REGISTRY=0",
    run("uv", "python", "install", python),
    run("uv", "venv", "--python", python, "/app/venv"),
    ...(build.wheels === true ? ["COPY wheels /app/wheels"] : []),
    "COPY requirements.lock /app/requirements.lock",
    "# The only uv command once the venv exists, on the empty venv.",
    run("uv", "pip", "sync", "--require-hashes", "--no-build", "--python", venvPython, "/app/requirements.lock"),
    "# Python with -I -S only: no site module, so no .pth file of a package runs.",
    run(venvPython, "-I", "-S", "-c", REMOVE_PIP),
    run(venvPython, "-I", "-S", "-c", COMPILE, `/app/venv/lib/python${minor}/site-packages`, "/opt/python"),
    run(venvPython, "-I", "-S", "-c", COMMAND_EXISTS, build.command),
    "",
    `FROM ${PYPI_RUNTIME_BASE}`,
    "COPY --from=install /opt/python /opt/python",
    "COPY --from=install /app/venv /app/venv",
    "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1",
    "WORKDIR /app",
    `USER ${NONROOT}`,
    `ENTRYPOINT ${JSON.stringify([`/app/venv/bin/${build.command}`])}`,
    "",
  ].join("\n");
}

/** The first lines of what a program printed on stderr, for an error message. */
function firstLines(text: string): string {
  return clip(terminalSafe(text.trim().split(/\r?\n/).slice(0, 4).join(" ").replace(/\s+/g, " ")) || "it printed nothing", 500);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
