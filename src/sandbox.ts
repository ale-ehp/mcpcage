import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./canonical.js";
import { hostEnvName } from "./config.js";
import type { LaunchSpec } from "./launch.js";
import { NETWORK_PATH, networkPath } from "./network-path.js";
import { cageHome, serverDir } from "./paths.js";
import { readJson, writeJson } from "./pinstore.js";
import { preparePypiImage, type PypiLock } from "./pypi.js";
import { sensitivePath, thisMachine } from "./sensitive.js";
import { streamSafely, terminalSafe } from "./terminal.js";
import { uvSettingsReason } from "./uv-settings.js";
import { WINDOWS_ENV, windowsPlaces } from "./windows-places.js";

/**
 * Base images, pinned by digest so a build today and a build next month start from the same bytes.
 * They live in runtime/bases.Dockerfile, where Dependabot can propose digest updates. The runtime
 * image is distroless and nonroot: no shell, no package manager, no npm for a compromised server to call.
 */
const BASES = readBases();
export const INSTALL_BASE = BASES.install;
export const RUNTIME_BASE = BASES.runtime;
/** The image a PyPI server is resolved in: uv, and a Python for it to query, never given a package. */
export const PYPI_RESOLVE_BASE = BASES["pypi-resolve"];
/** The image the uv binary of a PyPI server's install stage comes from: the resolve image's release. */
export const UV_BASE = BASES["pypi-uv"];
/** The install stage of a PyPI server: the runtime's own distroless base, as root. */
export const PYPI_INSTALL_BASE = BASES["pypi-install"];
/** The runtime of a PyPI server: distroless with the C library and no shell, nonroot. */
export const PYPI_RUNTIME_BASE = BASES["pypi-runtime"];
export const NONROOT = "65532:65532";

export interface Mount {
  source: string;
  /** Where the server finds it, as this system spells paths: runArgs gives Docker its place in the cage (cagePath). */
  target: string;
  readOnly: boolean;
}

export interface SandboxOptions {
  serverId: string;
  spec: Extract<LaunchSpec, { kind: "npm" | "image" | "pypi" }>;
  mounts: Mount[];
  /** `NAME` (value taken from mcpcage's own environment) or `NAME=value`. */
  env: string[];
  allowNet: boolean;
  memory: string;
  cpus: string;
  keepImageUser: boolean;
  rebuild: boolean;
  log: (message: string) => void;
  /** For a PyPI server: the lock wrap or --fix just made for it (see checkPypi), built from instead of resolving again. */
  pypiLock?: PypiLock;
}

/** What `mcpcage` remembers about how a server is built, next to its pin. */
export interface ServerRecord {
  serverId: string;
  spec: SandboxOptions["spec"];
  image: string;
  imageId: string;
  packageName?: string;
  version?: string;
  integrity?: string;
  lockfileSha256?: string;
  /** A PyPI server's: the exact CPython installed (3.13.18). */
  python?: string;
  /** A PyPI server's: the platform its wheels are for (aarch64-manylinux_2_40). */
  platform?: string;
  /** A PyPI server's: the release of the uv that resolved and installed it. */
  uvVersion?: string;
  builtAt: string;
}

export interface Prepared {
  /** docker, where dockerProgram found it. */
  command: string;
  args: string[];
  /** The environment to run it with: dockerProgram's, and the variables the server is given by name (see prepareSandbox). */
  env: NodeJS.ProcessEnv;
  record: ServerRecord;
}

export function dockerAvailable(): { ok: boolean; version?: string; error?: string } {
  const program = dockerProgram();
  if (program === undefined) return { ok: false, error: DOCKER_NOT_FOUND };
  const result = spawnSync(program.file, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", env: program.env });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: result.stderr.trim() || "docker is not running" };
  return { ok: true, version: result.stdout.trim() };
}

/** Builds (or reuses) the server image and returns the hardened `docker run` command. */
export function prepareSandbox(options: SandboxOptions): Prepared {
  // uvx would install a PyPI server from the index the user's uv settings name, and the cage builds
  // from PyPI only: refused first, as protect and wrap leave such an entry (see uv-settings.ts), and
  // at every start, since the settings can change after the entry was caged.
  if (options.spec.kind === "pypi") {
    const reason = uvSettingsReason();
    if (reason !== undefined) throw new Error(reason);
  }
  const docker = dockerAvailable();
  if (!docker.ok) {
    // Fail closed: never fall back to running the server on the host.
    throw new Error(`Docker is required to cage a server (${docker.error}). Start Docker, or use --no-sandbox to run on the host with pinning and audit only.`);
  }
  const record = options.spec.kind === "npm" ? prepareNpmImage(options) : options.spec.kind === "pypi" ? preparePypiImage(options) : prepareImage(options);
  writeJson(join(serverDir(options.serverId), "server.json"), record);
  // The paths come from the user's arguments or the entry's.
  for (const line of placesInCage(options.mounts)) options.log(terminalSafe(`mcpcage: ${line}`));
  // docker takes the value of each `--env NAME` from its own environment (see runArgs), so `docker
  // run`, and only it, is given those variables too. It starts a local image by its ID and pulls
  // nothing (--pull never), so no credential helper runs with them; the docker commands that build
  // or pull never have them (see trustedEnv).
  const program = foundDocker(options.env.filter((variable) => !variable.includes("=")));
  return { command: program.file, args: runArgs(options, record.imageId), env: program.env, record };
}

export function runArgs(
  options: Pick<SandboxOptions, "serverId" | "spec" | "mounts" | "env" | "allowNet" | "memory" | "cpus" | "keepImageUser">,
  image: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args = [
    "run", "--rm", "-i", "--init",
    // The image is the one mcpcage built or pulled, by its ID. Nothing is pulled at run time, when
    // docker has the server's variables in its environment, which a credential helper asked for a pull
    // would get too.
    "--pull", "never",
    "--name", `mcpcage-${options.serverId}-${randomBytes(3).toString("hex")}`,
    "--label", `mcpcage.server=${options.serverId}`,
    "--network", options.allowNet ? "bridge" : "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", options.memory,
    // The same value as --memory leaves the container no swap: without it Docker allows as much swap
    // again on a host that has some, and the limit silently doubles.
    "--memory-swap", options.memory,
    "--cpus", options.cpus,
    "--ipc", "none",
    "--hostname", "mcpcage",
    "-e", "HOME=/tmp",
  ];
  if (!options.keepImageUser) args.push("--user", NONROOT);
  for (const variable of options.env) {
    // docker takes the value of `-e NAME` from its own environment, which holds mcpcage's value of
    // each variable named so (see prepareSandbox), except the PATH, and on Windows Windows' places,
    // which are not mcpcage's (see trustedEnv): the server is given mcpcage's value of those here, as
    // it is of the others there, or keeps the image's own when mcpcage has none.
    if (process.platform === "win32" ? [...WINDOWS_ENV, "PATH"].some((name) => name.toUpperCase() === variable.toUpperCase()) : variable === "PATH") {
      const value = /^path$/i.test(variable) ? process.env.PATH : process.env[variable];
      if (value !== undefined) args.push("-e", `${variable}=${value}`);
      continue;
    }
    args.push("-e", variable);
  }
  for (const mount of options.mounts) {
    args.push("--mount", `type=bind,source=${mount.source},target=${cagePath(mount.target, platform)}${mount.readOnly ? ",readonly" : ""}`);
  }
  args.push(image, ...cageArgs(options.spec.args, options.mounts, platform));
  return args;
}

/**
 * The server's arguments as the server is given them in the cage. On Windows each argument that names
 * a mounted path, or a path inside one, becomes its place there (cagePath): in the container
 * C:\Users\me\notes names nothing, and server-filesystem, given it, stopped at start. Only whole
 * arguments, absolute or starting with `~/`, as hostPath (config.ts) reads the paths `wrap` mounts;
 * compared as Windows compares paths, without case and with either separator, each folder on the way
 * also as the system spells it on disk, as hostMount spells the mounts: C:\Users\RUNNER~1\x is in a
 * mount of C:\Users\runneradmin\x. The names below the mount stay as written. Every other argument
 * stays as it is, and so does every argument on macOS and Linux, where the cage has the host's paths.
 * Paths in tool calls are not translated: the model uses the ones the server lists.
 */
function cageArgs(args: string[], mounts: Mount[], platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || mounts.length === 0) return args;
  const mounted = new Map<string, Mount>();
  for (const mount of mounts) {
    const key = win32.resolve(mount.source).toLowerCase();
    if (!mounted.has(key)) mounted.set(key, mount);
  }
  // A Windows path can be looked up on Windows only.
  const onDisk = (path: string) => {
    if (process.platform !== "win32") return undefined;
    try {
      return realpathSync.native(path);
    } catch {
      return undefined;
    }
  };
  return args.map((arg) => {
    const written = arg.startsWith("~/") ? win32.join(homedir(), arg.slice(2)) : arg;
    // \\server\share and the like are on no drive, so in no mount, and never looked at (see networkPath).
    if (!win32.isAbsolute(written) || networkPath(written, "win32")) return arg;
    const below: string[] = [];
    for (let dir = win32.resolve(written); ; dir = win32.dirname(dir)) {
      const mount = mounted.get(dir.toLowerCase()) ?? mounted.get(onDisk(dir)?.toLowerCase() ?? "");
      if (mount !== undefined) return [cagePath(mount.target, platform), ...below].join("/");
      if (win32.dirname(dir) === dir) return arg;
      below.unshift(win32.basename(dir));
    }
  });
}

