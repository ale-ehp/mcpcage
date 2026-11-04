import { canonicalJson, sha256 } from "./canonical.js";

/** What the MCP client asked to start, after `mcpcage run --`. */
export type LaunchSpec =
  | { kind: "npm"; packageName: string; versionRange?: string; localPath?: string; args: string[] }
  | { kind: "image"; image: string; args: string[] }
  | { kind: "host"; command: string; args: string[] };

const NPX_FLAGS_WITHOUT_VALUE = new Set(["-y", "--yes", "-q", "--quiet", "--no-install=false"]);

/**
 * Understands `npx [-y] <package>[@version] [args...]`, the form most MCP servers are configured
 * with. Anything else is a plain host command, which only `--no-sandbox` accepts. `platform` is the
 * system the command line was written for (see isLocalPath).
 */
export function parseLaunch(argv: string[], image?: string, platform: NodeJS.Platform = process.platform): LaunchSpec {
  if (image) return { kind: "image", image, args: argv };
  const [command, ...rest] = argv;
  if (!command) throw new Error("missing the server command after `--`");
  if (!/(^|[/\\])npx(\.cmd)?$/.test(command)) return { kind: "host", command, args: rest };

  let index = 0;
  while (index < rest.length && rest[index]!.startsWith("-")) {
    const flag = rest[index]!;
    if (flag === "-p" || flag === "--package" || flag.startsWith("--package=") || flag === "-c" || flag === "--call") {
      throw new Error(`npx ${flag} is not supported yet; use \`npx <package> [args]\``);
    }
    if (!NPX_FLAGS_WITHOUT_VALUE.has(flag)) throw new Error(`unsupported npx flag ${flag}`);
    index++;
  }
  const spec = rest[index];
  if (!spec) throw new Error("npx needs a package name");
  const args = rest.slice(index + 1);
  if (isLocalPath(spec, platform)) return { kind: "npm", packageName: "", localPath: spec, args };
  const { name, range } = splitPackageSpec(spec);
  return { kind: "npm", packageName: name, versionRange: range, args };
}

/**
 * Whether npx would take `spec` for a package on disk rather than a name in the registry. On Windows
 * a path is also written `.\x`, `..\x`, `C:\x` (or `C:/x`) and `\x`: taken for a name, the Docker
 * tests' C:\Users\me\mcpcage\test\fixtures\abuse-server went to npm in the cage as
 * `/app/C:\Users\me\mcpcage\test\fixtures\abuse-server@latest/package.json`, and the server never
 * started. On macOS and Linux nothing changes: a backslash is an ordinary character there.
 */
export function isLocalPath(spec: string, platform: NodeJS.Platform = process.platform): boolean {
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/") || spec.startsWith("~/") || spec.endsWith(".tgz")) return true;
  return platform === "win32" && (/^\.{1,2}\\/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith("\\"));
}

/** `@scope/name@1.2.3` -> name `@scope/name`, range `1.2.3`. */
export function splitPackageSpec(spec: string): { name: string; range?: string } {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  if (at === -1) return { name: spec };
  return { name: spec.slice(0, at), range: spec.slice(at + 1) || undefined };
}

/**
 * Stable id for a server: readable slug plus a short hash of what identifies it. The version is
 * left out on purpose, so upgrading a package keeps the same id and its new tool definitions are
 * checked against the old approved ones instead of being trusted as a new server.
 */
export function serverIdFor(spec: LaunchSpec): string {
  const identity =
    spec.kind === "npm"
      ? { kind: spec.kind, name: spec.packageName || spec.localPath, args: spec.args }
      : spec.kind === "image"
        ? { kind: spec.kind, image: imageRepository(spec.image), args: spec.args }
        : { kind: spec.kind, command: spec.command, args: spec.args };
  const label =
    spec.kind === "npm"
      ? spec.packageName || basename(spec.localPath ?? "local")
      : spec.kind === "image"
        ? imageRepository(spec.image)
        : basename(spec.command);
  return `${slug(label)}-${sha256(canonicalJson(identity)).slice(0, 8)}`;
}

/** `docker.io/mcp/time:latest@sha256:...` -> `docker.io/mcp/time`. */
export function imageRepository(image: string): string {
  const withoutDigest = image.split("@")[0]!;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\.tgz$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server"
  );
}
