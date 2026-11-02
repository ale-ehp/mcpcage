import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./canonical.js";
import type { LaunchSpec } from "./launch.js";
import { cageHome, serverDir } from "./paths.js";
import { readJson, writeJson } from "./pinstore.js";

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
  if (!existsSync(path)) throw new Error(`--mount: ${path} does not exist`);
  if (path.includes(",")) throw new Error(`--mount: paths containing commas are not supported (${path})`);
  return { source: path, target: path, readOnly };
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