/** `--mount ~/notes` mounts read-only at the same path; `--mount ~/out:rw` makes it writable. */
export function parseMount(value: string): Mount {
  const { path, readOnly } = mountPath(value);
  try {
    return hostMount(path, readOnly);
  } catch (error) {
    throw new Error(`--mount: ${(error as Error).message}`);
  }
}

/**
 * The mount of `written`, an absolute path of this machine, at its place in the cage (see cagePath).
 * The path is resolved first, on every system: `.` and `..` taken out as written, as Docker takes
 * them out of a bind mount's source and target before it mounts. The system reads a `..` from where
 * a symlink before it leads instead: for `/x/link/../proj` Docker mounted /x/proj, while existsSync
 * and the settings walk (withSettingsReadOnly) read the proj next to where link points, so a
 * writable mount of a repository named so got no read-only .git, and a server in the cage wrote its
 * .git/config on the host. On Windows node hands every path to the system resolved already.
 * On Windows the path is then taken as the system spells it on disk (realpathSync.native: each name
 * in its case, long names for 8.3 short ones, C:\PROGRA~1 as C:\Program Files), because the
 * container compares paths with case: a read-only mount spelled one way did not cover the same
 * directory inside a writable mount spelled another way, and withSettingsReadOnly, which tells
 * what holds what by the paths, would have counted it as covered.
 */
export function hostMount(written: string, readOnly: boolean): Mount {
  // A path off any drive is refused as written: resolved, \\ alone (or //, \\.) became C:\, and the
  // whole drive was mounted.
  const path = offDrive(written) ? written : resolve(written);
  // Checked before the disk is asked: a network path makes existsSync wait on the network, and hands
  // its server the user's credentials (see networkPath); on macOS /net/<host> mounts that host.
  if (process.platform === "win32") cagePath(path);
  if (networkPath(path)) throw new Error(NETWORK_PATH);
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const source = process.platform === "win32" ? realpathSync.native(path) : path;
  // A folder on a mapped network drive is spelled on disk as the share it is on.
  if (process.platform === "win32") cagePath(source);
  if (source.includes(",")) throw new Error(`paths containing commas are not supported (${source})`);
  return { source, target: source, readOnly };
}

/**
 * Whether a path is, on Windows, off any drive: a share (`\\server\share`) or a device path
 * (`\\?\...`, `\\.\...`). It has no place in the cage (cagePath), so nothing mounts it: `run`
 * refuses it, `wrap` and `--fix` leave a server given one uncaged (wrap wrote
 * `--mount \\localhost\C$\Users\me\share` for a server given that share, which `run` refused at
 * every start), and an inspection goes without it. Elsewhere `//x` is an ordinary path.
 */
export function offDrive(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /^[\\/]{2}/.test(path);
}

/** Why a path off any drive (see offDrive) is not mounted. */
export const NOT_ON_A_DRIVE = "is not a path on a drive, and only those have a place in the cage on Windows";

/**
 * Where the server finds the path `path` of this machine (absolute) in the cage. On macOS and Linux
 * at the same path. On Windows the cage is a Linux container: Docker refused
 * `target=C:\Users\me\notes`, and a server given `C:\Users\me\notes` there looks for a file of
 * that name in its working directory. So a Windows path has one place there: the drive letter in
 * lowercase as the first name, then its names with `/`, in their case, since the container compares
 * paths with case (see hostMount): C:\Users\me\notes is /c/Users/me/notes. A path that is not on a
 * drive (\\server\share, \\?\..., \\.\...) has no place there.
 */
export function cagePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const normal = win32.normalize(path);
  const drive = offDrive(normal, platform) ? null : /^([A-Za-z]):\\/.exec(normal);
  if (drive === null) {
    throw new Error(`${path} ${NOT_ON_A_DRIVE}: mount a folder such as C:\\Users\\me\\notes, not a network share or a device path (\\\\server\\share, \\\\?\\..., \\\\.\\...)`);
  }
  return `/${drive[1]!.toLowerCase()}${normal.slice(2).split("\\").filter(Boolean).map((name) => `/${name}`).join("")}`;
}

