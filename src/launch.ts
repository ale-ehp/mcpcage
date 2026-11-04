import { win32 } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";

/** What the MCP client asked to start, after `mcpcage run --`. */
export type LaunchSpec =
  | { kind: "npm"; packageName: string; versionRange?: string; localPath?: string; args: string[] }
  | { kind: "image"; image: string; args: string[] }
  | { kind: "host"; command: string; args: string[] };

// --silent and -s, like -q and --quiet, only set npm's log level: in the cage npm never runs, the
// image's launcher starts the package. @modelcontextprotocol/server-pdf's README configures
// `npx -y --silent ...`, which mcpcage refused ("unsupported npx flag --silent"), and wrap and
// protect --fix left such an entry uncaged.
const NPX_FLAGS_WITHOUT_VALUE = new Set(["-y", "--yes", "-q", "--quiet", "-s", "--silent", "--no-install=false"]);

/**
 * Understands `npx [-y] <package>[@version] [args...]`, the form most MCP servers are configured
 * with, and on Windows the same run by `cmd /c` (see cmdNpx). Anything else is a plain host command,
 * which only `--no-sandbox` accepts. `platform` is the system the command line was written for.
 */
export function parseLaunch(argv: string[], image?: string, platform: NodeJS.Platform = process.platform): LaunchSpec {
  if (image) return { kind: "image", image, args: argv };
  const [command] = argv;
  if (!command) throw new Error("missing the server command after `--`");
  const npx = npxArgv(argv, platform);
  if (npx === undefined) return { kind: "host", command, args: argv.slice(1) };
  const rest = npx.slice(1);

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
 * The npx command line a server's command line runs: itself when it starts npx, the part after `/c`
 * when it is a plain `cmd /c npx ...` on Windows (see cmdNpx); undefined for any other.
 */
export function npxArgv(argv: readonly unknown[], platform: NodeJS.Platform = process.platform): string[] | undefined {
  const [command] = argv;
  if (typeof command === "string" && isNpx(command, platform)) return argv as string[];
  const cmd = cmdNpx(argv, platform);
  return cmd !== undefined && "npx" in cmd ? cmd.npx : undefined;
}

/**
 * The npx command line that `cmd /c npx ...` runs on Windows, where many configurations start npx so,
 * because some clients cannot start npx.cmd themselves: `cmd` or `cmd.exe` in any case, bare or a
 * full path, then `/c` (any case), after `/d` or `/s` at most. Undefined for a command line that is
 * not one. Such entries were "cmd, not npx" in the report, and wrap and --fix left them on the host.
 * cmd reads what follows `/c` itself: `&`, `|`, `<`, `>`, `^`, `%`, `!`, quotes and parentheses can
 * start another command, redirect, or change what npx is given, and a control character can end the
 * line. Only a line with none of them runs npx with exactly the arguments the cage gives it; for any
 * other, `notPlain` says why (never quoting an argument, which may hold a credential), and it stays a
 * program mcpcage does not cage. An argument with a space is accepted after the first: the client
 * quotes it, cmd passes the quotes on, and npx reads them away. In the first, npx's path, the quotes
 * open the line, where cmd removes them by rules of its own.
 */
export function cmdNpx(argv: readonly unknown[], platform: NodeJS.Platform = process.platform): { npx: string[] } | { notPlain: string } | undefined {
  if (platform !== "win32") return undefined;
  const [command, ...args] = argv;
  if (typeof command !== "string" || !isCmd(command) || args.some((arg) => typeof arg !== "string")) return undefined;
  const words = args as string[];
  const first = words.findIndex((word) => !word.startsWith("/"));
  const switches = first === -1 ? words : words.slice(0, first);
  if (!/^\/c$/i.test(switches.at(-1) ?? "")) return undefined;
  const line = words.slice(switches.length);
  // The program cmd starts: the line up to the first character that ends a program's name for it.
  const program = /^[^\s"&|<>^%!(),;=]*/.exec(line.join(" "))![0];
  if (!isNpx(program, platform) && !isNpx(line[0] ?? "", platform)) return undefined;
  if (switches.slice(0, -1).some((option) => !/^\/[ds]$/i.test(option))) return { notPlain: "it gives cmd a switch other than /d and /s before /c" };
  for (const word of line) {
    if (word === "") return { notPlain: "an argument after /c is empty, which the client can give cmd only in quotes" };
    const read = CMD_READS.find(([characters]) => characters.test(word));
    if (read !== undefined) return { notPlain: `an argument after /c has ${read[1]}` };
  }
  if (line[0] !== program) {
    return { notPlain: isNpx(line[0]!, platform) ? "the path of npx has a space, so the client quotes it, and cmd removes quotes there by rules of its own" : "it gives npx and what follows in one argument, which cmd splits by rules of its own" };
  }
  return { npx: line };
}

/** What cmd reads itself in the line after `/c`, with what it does. */
const CMD_READS: ReadonlyArray<[RegExp, string]> = [
  [/[&|]/, "& or |, with which cmd starts another command"],
  [/[<>]/, "< or >, with which cmd redirects what npx reads or writes"],
  [/\^/, "^, which cmd removes as an escape"],
  [/%/, "%, between two of which cmd fills in a variable"],
  [/!/, "!, between two of which cmd fills in a variable when delayed expansion is on"],
  [/"/, "quotes, which cmd reads by rules of its own"],
  [/[()]/, "parentheses, which cmd can read as a block"],
  [/[\u0000-\u001f\u007f]/, "a control character, and a line break ends cmd's command"],
];

/** `cmd` or `cmd.exe`, in any case, bare or a full path: a relative one depends on the client's directory. */
function isCmd(command: string): boolean {
  if (/[/\\]/.test(command) && !win32.isAbsolute(command)) return false;
  return /^cmd(\.exe)?$/.test(win32.basename(command).toLowerCase());
}

/**
 * Whether a command names npx: `npx` or `npx.cmd`, bare or as a path. Windows compares file names
 * without case, and starts NPX, npx.CMD and C:\NODEJS\NPX.CMD as it starts npx: they were taken for
 * other programs there, which protect could not count as npx servers and mcpcage could not cage.
 */
export function isNpx(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return /(^|[/\\])npx(\.cmd)?$/.test(platform === "win32" ? command.toLowerCase() : command);
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
