import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./canonical.js";
import type { LaunchSpec } from "./launch.js";
import { cageHome, serverDir } from "./paths.js";
import { readJson, writeJson } from "./pinstore.js";
import { sensitivePath, thisMachine } from "./sensitive.js";

/**
 * Base images, pinned by digest so a build today and a build next month start from the same bytes.
 * They live in runtime/bases.Dockerfile, where Dependabot can propose digest updates. The runtime
 * image is distroless and nonroot: no shell, no package manager, no npm for a compromised server to call.
 */
const BASES = readBases();
export const INSTALL_BASE = BASES.install;
export const RUNTIME_BASE = BASES.runtime;
export const NONROOT = "65532:65532";

export interface Mount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface SandboxOptions {
  serverId: string;
  spec: Extract<LaunchSpec, { kind: "npm" | "image" }>;
  mounts: Mount[];
  /** `NAME` (value taken from mcpcage's own environment) or `NAME=value`. */
  env: string[];
  allowNet: boolean;
  memory: string;
  cpus: string;
  keepImageUser: boolean;
  rebuild: boolean;
  log: (message: string) => void;
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
  builtAt: string;
}

export interface Prepared {
  command: string;
  args: string[];
  record: ServerRecord;
}

export function dockerAvailable(): { ok: boolean; version?: string; error?: string } {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: result.stderr.trim() || "docker is not running" };
  return { ok: true, version: result.stdout.trim() };
}

/** Builds (or reuses) the server image and returns the hardened `docker run` command. */
export function prepareSandbox(options: SandboxOptions): Prepared {
  const docker = dockerAvailable();
  if (!docker.ok) {
    // Fail closed: never fall back to running the server on the host.
    throw new Error(`Docker is required to cage a server (${docker.error}). Start Docker, or use --no-sandbox to run on the host with pinning and audit only.`);
  }
  const record = options.spec.kind === "npm" ? prepareNpmImage(options) : prepareImage(options);
  writeJson(join(serverDir(options.serverId), "server.json"), record);
  return { command: "docker", args: runArgs(options, record.imageId), record };
}

export function runArgs(options: Pick<SandboxOptions, "serverId" | "spec" | "mounts" | "env" | "allowNet" | "memory" | "cpus" | "keepImageUser">, image: string): string[] {
  const args = [
    "run", "--rm", "-i", "--init",
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
  for (const variable of options.env) args.push("-e", variable);
  for (const mount of options.mounts) {
    args.push("--mount", `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`);
  }
  args.push(image, ...options.spec.args);
  return args;
}

/** `--mount ~/notes` mounts read-only at the same path; `--mount ~/out:rw` makes it writable. */
export function parseMount(value: string): Mount {
  const { path, readOnly } = mountPath(value);
  if (!existsSync(path)) throw new Error(`--mount: ${path} does not exist`);
  if (path.includes(",")) throw new Error(`--mount: paths containing commas are not supported (${path})`);
  return { source: path, target: path, readOnly };
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
 * A read-only mount moves with its directory: a server that renamed `app` to `app.old` would take
 * `app/.git` along, read-only, and make a new `app/.git` of its own, which git on the host then runs.
 * So each directory on the way from the writable mount down to a setting is mounted too, onto itself
 * and writable: ordinary writes inside it go on as before, but a mount point cannot be renamed or
 * removed (EBUSY). Those mounts count toward the limit. The list comes in order of depth, each
 * directory before what is mounted inside it, so no mount hides one made before it.
 */
export function withSettingsReadOnly(mounts: Mount[], limits = SETTINGS_LIMITS): Mount[] {
  const isSetting = (name: string) => HOST_SETTINGS.has(name.toLowerCase());
  const refuse = (mount: Mount, problem: string, remedy = "Mount a narrower directory") =>
    new Error(`--mount ${mount.source}:rw: ${problem}. ${remedy}, or mount ${mount.source} read-only by dropping :rw.`);
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
    placed.set(mount.target, mount);
    added.push(mount);
    if (added.length > limits.mounts) {
      throw refuse(from, `more than ${limits.mounts.toLocaleString("en-US")} mounts to keep git's and the editors' settings (${[...HOST_SETTINGS].join(", ")}) read-only and the directories that hold them in place`);
    }
  };
  /** For each setting kept read-only: the writable mount it is in, and the directories between them. */
  const kept: Array<{ mount: Mount; root: string; between: string }> = [];

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
        if (placed.has(target)) continue;
        add(mount, { source: path, target, readOnly: true });
        kept.push({ mount, root: mount.source, between: relative(mount.source, dir) });
      }
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
  if (!isAbsolute(path)) path = resolve(path);
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
    docker(["build", "--label", `mcpcage.server=${options.serverId}`, "-t", tag, context], true);

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
  const packed = spawnSync("npm", ["pack", source, "--pack-destination", context, "--json", "--ignore-scripts"], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`npm pack ${source} failed: ${packed.stderr.trim()}`);
  const [result] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  if (!result) throw new Error(`npm pack ${source} produced nothing`);
  return `./${result.filename}`;
}

function imageId(reference: string): string | undefined {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Runs docker; its output goes to stderr (stdout belongs to the MCP channel) when `stream` is set. */
function docker(args: string[], stream = false): string {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: stream ? ["ignore", 2, 2] : ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed${stream ? "" : `: ${(result.stderr ?? "").trim()}`}`);
  return result.stdout ?? "";
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

function readBases(): { install: string; runtime: string } {
  const text = readFileSync(runtimeFile("bases.Dockerfile"), "utf8");
  const from = (stage: string) => {
    const match = new RegExp(`^FROM\\s+(\\S+)\\s+AS\\s+${stage}\\s*$`, "im").exec(text);
    if (!match?.[1]) throw new Error(`runtime/bases.Dockerfile has no "AS ${stage}" stage`);
    if (!/@sha256:[0-9a-f]{64}$/.test(match[1])) throw new Error(`runtime/bases.Dockerfile: ${match[1]} is not pinned by digest`);
    return match[1];
  };
  return { install: from("install"), runtime: from("runtime") };
}

function shellQuote(text: string): string {
  return /^[\w@./:^~=+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