/**
 * Where each folder given to the server is in the cage, on Windows, where that is another path than
 * this machine's (cagePath): the server lists its folders by that path, and the model has to name them
 * so in its tool calls, which mcpcage does not translate. One line per folder; the read-only mounts
 * withSettingsReadOnly adds inside one are not folders the user gave. None on macOS and Linux.
 */
export function placesInCage(mounts: Mount[], platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [];
  const places = mounts.map((mount) => cagePath(mount.target, platform));
  const said = new Set<string>();
  return mounts.flatMap((mount, index) => {
    const place = places[index]!;
    if (said.has(place) || places.some((other) => place.startsWith(other.endsWith("/") ? other : `${other}/`))) return [];
    said.add(place);
    return [`${mount.source} is ${place} in the cage, the path the server lists and tool calls must use`];
  });
}

/*
 * What stays read-only inside a writable mount, wherever it is found there. Each entry is read by a
 * program on the host when the user opens the project, and can name a program for it to run: a
 * server that could change one could get its own command run outside the cage, without the user
 * doing anything. Names are compared in lowercase, because on macOS and Windows `.GIT` is `.git`.
 */
const HOST_SETTINGS: ReadonlySet<string> = new Set([
  // git runs the commands its repository configuration names (core.fsmonitor, core.hooksPath, hooks,
  // filters, diff drivers), and editors run `git status` in the background as soon as a folder is
  // open. In a worktree or a submodule, .git is a file that says where the repository is.
  ".git",
  // VS Code, and the editors built on it: tasks that can run when the folder opens, settings that
  // name programs, and the project's MCP servers in .vscode/mcp.json.
  ".vscode",
  // JetBrains IDEs: run configurations, and the tasks they can start when the project opens.
  ".idea",
  // Cursor: the project's MCP servers in .cursor/mcp.json, and the rules its agent follows.
  ".cursor",
  // Claude Code: project settings, whose hooks run shell commands and which can enable MCP servers.
  ".claude",
  // Devin: the project's MCP servers in .devin/mcp_config.json.
  ".devin",
  // Windsurf: the rules and workflows its agent follows in the project.
  ".windsurf",
  // Claude Code: the project's MCP servers, started when the project opens.
  ".mcp.json",
]);

/** Why a read-only mount inside a writable one is refused on Windows (see withSettingsReadOnly). */
const ON_WINDOWS = "on Windows, Docker Desktop lets a server in a writable folder reach a read-only one inside it under another case of its name";

/** How far the search for those settings goes in one writable mount, and how many mounts it may add in all. */
export const SETTINGS_LIMITS = { entries: 100_000, mounts: 1_000 };

/**
 * The mounts a server gets: those given, then each existing entry named like a host setting above,
 * found at any depth inside a writable directory, mounted read-only on top at the same path. Run
 * at every start, so it sees the directory as it is then; a server can still create such an entry
 * where none existed. The walk is breadth-first, never follows a symlink, and does not go into
 * node_modules or into the settings themselves. A writable mount the user gave for a setting itself
 * is an explicit choice: it gets nothing on top of it or inside it. Anything that would leave a
 * setting writable, or take too long to find them all, refuses the start instead.
 *
 * node_modules is left out on purpose. A setting there would have to exist before the server starts,
 * and a package runner never puts one there: npm strips `.git` from a published tarball, and git
 * refuses to track any path with a `.git` component, so neither `npm install` nor `git clone` drops
 * a repository into it. The server can already make a new `.git` anywhere in a writable mount
 * (a documented residual), so keeping a pre-existing one under node_modules read-only would add
 * nothing. git on the host uses the nearest `.git` above the directory a command runs in, never one
 * under node_modules; and VS Code's `git.autoRepositoryDetection`, on by default, scans to
 * `git.repositoryScanMaxDepth` 1 and skips `git.repositoryScanIgnoredFolders`, whose default is
 * `["node_modules"]` (checked in VS Code's extensions/git/package.json). Descending would be costly:
 * a real project's node_modules measured here held 62,829 entries against 582 in the rest of it, and
 * the walk, which runs at every start, went from 2 ms to about 100 ms; a larger one would pass the
 * 100,000-entry limit and refuse an ordinary project's writable mount outright.
 *
 * A read-only mount moves with its directory: a server that renamed `app` to `app.old` would take
 * `app/.git` along, read-only, and make a new `app/.git` of its own, which git on the host then runs.
 * So each directory on the way from the writable mount down to a setting is mounted too, onto itself
 * and writable: ordinary writes inside it go on as before, but a mount point cannot be renamed or
 * removed (EBUSY). Those mounts count toward the limit. The list comes in order of depth, each
 * directory before what is mounted inside it, so no mount hides one made before it.
 *
 * A `.git` file (a worktree, a submodule, `git init --separate-git-dir`) only says where the
 * repository is, under any name, and git on the host runs what that repository's configuration
 * names. So the repository it points at, and the one a worktree shares (its `commondir`), are kept
 * read-only too when a writable mount holds them, their directories in place as above. A pointer
 * mcpcage cannot read, or one that leads through a symlink the server could change, or to a place
 * the server could fill, refuses the start.
 *
 * macOS and Windows compare names without case (`platform`, this system's by default). A read-only
 * mount covers the one name it is placed on, and the server writes through the writable mount under
 * any other spelling of it: `.GIT` reached the host's `.git` file, `.MCP.JSON` its `.mcp.json`. On
 * macOS a directory is a mount point under every spelling, but a file setting cannot be kept
 * read-only there, so a writable mount that holds one refuses the start. Paths are compared as the
 * system spells them on disk, and without case: a mount spelled `P10` reaches the repository `p10/meta`.
 *
 * On Windows no read-only mount inside a writable one holds, a directory's neither: with Docker
 * Desktop a server wrote /c/.../.GIT/config through the writable mount around a read-only .git, and
 * the host's .git\config changed; it wrote SUB/x.txt next to a read-only `sub` the user mounted
 * inside a writable folder. So there a writable mount that holds any setting, and a read-only mount
 * the user gives inside a writable one, refuse the start, and nothing is ever added inside a
 * writable mount. A writable mount inside a read-only one is fine: whatever the server reaches
 * through the read-only one, under any spelling, is read-only (SUB/y.txt there answered EROFS).
 */
export function withSettingsReadOnly(mounts: Mount[], limits = SETTINGS_LIMITS, platform: NodeJS.Platform = process.platform): Mount[] {
  const isSetting = (name: string) => HOST_SETTINGS.has(name.toLowerCase());
  const foldsCase = platform === "darwin" || platform === "win32";
  const windows = platform === "win32";
  const refuse = (mount: Mount, problem: string, remedy = "Mount a narrower directory") =>
    new Error(`--mount ${mount.source}:rw: ${problem}. ${remedy}, or mount ${mount.source} read-only by dropping :rw.`);
  /** `name` under another case, as the server could write it. */
  const otherCase = (name: string) => (name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase());
  if (windows) {
    for (const inner of mounts) {
      if (!inner.readOnly) continue;
      const outer = mounts.find((mount) => !mount.readOnly && within(inner.target, mount.target, true) && inner.target.toLowerCase() !== mount.target.toLowerCase());
      if (outer === undefined) continue;
      const names = inner.source.split(sep).slice(outer.source.split(sep).length);
      throw refuse(outer, `${inner.source}, mounted read-only, would not stay read-only inside it: ${ON_WINDOWS}, here ${join(outer.source, otherCase(names[0]!), ...names.slice(1))}`, `Mount a narrower folder that does not hold ${inner.source}`);
    }
  }
  // Every mount by where it is in the container, compared resolved: docker refuses two mounts at one
  // place, however it is spelled.
  const placed = new Map<string, Mount>();
  for (const mount of mounts) if (!placed.has(resolve(mount.target))) placed.set(resolve(mount.target), mount);
  /** The mount that decides what the server may do at `target`: the deepest one there or above it. */
  const holder = (target: string): Mount | undefined => {
    for (let dir = target; ; dir = dirname(dir)) {
      const mount = placed.get(dir);
      if (mount || dirname(dir) === dir) return mount;
    }
  };
  const added: Mount[] = [];
  const add = (from: Mount, mount: Mount) => {
    // Unreached on Windows, where a writable mount that holds a setting refuses first: kept so that no
    // later rule can put a mount there that the server would reach past.
    if (windows) throw refuse(from, `${mount.source} cannot be kept ${mount.readOnly ? "read-only" : "in place"}: ${ON_WINDOWS}`, "Mount a narrower folder that holds no git or editor settings");
    placed.set(mount.target, mount);
    added.push(mount);
    if (added.length > limits.mounts) {
      throw refuse(from, `more than ${limits.mounts.toLocaleString("en-US")} mounts to keep git's and the editors' settings (${[...HOST_SETTINGS].join(", ")}) read-only and the directories that hold them in place`);
    }
  };
  /** For each setting kept read-only: the writable mount it is in, and the directories between them. */
  const kept: Array<{ mount: Mount; root: string; between: string }> = [];
  /** Each .git file found, with the writable mount it was found in. */
  const gitFiles = new Map<string, Mount>();

  for (const mount of mounts) {
    if (mount.readOnly || isSetting(basename(mount.source)) || !statSync(mount.source).isDirectory()) continue;
    let visited = 0;
    const queue = [mount.source];
    for (let next = 0; next < queue.length; next++) {
      const dir = queue[next]!;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        // A directory mcpcage cannot read may still hold a setting the server can reach by its name.
        throw refuse(mount, `cannot look inside ${dir} for git's and the editors' settings (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
      }
      for (const entry of entries) {
        if (++visited > limits.entries) {
          throw refuse(mount, `more than ${limits.entries.toLocaleString("en-US")} entries to look through for git's and the editors' settings, which mcpcage keeps read-only in a writable mount`);
        }
        const path = join(dir, entry.name);
        if (!isSetting(entry.name)) {
          if (entry.isDirectory() && entry.name !== "node_modules") queue.push(path);
          continue;
        }
        if (entry.isSymbolicLink()) {
          throw refuse(mount, `${path} is a symlink, and mcpcage keeps git's and the editors' settings read-only in a writable mount: a read-only mount would follow the link to wherever it points`, "Replace the link with what it points to");
        }
        // docker's --mount takes comma-separated fields, and the server names the directories of its
        // writable mount: in `<dir>/x,source=/home/me/.ssh,target=/k/.git` it would write fields of its own.
        if (path.includes(",")) throw refuse(mount, `${path} cannot be kept read-only, because paths containing commas are not supported`, "Rename it");
        const target = resolve(mount.target, relative(mount.source, path));
        if (windows) {
          throw refuse(mount, `${path} cannot be kept read-only: ${ON_WINDOWS}, here ${join(dir, otherCase(entry.name))}`, "Mount a narrower folder that holds no git or editor settings");
        }
        // Where the server can write next to it (on macOS a read-only mount the user gave covers every spelling).
        if (foldsCase && !entry.isDirectory() && holder(dirname(target))?.readOnly === false) {
          throw refuse(mount, `${path} is ${entry.isFile() ? "a file" : "not a directory"}, and on macOS the server could change it as ${join(dir, otherCase(entry.name))}, the same file under another case of its name, which a read-only mount does not cover`);
        }
        if (entry.name.toLowerCase() === ".git" && entry.isFile()) gitFiles.set(path, mount);
        if (placed.has(target)) continue;
        add(mount, { source: path, target, readOnly: true });
        kept.push({ mount, root: mount.source, between: relative(mount.source, dir) });
      }
    }
  }

  if (gitFiles.size > 0) {
    // Where each writable mount really is, to tell whether a repository found by its path lies inside.
    // As the system spells them on disk: realpathSync keeps the case a path was written in.
    const writables = mounts.filter((mount) => !mount.readOnly).map((mount) => ({ mount, real: realpathSync.native(mount.source) }));
    const inContainer = (real: string) =>
      writables.filter(({ real: root }) => within(real, root, foldsCase)).map(({ mount, real: root }) => ({ mount, inside: below(real, root), target: resolve(mount.target, below(real, root)) }));
    /** Whether the server could change what is at `real`: a writable mount reaches it, and nothing read-only is on top. */
    const changeable = (real: string) => inContainer(real).some(({ target }) => holder(target)?.readOnly === false);
    /** Keeps the repository `named` read-only wherever a writable mount reaches it, and says where it really is. */
    const keepRepository = (from: Mount, file: string, named: string, base: string): string | undefined => {
      const why = "mcpcage keeps the repository a .git file leads to read-only in a writable mount";
      let found: { real: string; exists: boolean };
      try {
        found = locate(base, named, (link) => {
          if (changeable(link)) {
            throw refuse(from, `${file} names ${named}, reached through the symlink ${link}, which the server could point elsewhere, and ${why}`, "Replace the link with what it points to");
          }
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code) throw error;
        throw refuse(from, `cannot follow ${file} to the repository it names (${code === NETWORK_CODE ? `it leads to ${NETWORK_PATH}` : code})`, "Fix or remove it");
      }
      if (!found.exists) {
        if (changeable(found.real)) {
          throw refuse(from, `${file} names ${named}, which does not exist: the server could make it a repository of its own there, and ${why}`, `Point ${file} at its repository, or remove it`);
        }
        return undefined;
      }
      for (const { mount, inside, target } of inContainer(found.real)) {
        const above = holder(target);
        // Already read-only, or writable by the user's own choice of a mount for a setting itself.
        if (above?.readOnly || (above && mounts.includes(above) && isSetting(basename(above.source)))) continue;
        if (placed.has(target)) {
          throw new Error(`--mount ${above!.source}:rw: ${above!.source} is the git repository that ${file} names, and ${why}. Mount it read-only by dropping :rw.`);
        }
        // Spelled from the mount, as the other mounts are: docker finds the same directory.
        const source = join(mount.source, inside);
        if (source.includes(",") || target.includes(",")) {
          throw refuse(from, `${source}, the repository ${file} leads to, cannot be kept read-only, because paths containing commas are not supported`, "Rename it");
        }
        add(mount, { source, target, readOnly: true });
        kept.push({ mount, root: mount.source, between: dirname(inside).replace(/^\.$/, "") });
      }
      return found.real;
    };
    for (const [file, from] of gitFiles) {
      let base: string;
      try {
        base = realpathSync.native(dirname(file));
      } catch (error) {
        throw refuse(from, `cannot follow ${file} to the repository it names (${(error as NodeJS.ErrnoException).code})`, "Fix or remove it");
      }
      const named = pointer(file, "gitdir: ", (problem) => refuse(from, problem, "Fix or remove it"));
      const repository = keepRepository(from, file, named, base);
      if (repository === undefined) continue;
      // A worktree's repository names the one it shares, relative to itself, in a file of its own.
      const commondir = join(repository, "commondir");
      let stat;
      try {
        stat = lstatSync(commondir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw refuse(from, `cannot read ${commondir}, which names the repository ${file} shares (${code})`, "Fix or remove it");
      }
      // git writes a file there; through a link, what it names could be changed wherever the link leads.
      if (!stat.isFile()) throw refuse(from, `${commondir}, which names the repository ${file} shares, is not a file`, "Replace it with the file git writes");
      keepRepository(from, commondir, pointer(commondir, "", (problem) => refuse(from, problem, "Fix or remove it")), repository);
    }
  }

  // The directories on the way to each setting, from the top: each becomes a mount point of its own.
  for (const { mount, root, between } of kept) {
    let path = "";
    for (const name of between === "" ? [] : between.split(sep)) {
      path = join(path, name);
      const target = resolve(mount.target, path);
      // Already a mount point; or inside a read-only mount, where a rename fails anyway and a writable
      // mount would open what the user gave read-only.
      if (placed.has(target) || holder(target)?.readOnly) continue;
      add(mount, { source: join(root, path), target, readOnly: false });
    }
  }
  // Docker sorts its mounts the same way, and this list does not rely on it. The sort is stable.
  const depth = (mount: Mount) => resolve(mount.target).split(sep).filter(Boolean).length;
  return [...mounts, ...added].sort((left, right) => depth(left) - depth(right));
}

/**
 * Whether `path` is `dir` or lies inside it; both absolute and normalized. `foldCase` compares the
 * names without case, as macOS and Windows do.
 */
export function within(path: string, dir: string, foldCase = false): boolean {
  const [inner, outer] = foldCase ? [path.toLowerCase(), dir.toLowerCase()] : [path, dir];
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/**
 * The names of `path` below `dir`, which within() found it in, as `path` spells them. Counted, not
 * compared: `relative` compares with case, and from `/x/p10` it makes `/x/P10/meta` `../P10/meta`.
 */
function below(path: string, dir: string): string {
  return path.split(sep).filter(Boolean).slice(dir.split(sep).filter(Boolean).length).join(sep);
}

/** Longer than any path a .git file or a commondir file holds. */
const MAX_POINTER_BYTES = 64 * 1024;

/** The code of locate's error for a path it does not look at (see networkPath). */
const NETWORK_CODE = "ENETWORKPATH";

/**
 * The path a `.git` file (`gitdir: <path>`) or a `commondir` file (the path alone) names, read the
 * way git reads it: the prefix exactly, then everything up to the line endings at the end.
 * The file sits in a writable mount, where a server in another cage may be writing while mcpcage
 * reads: its size is looked at on what was opened, and no more than one byte past MAX_POINTER_BYTES
 * is read whatever that size said, so a file that grows or is replaced after the look is not read
 * whole. Opened without waiting where the system allows it, as readConfigFile in clients.ts does: a
 * FIFO put in its place is then refused, as empty or unreadable, instead of stalling the start.
 */
function pointer(file: string, prefix: string, refuse: (problem: string) => Error): string {
  const tooLarge = () => refuse(`${file} is too large to say where a git repository is`);
  let text: string;
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      if (fstatSync(fd).size > MAX_POINTER_BYTES) throw tooLarge();
      const bytes = Buffer.alloc(MAX_POINTER_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length > MAX_POINTER_BYTES) throw tooLarge();
      text = bytes.toString("utf8", 0, length);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!(error as NodeJS.ErrnoException).code) throw error;
    throw refuse(`cannot read ${file}, which says where a git repository is (${(error as NodeJS.ErrnoException).code})`);
  }
  const named = text.startsWith(prefix) ? text.slice(prefix.length).replace(/[\r\n]+$/, "") : "";
  if (named === "" || /[\r\n\0]/.test(named)) {
    throw refuse(`${file} does not say where a git repository is in the form git writes (${prefix === "" ? "<path>" : `${prefix}<path>`})`);
  }
  return named;
}

/**
 * Where `path` leads from the directory `base` (a real path), as the system resolves it: each
 * symlink followed, each name as the system spells it on disk, and `..` taken from where a link
 * led, not from how the path is spelled.
 * `link` hears of every symlink on the way. The real path; or, when it does not exist, the deepest
 * place on the way that does. Errors other than a missing entry are thrown, ELOOP after 40 links.
 */
function locate(base: string, path: string, link: (at: string) => void): { real: string; exists: boolean } {
  // The names after the root, for an absolute path. On Windows the root of `C:/x` is `C:/`, and its
  // `C:` is no name to look for in it: taken for one, every absolute path, which is how git writes
  // a worktree's or a separate repository's on Windows, led to a `C:\C:` that does not exist.
  const names = (spelled: string) => (isAbsolute(spelled) ? spelled.slice(parse(spelled).root.length) : spelled).split(sep === "\\" ? /[\\/]/ : "/");
  // A .git file, a commondir file or a link in a writable mount can name a share: never looked at (see networkPath).
  const network = () => Object.assign(new Error(`${path} leads to ${NETWORK_PATH}`), { code: NETWORK_CODE });
  if (isAbsolute(path) && networkPath(path)) throw network();
  let current = isAbsolute(path) ? parse(path).root : base;
  const pending = names(path);
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    if (networkPath(next)) throw network();
    let stat;
    try {
      stat = lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { real: current, exists: false };
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      // As the system spells it on disk, as the writable mounts are compared: on Windows a name may
      // be the 8.3 short name of a long one (MYPROJ~1 for My Projects), which matches no other spelling.
      current = realpathSync.native(next);
      continue;
    }
    link(next);
    if (++links > 40) throw Object.assign(new Error(`too many symlinks on the way to ${path}`), { code: "ELOOP" });
    const to = readlinkSync(next);
    if (isAbsolute(to)) current = parse(to).root;
    pending.unshift(...names(to));
  }
  return { real: current, exists: true };
}

/**
 * The path a --mount value names and what it would open, when it is the whole disk, the home
 * directory or a directory with credentials (see sensitive.ts); undefined for an ordinary path.
 * `run` refuses such a value unless --allow-sensitive-mount is given. The account's own home counts
 * whatever HOME says: a client sets HOME for mcpcage from the server entry it starts.
 */
export function sensitiveMount(value: string): { path: string; reason: string } | undefined {
  const { path } = mountPath(value);
  const reason = sensitivePath(path, thisMachine());
  return reason === undefined ? undefined : { path, reason };
}

/** The absolute path of a --mount value (`~/` expanded, relative to the current directory otherwise) and its mode. */
function mountPath(value: string): { path: string; readOnly: boolean } {
  let path = value;
  let readOnly = true;
  if (path.endsWith(":rw")) {
    readOnly = false;
    path = path.slice(0, -3);
  } else if (path.endsWith(":ro")) {
    path = path.slice(0, -3);
  }
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  // On Windows \Users\me is absolute without a drive: resolved, it is on the current one. A path off
  // any drive stays as written, for hostMount to refuse (see offDrive).
  if (!offDrive(path) && (!isAbsolute(path) || process.platform === "win32")) path = resolve(path);
  return { path, readOnly };
}

function prepareNpmImage(options: SandboxOptions): ServerRecord {
  const spec = options.spec as Extract<LaunchSpec, { kind: "npm" }>;
  const dir = serverDir(options.serverId);
  const previous = readJson<ServerRecord>(join(dir, "server.json"));
  const lockfile = join(dir, "package-lock.json");
  const manifest = join(dir, "package.json");
  const specChanged = previous !== undefined && JSON.stringify(previous.spec) !== JSON.stringify(spec);
  const reusePinnedTree = !options.rebuild && !specChanged && existsSync(lockfile) && existsSync(manifest);
  const tag = `mcpcage/${options.serverId}:${reusePinnedTree ? sha256(readFileSync(lockfile, "utf8")).slice(0, 12) : "build"}`;

  if (reusePinnedTree && previous && imageId(previous.image) === previous.imageId) {
    return previous;
  }

  ensureDir(dir);
  const context = mkdtempSync(join(cageHome(), "build-"));
  try {
    copyFileSync(launcherPath(), join(context, "mcpcage-launcher.mjs"));
    let install: string;
    if (reusePinnedTree) {
      // Same dependency tree as approved before: npm ci refuses anything that differs from the lockfile.
      copyFileSync(manifest, join(context, "package.json"));
      copyFileSync(lockfile, join(context, "package-lock.json"));
      install = "npm ci --ignore-scripts --omit=dev";
    } else {
      writeFileSync(join(context, "package.json"), `${JSON.stringify({ name: "mcpcage-sandbox", private: true }, null, 2)}\n`);
      const target = spec.localPath ? packLocal(spec.localPath, context) : `${spec.packageName}@${spec.versionRange ?? "latest"}`;
      install = `npm install --ignore-scripts --omit=dev ${shellQuote(target)}`;
    }
    writeFileSync(join(context, "Dockerfile"), dockerfile(install));
    options.log(`mcpcage: building the sandbox image for ${options.serverId} (install scripts disabled)...`);
    // A fresh install never comes from Docker's build cache. The cache is keyed on the Dockerfile's
    // lines and the files copied, which are the same in every fresh build of a package, so the
    // install an earlier build of it left there came back for a new server and for --rebuild: a new
    // server-filesystem got 2.1.0 from a build made hours before, with 2.2.0 on npm. The builds from
    // a pinned lockfile keep the cache: npm ci installs the same tree whatever the cache holds.
    const cache = reusePinnedTree ? [] : ["--no-cache"];
    // --force-rm: the classic builder (Docker without buildx, Colima's) removes a step's container
    // only when the step succeeds, so each failed build left a stopped container and the images it
    // held, seen in the compatibility run. BuildKit leaves none and takes the flag as a no-op.
    docker(["build", ...cache, "--force-rm", "--label", `mcpcage.server=${options.serverId}`, "-t", tag, context], true);

    // Keep the exact dependency tree that was installed, so every later build is identical.
    const container = docker(["create", tag]).trim();
    try {
      docker(["cp", `${container}:/app/package-lock.json`, lockfile]);
      docker(["cp", `${container}:/app/package.json`, manifest]);
    } finally {
      docker(["rm", container]);
    }
  } finally {
    rmSync(context, { recursive: true, force: true });
  }

  const lock = JSON.parse(readFileSync(lockfile, "utf8")) as { packages?: Record<string, { version?: string; integrity?: string }> };
  const installed = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> };
  const packageName = Object.keys(installed.dependencies ?? {})[0];
  const entry = packageName ? lock.packages?.[`node_modules/${packageName}`] : undefined;
  const finalTag = `mcpcage/${options.serverId}:${sha256(readFileSync(lockfile, "utf8")).slice(0, 12)}`;
  if (finalTag !== tag) {
    docker(["tag", tag, finalTag]);
    docker(["rmi", tag]); // removes only the temporary tag; the image stays under finalTag
  }
  return {
    serverId: options.serverId,
    spec,
    image: finalTag,
    imageId: imageId(finalTag) ?? "",
    packageName,
    version: entry?.version,
    integrity: entry?.integrity,
    lockfileSha256: sha256(readFileSync(lockfile, "utf8")),
    builtAt: new Date().toISOString(),
  };
}

/** Already-containerized servers: resolve the tag to a digest once, then always run that digest. */
function prepareImage(options: SandboxOptions): ServerRecord {
  const spec = options.spec as Extract<LaunchSpec, { kind: "image" }>;
  const previous = readJson<ServerRecord>(join(serverDir(options.serverId), "server.json"));
  if (!options.rebuild && previous && previous.spec.kind === "image" && (previous.spec as { image: string }).image === spec.image && imageId(previous.image)) {
    return previous;
  }
  if (!imageId(spec.image) || options.rebuild) docker(["pull", spec.image], true);
  const digest = docker(["image", "inspect", "--format", "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}", spec.image]).trim();
  const image = digest || spec.image;
  return { serverId: options.serverId, spec, image, imageId: imageId(image) ?? "", builtAt: new Date().toISOString() };
}

export function dockerfile(install: string): string {
  return [
    "# Generated by mcpcage. Stage 1 installs the package with lifecycle scripts disabled;",
    "# stage 2 copies only the result into a distroless, nonroot runtime.",
    `FROM ${INSTALL_BASE} AS install`,
    "ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false",
    "WORKDIR /app",
    "COPY . .",
    `RUN ${install}`,
    "",
    `FROM ${RUNTIME_BASE}`,
    "WORKDIR /app",
    "COPY --from=install /app /app",
    `USER ${NONROOT}`,
    'ENTRYPOINT ["/nodejs/bin/node", "/app/mcpcage-launcher.mjs"]',
    "",
  ].join("\n");
}

function packLocal(path: string, context: string): string {
  const source = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
  if (!existsSync(source)) throw new Error(`local package ${source} does not exist`);
  if (statSync(source).isFile()) {
    copyFileSync(source, join(context, "package.tgz"));
    return "./package.tgz";
  }
  const npm = npmProgram();
  if (npm === undefined) throw new Error(`npm pack ${source} failed: npm not found next to ${process.execPath}`);
  const packed = spawnSync(npm.file, [...npm.args, "pack", source, "--pack-destination", context, "--json", "--ignore-scripts"], { encoding: "utf8", env: npm.env });
  if (packed.error) throw new Error(`npm pack ${source} failed: ${packed.error.message}`);
  if (packed.status !== 0) throw new Error(`npm pack ${source} failed: ${packed.stderr.trim()}`);
  const [result] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  if (!result) throw new Error(`npm pack ${source} produced nothing`);
  return `./${result.filename}`;
}

function imageId(reference: string): string | undefined {
  const program = foundDocker();
  const result = spawnSync(program.file, ["image", "inspect", "--format", "{{.Id}}", reference], { encoding: "utf8", env: program.env });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Runs docker; its output goes to stderr (stdout belongs to the MCP channel) when `stream` is set, a
 * line at a time and spelled out where a terminal would act on it (see streamSafely).
 */
function docker(args: string[], stream = false): string {
  const program = foundDocker();
  if (stream) {
    const { status } = streamSafely(program.file, args, program.env);
    if (status !== 0) throw new Error(`docker ${args[0]} failed`);
    return "";
  }
  const result = spawnSync(program.file, args, { encoding: "utf8", env: program.env, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr ?? "").trim()}`);
  return result.stdout ?? "";
}

/** A program mcpcage runs on the host: the file to start, the arguments before its own, and the environment to start it with. */
export interface HostProgram {
  /** An absolute path; on macOS and Linux the bare name when it is found nowhere (see foundNowhere). */
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/*
 * A client starts mcpcage with its own environment plus the server entry's `env`, PATH included, and
 * anyone who could write the configuration chose that PATH. mcpcage started the docker it found
 * first there, and docker runs its credential helpers (`docker build` runs docker-credential-<name>
 * list, `docker pull` runs get) from the PATH it is given: a `docker` or a `docker-credential-desktop`
 * put first in the entry's PATH ran on the host, outside any cage, as soon as mcpcage checked for
 * Docker or built an image; and npm, which mcpcage runs to pack a local package, finds its node with
 * `#!/usr/bin/env node`. So docker is looked for in the places where Homebrew, Docker Desktop, the
 * Linux distributions, OrbStack, Rancher Desktop and Nix install it, in this order, and in the PATH
 * only when none has it; npm likewise, next to the node running mcpcage first. Each runs with a PATH
 * of these places and the directory it was found in, so what it starts comes from there too. The
 * rest of its environment is not mcpcage's either: only the variables trustedEnv names. The places
 * are POSIX ones: on Windows docker.exe comes from the PATH, and runs with only its own directory as
 * its PATH, and with Windows' places from Windows (see windowsEnv).
 */
function trustedPlaces(): string[] {
  if (process.platform === "win32") return [];
  // The account's home from the user database: HOME is a variable, and a client sets it for mcpcage
  // from the entry too. An account the database does not know (some containers) gets the system's places only.
  let home: string | undefined;
  try {
    home = userInfo().homedir;
  } catch {
    home = undefined;
  }
  const own = (path: string) => (home !== undefined && isAbsolute(home) ? [join(home, path)] : []);
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    ...own(".docker/bin"),
    ...own(".orbstack/bin"),
    ...own(".rd/bin"),
    "/Applications/Docker.app/Contents/Resources/bin",
    "/run/current-system/sw/bin",
    ...own(".nix-profile/bin"),
  ];
}

/**
 * The docker mcpcage runs, and the environment it runs every docker command with (see trustedPlaces
 * and trustedEnv); `byName`, for `docker run` alone, the variables it gives the server by name.
 */
export function dockerProgram(byName: readonly string[] = []): HostProgram | undefined {
  const name = process.platform === "win32" ? "docker.exe" : "docker";
  const file = findProgram(name, trustedPlaces()) ?? findProgram(name, searchPath());
  return file === undefined ? foundNowhere(name, byName) : { file, args: [], env: trustedEnv([dirname(file)], byName) };
}

/** What dockerAvailable says on Windows when dockerProgram finds no docker.exe. */
const DOCKER_NOT_FOUND = "docker.exe not found in the PATH";

/** dockerProgram, after dockerAvailable has found it: gone since, Docker is as missing as it would have been then. */
function foundDocker(byName: readonly string[] = []): HostProgram {
  const program = dockerProgram(byName);
  if (program === undefined) throw new Error(DOCKER_NOT_FOUND);
  return program;
}

/** The npm mcpcage runs to pack a local package or look one up: the one next to the node running mcpcage, else as docker is found (see trustedPlaces). */
export function npmProgram(): HostProgram | undefined {
  const here = dirname(process.execPath);
  if (process.platform === "win32") {
    // npm.cmd starts only through a shell, which would read a package path as commands: the script
    // it runs starts with this node alone, from where Node's installer puts it.
    const script = join(here, "node_modules", "npm", "bin", "npm-cli.js");
    return existsSync(script) ? { file: process.execPath, args: [script], env: trustedEnv([here]) } : foundNowhere("npm");
  }
  const file = findProgram("npm", [here, ...trustedPlaces()]) ?? findProgram("npm", searchPath());
  // Its directory comes first in its PATH: `#!/usr/bin/env node` then finds the node installed with it.
  return file === undefined ? foundNowhere("npm") : { file, args: [], env: trustedEnv([dirname(file)]) };
}

/**
 * The npx `run --no-sandbox` starts on Windows: npm's npx-cli.js next to the node running mcpcage, run
 * by that node, as npmProgram runs npm-cli.js. Started by name, npx was not found ("spawn npx
 * ENOENT", exit 127): Node starts a bare name only as a .com or an .exe, and npm installs npx.cmd,
 * which starts only through cmd.exe, a shell that would read the server's arguments as commands.
 * Undefined when npm's script is not there. On macOS and Linux npx is started by name, as before.
 */
export function npxProgram(): { file: string; args: string[] } | undefined {
  const script = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return existsSync(script) ? { file: process.execPath, args: [script] } : undefined;
}

/*
 * A program found nowhere would be started by its bare name, and looked for again where the system
 * looks for one. On macOS and Linux that is the PATH it is given, of the trusted places only, all of
 * them absolute: execvp looks in the current directory only for an empty or relative entry, so the
 * start fails there (ENOENT), as it should. Windows looks in the current directory first, whatever
 * the PATH says, and a client starts mcpcage in the project's: a docker.exe or an npm.exe that a
 * cloned repository keeps at its root ran on the host. There the program counts as not installed,
 * and nothing is started.
 */
function foundNowhere(name: string, byName: readonly string[] = []): HostProgram | undefined {
  return process.platform === "win32" ? undefined : { file: name, args: [], env: trustedEnv([], byName) };
}

/*
 * What else of mcpcage's environment docker and npm are given, besides the variables HOST_ENV names
 * (see trustedEnv): a few that they, or what they start, read for ordinary work, and whose values
 * name no program, no library and no file of settings that could name one.
 */
const BASICS: readonly string[] = [
  // The account's name, for a program that takes it from the environment rather than from the system
  // (Python's getpass, in gcloud's credential helper). A name, never a path or a program.
  "USER",
  "LOGNAME",
  // The language and character set of what the credential helpers and npm read and print. A
  // locale's name, which the C library looks up among its locale data, never a program.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  // The temporary directory, on macOS one of the user's own: without it docker and npm write in the
  // shared /tmp. A directory they write in; nothing is looked for there to run.
  "TMPDIR",
  // The agent holding the user's keys, which ssh asks for an ssh:// DOCKER_HOST. A socket ssh
  // connects to, never a program.
  "SSH_AUTH_SOCK",
  // The proxy through which npm reaches the registry (`npm view`), and docker a tcp:// daemon, on a
  // network that has one; npm and Go read both spellings. A URL that traffic goes through.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
];

/**
 * The environment docker and npm run with: a PATH of `first` and the trusted places only, and on
 * Windows Windows' places as Windows has them (see windowsEnv), in place of those mcpcage was
 * given; each variable of mcpcage's that HOST_ENV names on this system (see hostEnvName); the
 * BASICS; and, for `docker run` alone, the variables in `byName`. Nothing else.
 *
 * mcpcage's environment is the client's plus the entry's `env`, and docker passes its own to every
 * program it starts: its credential helpers, any program and often a script, its plugins (buildx),
 * the ssh of an ssh:// DOCKER_HOST, and podman behind a `docker` that is its shim; npm passes its
 * own to git and to node. These read variables that choose the code they run, and nobody can list
 * them all: CLOUDSDK_PYTHON (gcloud's helper is a shell script that runs "$CLOUDSDK_PYTHON"),
 * PYTHONPATH and PYTHONWARNINGS (Python started with -S still imports through them),
 * AWS_CONFIG_FILE (a profile's credential_process, for the ECR helper), SSH_ASKPASS, BUILDX_CONFIG,
 * CONTAINERS_CONF and XDG_CONFIG_HOME (podman's containers.conf names programs), GIT_SSH_COMMAND
 * and GIT_CONFIG_*, SHELL (ssh runs a ProxyCommand with it), DBUS_SESSION_BUS_ADDRESS (an address
 * can be a program to start). An entry whose env set CLOUDSDK_PYTHON, given to a docker configured
 * for gcr.io through gcloud, as `gcloud auth configure-docker` leaves it, had its script run on the
 * host at `docker build` while protect called the entry caged: the classic builder asks every
 * credential helper at every build, BuildKit the one of each registry it pulls from. HOST_ENV lists
 * what reads mcpcage's own process, and cannot list these: so the environment is built from names
 * known to be safe instead of copied. A helper that needs one of the variables left out finds
 * none: the secretservice helper of Linux desktops looks for the session bus through
 * DBUS_SESSION_BUS_ADDRESS or XDG_RUNTIME_DIR.
 *
 * The variables HOST_ENV names are kept because they are the user's own here: an entry that sets
 * one is reported by `protect` as acting on the host, and not counted as caged. They are what makes
 * docker and npm work as the user has them: DOCKER_HOST, DOCKER_CONFIG, DOCKER_CONTEXT, HOME,
 * npm_config_*, NODE_EXTRA_CA_CERTS. `byName` holds those docker is to take a value of for the
 * server (see runArgs); the docker commands that build or pull are never given them.
 */
function trustedEnv(first: string[], byName: readonly string[] = []): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  // Windows compares names without case.
  const same = (left: string, right: string) => (windows ? left.toUpperCase() === right.toUpperCase() : left === right);
  const env = new Map<string, string>();
  const set = (name: string, value: string | undefined) => {
    // A `Path` left next to the new PATH could be the one used: one spelling of each on Windows.
    for (const key of [...env.keys()]) if (same(key, name)) env.delete(key);
    if (value !== undefined) env.set(name, value);
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (hostEnvName(name) || [...BASICS, ...byName].some((given) => same(given, name))) set(name, value);
  }
  set("PATH", [...new Set([...first, ...trustedPlaces()])].join(delimiter));
  if (windows) for (const [name, value] of Object.entries(windowsPlaces())) set(name, value);
  // Made at once: assigned one by one, a variable named __proto__ (`--env __proto__`) would set the
  // object's prototype instead, and docker would not have it.
  return Object.fromEntries(env);
}

/** The absolute directories of mcpcage's PATH: a relative one depends on the directory mcpcage was started in. */
function searchPath(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
}

/**
 * The first file named `name` in `dirs` that can be run, symlinks followed; undefined when none has
 * it. A network directory is never looked in (see networkPath): `run` gets its PATH from the client,
 * with the entry's own PATH in it.
 */
function findProgram(name: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    if (networkPath(dir)) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      if (process.platform !== "win32") accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here, or not a program: on to the next
    }
  }
  return undefined;
}

function launcherPath(): string {
  return runtimeFile("launcher.mjs");
}

function runtimeFile(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "runtime", name), join(here, "..", "..", "runtime", name)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`runtime/${name} is missing from the mcpcage installation`);
}

function readBases(): Record<"install" | "runtime" | "pypi-resolve" | "pypi-uv" | "pypi-install" | "pypi-runtime", string> {
  const text = readFileSync(runtimeFile("bases.Dockerfile"), "utf8");
  const from = (stage: string) => {
    const match = new RegExp(`^FROM\\s+(\\S+)\\s+AS\\s+${stage}\\s*$`, "im").exec(text);
    if (!match?.[1]) throw new Error(`runtime/bases.Dockerfile has no "AS ${stage}" stage`);
    if (!/@sha256:[0-9a-f]{64}$/.test(match[1])) throw new Error(`runtime/bases.Dockerfile: ${match[1]} is not pinned by digest`);
    return match[1];
  };
  return {
    install: from("install"),
    runtime: from("runtime"),
    "pypi-resolve": from("pypi-resolve"),
    "pypi-uv": from("pypi-uv"),
    "pypi-install": from("pypi-install"),
    "pypi-runtime": from("pypi-runtime"),
  };
}

function shellQuote(text: string): string {
  return /^[\w@./:^~=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
