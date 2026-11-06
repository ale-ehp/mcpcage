import { win32 } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import { isJsonObject } from "./jsonc.js";
import { NETWORK_PATH, networkPath } from "./network-path.js";

/** What the MCP client asked to start, after `mcpcage run --`. */
export type LaunchSpec =
  | { kind: "npm"; packageName: string; versionRange?: string; localPath?: string; args: string[] }
  | { kind: "image"; image: string; args: string[] }
  | {
      kind: "pypi";
      /** The PEP 503 normal form of the package's name: `awslabs-aws-api-mcp-server`. */
      project: string;
      /** The requirement as written after uvx or --from, `@v` made `==v`: `awslabs.aws-api-mcp-server==1.6.0`. */
      requirement: string;
      /** The program of the package's environment to start: the requirement's name, or the word after --from. */
      command: string;
      /** The --with requirements, in order. */
      with: string[];
      /** The CPython version --python asks for: 3.12 or 3.12.4. */
      python?: string;
      /** --prerelease, and --exclude-newer as uv reads it on the host: a date made the instant it stands for there (see excludeNewerInstant). */
      resolution: { prerelease?: string; excludeNewer?: string };
      args: string[];
    }
  | { kind: "host"; command: string; args: string[] };

export type PypiLaunch = Extract<LaunchSpec, { kind: "pypi" }>;

// --silent and -s, like -q and --quiet, only set npm's log level: in the cage npm never runs, the
// image's launcher starts the package. @modelcontextprotocol/server-pdf's README configures
// `npx -y --silent ...`, which mcpcage refused ("unsupported npx flag --silent"), and wrap and
// protect --fix left such an entry uncaged.
const NPX_FLAGS_WITHOUT_VALUE = new Set(["-y", "--yes", "-q", "--quiet", "-s", "--silent", "--no-install=false"]);

/**
 * Understands `npx [-y] <package>[@version] [args...]`, the form most MCP servers are configured
 * with, and on Windows the same run by `cmd /c` (see cmdRunner); and `uvx [flags] <requirement>
 * [args]` or `uv tool run ...`, the form of PyPI servers, `cmd /c uvx` included (see parseUvx).
 * Anything else is a plain host command, which only `--no-sandbox` accepts. `platform` is the system
 * the command line was written for, and `environment` the variables it starts with, which uvx reads
 * too (see fromUvEnvironment): none unless given.
 */
export function parseLaunch(argv: string[], image?: string, platform: NodeJS.Platform = process.platform, environment: UvEnvironment = []): LaunchSpec {
  if (image) return { kind: "image", image, args: argv };
  const [command] = argv;
  if (!command) throw new Error("missing the server command after `--`");
  const npx = npxArgv(argv, platform);
  if (npx === undefined) {
    const toolRun = toolRunArgs(argv, platform);
    if (toolRun !== undefined) return parseUvx(toolRun, platform, environment);
    // uv reads flags before `tool run` itself: `uv --directory x tool run` installs and starts the
    // tool from another working directory, which is not what `uvx` does.
    const [first, ...more] = argv.slice(1);
    if (isUv(command, platform) && first?.startsWith("-") && more.some((word, index) => word === "tool" && TOOL_RUN.has(more[index + 1]!))) {
      throw new Error(`uv ${flagName(first)} before tool run: flags there are uv's own (--directory changes its working directory), and only \`uv tool run [flags] <package>\` is read as uvx`);
    }
    return { kind: "host", command, args: argv.slice(1) };
  }
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
  if (isLocalPath(spec, platform)) {
    // `run` packs a local package with npm on the host, which would look at it there (see networkPath).
    if (networkPath(spec, platform)) throw new Error(`the package after npx is ${NETWORK_PATH}`);
    return { kind: "npm", packageName: "", localPath: spec, args };
  }
  const { name, range } = splitPackageSpec(spec);
  return { kind: "npm", packageName: name, versionRange: range, args };
}

/**
 * The words uv's `tool run` reads in a server's command line: what follows `uvx`, `uv tool run`,
 * `uv tool uvx`, or on Windows the `uvx` of a plain `cmd /c uvx ...`. Undefined for any other line,
 * `uv` with flags before `tool run` included (see parseLaunch).
 */
export function toolRunArgs(argv: readonly unknown[], platform: NodeJS.Platform = process.platform): string[] | undefined {
  const [command, ...args] = argv;
  if (typeof command !== "string") return undefined;
  if (isUvx(command, platform)) return args as string[];
  if (isUv(command, platform) && args[0] === "tool" && TOOL_RUN.has(args[1] as string)) return args.slice(2) as string[];
  // A plain `cmd /c uvx ...` on Windows: the uvx line cmd would start (see cmdRunner).
  const cmd = cmdRunner(argv, platform);
  return cmd !== undefined && cmd.runner === "uvx" && "line" in cmd ? cmd.line.slice(1) : undefined;
}

/**
 * The words after `uv tool` that start uvx: `run`, and `uvx`, the hidden name of the same command
 * that uvx itself calls (uv 0.13.7, crates/uv-cli: ToolCommand::Uvx, the arguments of `tool run`).
 * `uv tool uvx mcp-server-time` ran as `uvx mcp-server-time` did, and protect counted it as another
 * program, not running on the host.
 */
const TOOL_RUN: ReadonlySet<string> = new Set(["run", "uvx"]);

/**
 * Whether a command names uvx: `uvx` or `uvx.exe`, bare or as a path, in any case on Windows and
 * macOS, whose file systems compare names without case (see isNpx). uv's installer puts uvx.exe in
 * %USERPROFILE%\.local\bin, and READMEs give that full path for clients that start with a short PATH.
 */
export function isUvx(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return /(^|[/\\])uvx(\.exe)?$/.test(withoutCase(command, platform));
}

/** Whether a command line starts uv: uvx, or uv itself with any arguments. */
export function startsUv(argv: readonly unknown[], platform: NodeJS.Platform = process.platform): boolean {
  const [command] = argv;
  return toolRunArgs(argv, platform) !== undefined || (typeof command === "string" && isUv(command, platform));
}

/** Whether a command names uv itself: `uv` or `uv.exe`, as isUvx. */
function isUv(command: string, platform: NodeJS.Platform): boolean {
  return /(^|[/\\])uv(\.exe)?$/.test(withoutCase(command, platform));
}

/**
 * A command as `platform` finds its file: in lowercase on Windows, and on macOS, whose APFS compares
 * names without case unless formatted otherwise: a client started UVX and NPX there as it starts uvx
 * and npx (an UVX in ~/.local/bin was uv's uvx), which protect did not count as running on the host.
 */
function withoutCase(command: string, platform: NodeJS.Platform): string {
  return platform === "win32" || platform === "darwin" ? command.toLowerCase() : command;
}

// Why a uvx flag is refused, by what it would do: the cage builds the server from PyPI wheels, for
// its own platform, without reading anything on the host.
const OUTSIDE_PYPI = "builds or installs code from outside PyPI, and the cage installs PyPI wheels only";
const OTHER_INDEX = "installs from another index than PyPI, and the cage builds from PyPI only";
const HOST_FILE = "reads a file on your machine, which the cage does not read when it builds";
const FROM_SOURCE = "builds from source or for another platform, and the cage installs PyPI wheels for its own";
const INSECURE_HOST = "turns off certificate checks for a host, which only another index or a proxy needs";
const NOT_A_REQUIREMENT = "not a PyPI requirement: give a name, optional [extras] and versions (==, !=, <=, >=, <, >, ~=, ===)";
const PYTHON_RANGE = "the cage runs CPython 3.10 to 3.15: give a version such as 3.12 or 3.12.4";
const AT_VERSION = "after @, uvx takes only an exact version or latest, and reads anything else as a path or URL (for a range, write pkg>=1.2)";
const PLAIN_COMMAND = "the command after its package must be a plain file name (no / or \\, no leading -, no control characters, not . or ..)";
const INTERPRETER = "uvx reads it as a Python interpreter to start (python, python3.13, python@3.12, cpython, pypy, graalpy, pyodide), not as a PyPI package, and the cage starts PyPI packages only";

/** What a flag of `uv tool run` does in the cage: read into the spec, ignored, or refused with the reason. */
type UvxFlag = { value: boolean; read?: "from" | "with" | "python" | "prerelease" | "exclude-newer" | "color" | "link-mode" } | { refused: string };

/**
 * The flags of `uv tool run` (uv 0.13.7, `uv tool run --help`) that the cage reads, those it can
 * ignore because they only tune uv's cache, output or interpreter lookup on the host, and those it
 * refuses. Any flag not here is refused as unsupported: uvx's meaning for it is not reproduced.
 */
const UVX_FLAGS = new Map<string, UvxFlag>([
  ["--from", { value: true, read: "from" }],
  ["--with", { value: true, read: "with" }],
  ["--python", { value: true, read: "python" }],
  ["--prerelease", { value: true, read: "prerelease" }],
  ["--exclude-newer", { value: true, read: "exclude-newer" }],
  ["--color", { value: true, read: "color" }],
  ["--refresh-package", { value: true }],
  ["--cache-dir", { value: true }],
  // How uv installs into its cache on the host, and whether it compiles bytecode there, which runs
  // the environment's Python with its .pth files: the cage's build does neither (it compiles with
  // python -I -S itself), and reads no .env file. Each run with uv 0.13.7.
  ["--reinstall-package", { value: true }],
  ["--link-mode", { value: true, read: "link-mode" }],
  ...["--no-build", "--no-config", "--isolated", "--refresh", "--no-cache", "--offline", "--managed-python", "--no-managed-python", "--no-python-downloads", "--system-certs", "--quiet", "--verbose", "--no-progress", "--no-env-file", "--compile-bytecode", "--reinstall"].map((flag): [string, UvxFlag] => [flag, { value: false }]),
  ...["--with-editable", "--with-requirements"].map((flag): [string, UvxFlag] => [flag, { refused: OUTSIDE_PYPI }]),
  ...["--index", "--default-index", "--index-url", "--extra-index-url", "--find-links", "--no-index", "--index-strategy", "--keyring-provider", "--torch-backend"].map((flag): [string, UvxFlag] => [flag, { refused: OTHER_INDEX }]),
  ...["--constraints", "--overrides", "--build-constraints", "--config-file", "--env-file", "--directory", "--project"].map((flag): [string, UvxFlag] => [flag, { refused: HOST_FILE }]),
  ...["--no-binary", "--no-binary-package", "--config-setting", "--config-settings-package", "--no-build-isolation", "--no-build-isolation-package", "--python-platform", "--lfs"].map((flag): [string, UvxFlag] => [flag, { refused: FROM_SOURCE }]),
  ["--allow-insecure-host", { refused: INSECURE_HOST }],
]);

/** The one-letter forms of the flags above. */
const UVX_SHORT = new Map<string, string>([
  ["w", "--with"], ["p", "--python"], ["q", "--quiet"], ["v", "--verbose"], ["n", "--no-cache"],
  ["i", "--index-url"], ["f", "--find-links"], ["c", "--constraints"], ["b", "--build-constraints"], ["C", "--config-setting"],
]);

const PRERELEASE_MODES = ["disallow", "allow", "if-necessary", "explicit", "if-necessary-or-explicit"];

/** A CPython version the cage runs: 3.10 to 3.15, with a patch release or without. */
const PYTHON_VERSION = /^3\.1[0-5](?:\.(?:0|[1-9][0-9]{0,2}))?$/;

/**
 * The variables a uvx command line starts with, by where they are set: each layer adds its own to
 * those before it and wins over them, as a client adds an entry's `env` to its own environment.
 * `where` names the layer in messages ("its env"). Messages name variables, never their values,
 * which can hold a credential (an index URL with a password). `own` marks the user's own
 * environment, where UV_CONFIG_FILE names the user's settings file, which uvx reads in place of their
 * uv.toml: that file is looked at for an index as the uv.toml is (see uv-settings.ts), where the same
 * variable in an entry's env, a file the entry chose, is refused. `caged` marks the variables of an
 * entry that starts `mcpcage run` already: run gets them in its own environment, which it reads as
 * the user's (it cannot tell them apart), so their UV_CONFIG_FILE is a file it looks at, as the
 * user's, and protect reads it so too (see runRefusal in protect.ts).
 */
export type UvEnvironment = ReadonlyArray<{ where: string; variables: unknown; own?: boolean; caged?: boolean }>;

/**
 * The variables of uv's environment that make uvx take its packages from somewhere else than PyPI's
 * wheels, or decide what it installs from a file on the host, with what uvx does with each: the cage
 * reproduces none of it, so a line started with one is refused, as the flag it stands for is
 * (UVX_FLAGS). The names are those `uv tool run --help` gives for its flags in uv 0.13.7. UV_NO_INDEX
 * is not one: uv 0.13.7 installed from PyPI with it set. UV_WORKING_DIR and UV_WORKING_DIRECTORY are
 * --directory's: uv 0.13.7 ran the server in that directory, and read a relative UV_CONFIG_FILE
 * from it, a file mcpcage looks for in the client's directory. UV_PROJECT, --project's, is not one:
 * uv 0.13.7's tool run kept its directory with it set, and read no file from the one it named.
 */
const UV_REFUSED: ReadonlyMap<string, string> = new Map([
  ...["UV_INDEX", "UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS", "UV_INDEX_STRATEGY", "UV_KEYRING_PROVIDER", "UV_TORCH_BACKEND"].map((name): [string, string] => [
    name,
    "uvx installs from another index there",
  ]),
  ...["UV_CONFIG_FILE", "UV_CONSTRAINT", "UV_OVERRIDE", "UV_BUILD_CONSTRAINT", "UV_ENV_FILE", "UV_WORKING_DIR", "UV_WORKING_DIRECTORY"].map((name): [string, string] => [
    name,
    "uvx reads a file on your machine there, which the cage does not read",
  ]),
  ...["UV_NO_BINARY", "UV_NO_BINARY_PACKAGE"].map((name): [string, string] => [name, "uvx builds packages from source there, and the cage installs PyPI wheels only"]),
  ["UV_INSECURE_HOST", "uvx turns off certificate checks for a host there, which only another index or a proxy needs"],
]);

/**
 * The value `environment` gives uv's variable `name`, and the layer that sets it: the last one that
 * does. Windows compares names without case, as uv's reads of them there do. An empty value is no
 * value: uv 0.13.7 ignored UV_INDEX_URL= and UV_PYTHON= alike, and so one set empty by a later layer
 * unsets what an earlier one gave. `settings` says whether the layer's UV_CONFIG_FILE is a settings
 * file to look at rather than refuse: the user's own, or a caged entry's (see UvEnvironment).
 */
function uvVariable(environment: UvEnvironment, name: string, platform: NodeJS.Platform): { where: string; name: string; value: unknown; settings: boolean } | undefined {
  for (const layer of [...environment].reverse()) {
    if (!isJsonObject(layer.variables)) continue;
    const written = Object.keys(layer.variables).find((key) => (platform === "win32" ? key.toUpperCase() === name : key === name));
    if (written === undefined) continue;
    return layer.variables[written] === "" ? undefined : { where: layer.where, name: written, value: layer.variables[written], settings: layer.own === true || layer.caged === true };
  }
  return undefined;
}

/**
 * What uv's environment adds to a uvx command line, as uv reads it: the variables of UV_REFUSED stop
 * it; UV_RESOLUTION too, but for `highest`, uv's default (uv 0.13.7 installed idna 2.0 for `idna>=2`
 * with UV_RESOLUTION=lowest, where the cage installs the newest); UV_PYTHON, UV_PRERELEASE and
 * UV_EXCLUDE_NEWER are what --python, --prerelease and --exclude-newer are when the line does not give
 * them (`given`: a flag wins over its variable, as in uv), with the same values accepted. Every other
 * variable of uv's tunes its cache, its output or its lookup of an interpreter on the host, and has
 * no effect in the cage.
 */
function fromUvEnvironment(environment: UvEnvironment, platform: NodeJS.Platform, given: ReadonlyMap<string, string>): { python?: string; prerelease?: string; excludeNewer?: string } {
  for (const name of UV_REFUSED.keys()) {
    const set = uvVariable(environment, name, platform);
    if (set !== undefined && !(set.settings && name === "UV_CONFIG_FILE")) throw new Error(`${set.where} sets ${set.name}: ${UV_REFUSED.get(name)}`);
  }
  const resolution = uvVariable(environment, "UV_RESOLUTION", platform);
  if (resolution !== undefined && resolution.value !== "highest") {
    throw new Error(`${resolution.where} sets ${resolution.name}: uvx chooses other versions there than the newest, which the cage installs`);
  }
  const read = (name: string, valid: (value: string) => boolean, what: string): string | undefined => {
    const flag = `--${name.slice("UV_".length).toLowerCase().replace(/_/g, "-")}`;
    if (given.has(flag)) return given.get(flag);
    const set = uvVariable(environment, name, platform);
    if (set === undefined) return undefined;
    if (typeof set.value !== "string" || !valid(set.value)) throw new Error(`${set.where} sets ${set.name} to another value than ${what}`);
    return set.value;
  };
  const python = read("UV_PYTHON", (value) => PYTHON_VERSION.test(value), "a CPython version from 3.10 to 3.15 (such as 3.12 or 3.12.4), the only ones the cage runs");
  const prerelease = read("UV_PRERELEASE", (value) => PRERELEASE_MODES.includes(value), `one of ${PRERELEASE_MODES.join(", ")}`);
  const excludeNewer = read("UV_EXCLUDE_NEWER", isExcludeNewer, "a date (2026-01-31), a time with its zone (2026-01-31T12:00:00Z) or a duration (30 days, P30D)");
  return { ...(python === undefined ? {} : { python }), ...(prerelease === undefined ? {} : { prerelease }), ...(excludeNewer === undefined ? {} : { excludeNewer }) };
}

/**
 * Reads the words uv's `tool run` is given, as uv 0.13.7 reads them: flags until the first other
 * word or `--`, then the package, or with --from the command, then the server's own arguments,
 * whatever they look like. Flags take their value as the next word, after `=`, or in their
 * one-letter form attached (`-w x`, `--with=x`, `-wx`, `-qwx`). Only what the cage builds from PyPI
 * wheels is accepted: anything else throws, naming the flag but never its value, which can hold a
 * credential (an index URL with a password, a git URL with a token). uv reads its environment too:
 * what `environment` sets is read as uv reads it (see fromUvEnvironment).
 */
function parseUvx(words: string[], platform: NodeJS.Platform, environment: UvEnvironment): PypiLaunch {
  const once = new Map<string, string>();
  const withs: string[] = [];
  const take = (name: string, flag: Extract<UvxFlag, { value: boolean }>, value: string) => {
    if (flag.read === "with") {
      withs.push(...splitWith(value));
    } else if (flag.read === "color") {
      if (!["auto", "always", "never"].includes(value)) throw new Error("uvx --color: give auto, always or never");
    } else if (flag.read === "link-mode") {
      // uv refuses any other value, so a line with one never started uncaged either.
      if (!["clone", "copy", "hardlink", "symlink"].includes(value)) throw new Error("uvx --link-mode: give clone, copy, hardlink or symlink");
    } else if (flag.read !== undefined) {
      if (once.has(name)) throw new Error(`uvx ${name} is given twice`);
      once.set(name, value);
    }
  };
  /** The value of a flag written apart from it: the next word, unless it is another flag, as uv says. */
  const next = (name: string, index: number): string => {
    const value = words[index + 1];
    if (value === undefined || value.startsWith("-")) throw new Error(`uvx ${name} needs a value`);
    return value;
  };

  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") {
      index++;
      break;
    }
    if (!word.startsWith("-") || word === "-") break;
    if (word.startsWith("--")) {
      const name = flagName(word);
      const flag = UVX_FLAGS.get(name);
      if (flag === undefined) throw new Error(`unsupported uvx flag ${name}`);
      if ("refused" in flag) throw new Error(`uvx ${name}: ${flag.refused}`);
      if (!flag.value) {
        if (name !== word) throw new Error(`uvx ${name} takes no value`);
        continue;
      }
      if (name !== word) {
        take(name, flag, word.slice(name.length + 1));
      } else {
        take(name, flag, next(name, index));
        index++;
      }
      continue;
    }
    // One-letter flags, several in one word as uv allows (-qq, -qn): one that takes a value takes the
    // rest of the word, after an optional "=", or the next word.
    for (let at = 1; at < word.length; at++) {
      const letter = String.fromCodePoint(word.codePointAt(at)!);
      const long = UVX_SHORT.get(letter);
      if (long === undefined) throw new Error(`unsupported uvx flag -${letter}`);
      const flag = UVX_FLAGS.get(long)!;
      if ("refused" in flag) throw new Error(`uvx -${letter}: ${flag.refused}`);
      if (!flag.value) continue;
      const rest = word.slice(at + 1);
      if (rest !== "") {
        take(long, flag, rest.startsWith("=") ? rest.slice(1) : rest);
      } else {
        take(long, flag, next(long, index));
        index++;
      }
      break;
    }
  }

  const target = words[index];
  const from = once.get("--from");
  if (target === undefined) throw new Error(from === undefined ? "uvx needs a package name" : "uvx --from needs a command after its package");
  if (interpreterRequest(from ?? target, platform)) throw new Error(`uvx ${from === undefined ? "<package>" : "--from"}: ${INTERPRETER}`);
  const tool = toolRequirement(from ?? target, from === undefined ? "<package>" : "--from");
  for (const requirement of withs) {
    // uv reads `pkg@1.0` in --with as a path, not as the version uvx's own package takes after @.
    if (uvxRequirement(requirement) === undefined) throw new Error(`uvx --with: ${(outsidePyPI(requirement) || requirement.includes("@")) ? OUTSIDE_PYPI : NOT_A_REQUIREMENT}`);
  }
  const flagPython = once.get("--python");
  if (flagPython !== undefined && !PYTHON_VERSION.test(flagPython)) throw new Error(`uvx --python: ${PYTHON_RANGE}`);
  const flagPrerelease = once.get("--prerelease");
  if (flagPrerelease !== undefined && !PRERELEASE_MODES.includes(flagPrerelease)) throw new Error(`uvx --prerelease: give one of ${PRERELEASE_MODES.join(", ")}`);
  const flagExcludeNewer = once.get("--exclude-newer");
  if (flagExcludeNewer !== undefined && !isExcludeNewer(flagExcludeNewer)) {
    throw new Error("uvx --exclude-newer: give a date (2026-01-31), a time with its zone (2026-01-31T12:00:00Z) or a duration (30 days, P30D)");
  }
  const { python, prerelease, excludeNewer } = fromUvEnvironment(environment, platform, once);
  return {
    kind: "pypi",
    project: normalizedName(tool.name),
    requirement: tool.requirement,
    command: from === undefined ? tool.name : toolCommand(target, platform),
    with: withs,
    ...(python === undefined ? {} : { python }),
    resolution: { ...(prerelease === undefined ? {} : { prerelease }), ...(excludeNewer === undefined ? {} : { excludeNewer: excludeNewerInstant(excludeNewer) }) },
    args: words.slice(index + 1),
  };
}

/**
 * Whether uvx reads its package, or the value of --from, as a request for a Python interpreter, which
 * it starts in place of a package's command: uv 0.13.7 tries that first (ToolRequest::parse,
 * PythonRequest::try_from_tool_name), in ASCII lowercase. `python` alone, and `pythonw` on Windows,
 * is the default interpreter; it, or an implementation's name (cpython, pypy, graalpy, pyodide), is
 * one when followed by nothing (the implementation's), by `@` and anything (a version, or an error of
 * uv's), or by a version request (see pythonVersionRequest). Read as PyPI projects, they had the cage
 * build another program, or none: `uvx --with mcp python3.13 server.py` runs server.py with uv's
 * Python, and mcpcage resolved the project python3-13; `uvx pyodide` starts uv's Pyodide, and
 * mcpcage planned PyPI's pyodide 0.19.0a1, a wheel without a command.
 */
function interpreterRequest(text: string, platform: NodeJS.Platform): boolean {
  const lower = text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  const abstract = platform === "win32" ? ["python", "pythonw"] : ["python"];
  if (abstract.includes(lower)) return true;
  return [...abstract, "cpython", "pypy", "graalpy", "pyodide"].some((prefix) => {
    if (!lower.startsWith(prefix)) return false;
    const rest = lower.slice(prefix.length);
    return rest === "" || rest.startsWith("@") || pythonVersionRequest(rest);
  });
}

/** The variants uv 0.13.7 reads at the end of an interpreter's version: 3.13t, 3.13+debug. */
const PYTHON_VARIANTS = new Set(["t", "freethreaded", "d", "debug", "td", "freethreaded+debug", "gil", "gil+debug"]);

/** A PEP 440 version in lowercase, its release and its pre, post, dev and local parts apart. */
const VERSION_PARTS = /^v?(?:[0-9]+!)?([0-9]+(?:\.[0-9]+)*)((?:[-_.]?(?:alpha|a|beta|b|preview|pre|c|rc)[-_.]?[0-9]*)?)((?:-[0-9]+|[-_.]?(?:post|rev|r)[-_.]?[0-9]*)?)((?:[-_.]?dev[-_.]?[0-9]*)?)((?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?)$/;

/**
 * Whether uv 0.13.7 reads the text after an interpreter's name as a version request
 * (VersionRequest::from_str), a variant at its end set aside: a version of one to three parts, 313
 * read as 3.13, each part 0 to 255, a pre-release with two parts at least, no post, dev or local part;
 * else version specifiers (>=3.12,<3.14). For anything else uv reads the whole word as a package:
 * python-dotenv, python3-openid, python3.13-1 (a post release), python3.256 each was one for uv 0.13.7.
 */
function pythonVersionRequest(text: string): boolean {
  let version = text;
  const digit = text.search(/[0-9][^0-9]*$/);
  if (digit !== -1 && digit + 1 < text.length && PYTHON_VARIANTS.has(text.slice(digit + 1).replace(/^\+/, ""))) version = text.slice(0, digit + 1);
  const parts = VERSION_PARTS.exec(trimmed(version, ASCII_SPACE));
  if (parts === null) {
    return version.split(",").every((specifier) => {
      const match = /^[ \t]*(===|==|!=|<=|>=|~=|<|>)[ \t]*(.*?)[ \t]*$/.exec(specifier);
      return match !== null && isSpecifierVersion(match[1]!, match[2]!);
    });
  }
  const [, release, pre, post, dev, local] = parts;
  if (post !== "" || dev !== "" || local !== "") return false;
  let numbers = release!.split(".").map(Number);
  const tag = String(numbers[0]);
  if (numbers.length === 1 && /^[0-9]{2,}$/.test(tag)) numbers = [Number(tag[0]), Number(tag.slice(1))];
  return numbers.length <= 3 && numbers.every((number) => number <= 255) && !(numbers.length === 1 && pre !== "");
}

/** A flag's name: the word up to its "=", without the value that follows. */
function flagName(word: string): string {
  const equals = word.indexOf("=");
  return equals === -1 ? word : word.slice(0, equals);
}

/**
 * The requirement uvx installs for its package or --from (`where`), and the name in it. uvx reads
 * `pkg@1.2` as `pkg==1.2` and `pkg@latest` as `pkg`, and anything else after @ as a path or URL
 * ("the @ syntax cannot be used for anything other than an exact version",
 * https://docs.astral.sh/uv/guides/tools/#requesting-specific-versions); the rest is a PEP 508
 * requirement, of which the cage takes names, extras and versions only.
 */
function toolRequirement(text: string, where: string): { requirement: string; name: string } {
  const refuse = (reason: string) => new Error(`uvx ${where}: ${reason}`);
  const at = text.indexOf("@");
  if (at === -1) {
    const parsed = uvxRequirement(text);
    if (parsed === undefined) throw refuse(outsidePyPI(text) ? OUTSIDE_PYPI : NOT_A_REQUIREMENT);
    return { requirement: text, name: parsed.name };
  }
  const base = text.slice(0, at);
  const version = text.slice(at + 1);
  const parsed = uvxRequirement(base);
  if (parsed === undefined || parsed.specifiers.length > 0 || /[ \t]/.test(base)) throw refuse(outsidePyPI(text) ? OUTSIDE_PYPI : NOT_A_REQUIREMENT);
  if (version === "latest") return { requirement: base, name: parsed.name };
  if (isVersion(version)) return { requirement: `${base}==${version}`, name: parsed.name };
  throw refuse(outsidePyPI(version) ? OUTSIDE_PYPI : AT_VERSION);
}

/**
 * pypiRequirement, for a requirement uvx installs: never one with a control character, which the
 * resolve refuses before it writes a requirement on uv's stdin, one per line (see checkedRequirement
 * in pypi.ts). A tab, which PEP 508 and uv 0.13.7 read as a space, was taken here: `uvx "idna<tab>"`
 * was the package idna, protect said it would start, and every start failed at the resolve.
 */
function uvxRequirement(text: string): ReturnType<typeof pypiRequirement> {
  return /[\u0000-\u001f\u007f]/.test(text) ? undefined : pypiRequirement(text);
}

/**
 * Whether uv would read a requirement as code from somewhere other than an index: a URL, a git
 * source, a path, an archive or wheel file. Only to say why it is refused: anything that is not
 * a PyPI requirement is refused either way.
 */
function outsidePyPI(text: string): boolean {
  return /:\/\/|^git\+|^file:|[/\\]|^[.~]|^[A-Za-z]:/.test(text) || ARCHIVE.test(text) || ARCHIVE.test(/^[ \t]*([A-Za-z0-9._-]*)/.exec(text)![1]!);
}

/**
 * The file extensions with which uv 0.13.7 reads a requirement as a file on disk, not a name:
 * `uvx foo.tar.gz` is file:///foo.tar.gz for it, whatever the PEP 508 grammar says of the name.
 */
const ARCHIVE = /\.(?:whl|zip|tar|tgz|tbz|tlz|txz|tar\.(?:gz|bz2|lz|lzma|xz|zst))$/i;

/**
 * The command after --from: a file name the package's environment has, as uvx looks it up there.
 * A command line written for Windows names it with .exe (awslabs' servers: `--from
 * awslabs.aws-api-mcp-server@latest awslabs.aws-api-mcp-server.exe`), which the Linux cage drops;
 * the .ps1, .cmd and .bat scripts uv also finds there are Windows' own
 * (https://docs.astral.sh/uv/guides/tools/#legacy-windows-scripts).
 */
function toolCommand(word: string, platform: NodeJS.Platform): string {
  const windows = platform === "win32";
  if (windows && /\.(?:cmd|bat|ps1)$/i.test(word)) throw new Error("uvx --from: the command is a Windows script (.cmd, .bat or .ps1), which the cage cannot start");
  const command = windows ? word.replace(/\.exe$/i, "") : word;
  if (command === "" || command === "." || command === ".." || command.startsWith("-") || /[/\\\u0000-\u001f\u007f]/.test(command)) throw new Error(`uvx --from: ${PLAIN_COMMAND}`);
  return command;
}

/**
 * The requirements of one --with value. uv splits it at each comma outside brackets that no version
 * operator follows, so `a,b` is two requirements and `a>=1,<2` one, and drops the empty ones (uv
 * 0.13.7: `--with 'a>=1,b'` installs both, `--with ''` nothing).
 */
function splitWith(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "[") depth++;
    else if (character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      let after = index + 1;
      while (after < value.length && ASCII_SPACE.includes(value[after]!)) after++;
      if (after < value.length && "!=<>~".includes(value[after]!)) continue;
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => trimmed(part, ASCII_SPACE)).filter((part) => part !== "");
}

const ASCII_SPACE = " \t\n\r\f\v";

/** `text` without the `characters` that start or end it; by hand, as a regex such as /\s+$/ takes quadratic time on a long run of them. */
function trimmed(text: string, characters: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && characters.includes(text[start]!)) start++;
  while (end > start && characters.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

/**
 * A requirement in the subset of PEP 508 the cage builds from PyPI: a name, optional [extras], an
 * optional comma-separated list of versions, spaces and tabs between them. No markers (`; ...`), no
 * `@ url`, no parentheses. Undefined for any other text. The versions follow PEP 440, with the limits
 * uv 0.13.7 puts on them: `~=` needs two parts of a release, a local version (`+x`) goes with `==`,
 * `!=` and `===` only, a wildcard (`1.2.*`) with `==` and `!=` only.
 */
export function pypiRequirement(text: string): { name: string; extras: string[]; specifiers: string[] } | undefined {
  let at = 0;
  const skipSpace = () => {
    while (text[at] === " " || text[at] === "\t") at++;
  };
  const readName = (): string | undefined => {
    const start = at;
    while (at < text.length && /[A-Za-z0-9._-]/.test(text[at]!)) at++;
    const name = text.slice(start, at);
    return /^[A-Za-z0-9]/.test(name) && /[A-Za-z0-9]$/.test(name) ? name : undefined;
  };
  skipSpace();
  const name = readName();
  if (name === undefined || ARCHIVE.test(name)) return undefined;
  skipSpace();
  const extras: string[] = [];
  if (text[at] === "[") {
    const close = text.indexOf("]", at);
    if (close === -1) return undefined;
    const inside = trimmed(text.slice(at + 1, close), " \t");
    if (inside !== "") {
      for (const extra of inside.split(",")) {
        const word = trimmed(extra, " \t");
        if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(word)) return undefined;
        extras.push(word);
      }
    }
    at = close + 1;
    skipSpace();
  }
  const specifiers: string[] = [];
  while (at < text.length) {
    const operator = ["===", "==", "!=", "<=", ">=", "~=", "<", ">"].find((candidate) => text.startsWith(candidate, at));
    if (operator === undefined) return undefined;
    at += operator.length;
    skipSpace();
    const start = at;
    while (at < text.length && !" \t,".includes(text[at]!)) at++;
    const version = text.slice(start, at);
    if (!isSpecifierVersion(operator, version)) return undefined;
    specifiers.push(`${operator}${version}`);
    skipSpace();
    if (at === text.length) break;
    if (text[at] !== ",") return undefined;
    at++;
    skipSpace();
    // A comma joins two versions: uv takes a final one too, the PEP 508 grammar does not.
    if (at === text.length) return undefined;
  }
  return { name, extras, specifiers };
}

/** A PEP 440 version, as written: epoch, release, pre, post and dev parts, a local label. */
const VERSION = /^v?(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:[-_.]?(?:alpha|a|beta|b|preview|pre|c|rc)[-_.]?[0-9]*)?(?:-[0-9]+|[-_.]?(?:post|rev|r)[-_.]?[0-9]*)?(?:[-_.]?dev[-_.]?[0-9]*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;

function isVersion(text: string): boolean {
  return VERSION.test(text);
}

function isSpecifierVersion(operator: string, version: string): boolean {
  if (operator === "==" || operator === "!=") {
    if (/^v?(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*\.\*$/i.test(version)) return true;
  }
  if (!isVersion(version)) return false;
  if (version.includes("+") && !["==", "!=", "==="].includes(operator)) return false;
  if (operator === "~=") return /^v?(?:[0-9]+!)?[0-9]+\.[0-9]+/i.test(version);
  return true;
}

/** A package name in PEP 503 normal form: lowercase, each run of -, _ and . made one -. */
function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * A value of --exclude-newer that uv 0.13.7 takes and that can mean the same in the cage as on the
 * host: a date (see excludeNewerInstant), a time with its zone (without one, uv reads it in the
 * host's zone), or a duration in seconds to weeks, friendly (`30 days`, `3d`, `2 weeks ago`) or ISO
 * 8601 (`P30D`, `PT12H`). uv refuses months and years, whose length varies.
 */
function isExcludeNewer(value: string): boolean {
  const moment = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,9})?)?(?:[Zz]|[+-]([0-9]{2}):([0-9]{2})))?$/.exec(value);
  if (moment !== null) {
    const [year, month, day, hour = 0, minute = 0, second = 0, zoneHour = 0, zoneMinute = 0] = moment.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
    const date = new Date(Date.UTC(year!, month! - 1, day!));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59 && zoneHour <= 23 && zoneMinute <= 59;
  }
  if (/^[0-9]{1,5} ?(?:s|secs?|seconds?|min|mins|minutes?|h|hrs?|hours?|d|days?|w|wk|weeks?)(?: ago)?$/.test(value)) return true;
  return /^P(?=[0-9]|T[0-9])(?:[0-9]{1,5}W)?(?:[0-9]{1,5}D)?(?:T(?=[0-9])(?:[0-9]{1,5}H)?(?:[0-9]{1,5}M)?(?:[0-9]{1,5}S)?)?$/i.test(value);
}

/**
 * The instant uv gives --exclude-newer (or UV_EXCLUDE_NEWER) on the host, for the cage's resolve,
 * whose uv runs in UTC: a date is the start of the next day in the host's time zone for uv 0.13.7
 * (ExcludeNewerValue::from_str adds a day and reads it in TimeZone::system()), so it is given as that
 * instant in UTC. uv 0.13.7 wrote 2026-01-01 into a uv.lock as 2026-01-01T23:00:00Z with
 * TZ=Europe/Rome, 2026-01-02T05:00:00Z with America/New_York, 2026-01-01T15:00:00Z with Asia/Tokyo,
 * and 2026-01-02T00:00:00Z without TZ in its image: in the cage, with the date as written, a server
 * resolved on a host in Rome took one more hour of releases than uvx there. A time with its zone and a
 * duration (from the time of the resolve) are the same in both, and stay as written.
 */
function excludeNewerInstant(value: string): string {
  const date = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (date === null) return value;
  // setFullYear, not the Date constructor, which reads a year below 100 as 19xx.
  const next = new Date(0);
  next.setFullYear(Number(date[1]), Number(date[2]) - 1, Number(date[3]) + 1);
  next.setHours(0, 0, 0, 0);
  return next.toISOString().replace(/\.000Z$/, "Z");
}

/**
 * The npx command line a server's command line runs: itself when it starts npx, the part after `/c`
 * when it is a plain `cmd /c npx ...` on Windows (see cmdRunner); undefined for any other.
 */
export function npxArgv(argv: readonly unknown[], platform: NodeJS.Platform = process.platform): string[] | undefined {
  const [command] = argv;
  if (typeof command === "string" && isNpx(command, platform)) return argv as string[];
  const cmd = cmdRunner(argv, platform);
  return cmd !== undefined && cmd.runner === "npx" && "line" in cmd ? cmd.line : undefined;
}

/** cmdRunner for npx lines only, as protect and wrap read them: a `cmd /c uvx` line is not one. */
export function cmdNpx(argv: readonly unknown[], platform: NodeJS.Platform = process.platform): { npx: string[] } | { notPlain: string } | undefined {
  const cmd = cmdRunner(argv, platform);
  if (cmd === undefined || cmd.runner !== "npx") return undefined;
  return "line" in cmd ? { npx: cmd.line } : { notPlain: cmd.notPlain };
}

/**
 * The npx or uvx command line that `cmd /c npx ...` or `cmd /c uvx ...` runs on Windows, where many
 * configurations start npx so, because some clients cannot start npx.cmd themselves, and some READMEs
 * start uvx so too (mcp-for-blender's: `"command": "cmd", "args": ["/c", "uvx", "mcp-for-blender"]`):
 * `cmd` or `cmd.exe` in any case, bare or a full path, then `/c` (any case), after `/d` or `/s` at
 * most. Undefined for a command line that is not one. Such entries were "cmd, not npx" in the report,
 * and wrap and --fix left them on the host. cmd reads what follows `/c` itself: `&`, `|`, `<`, `>`,
 * `^`, `%`, `!`, quotes and parentheses can start another command, redirect, or change what the
 * runner is given, and a control character can end the line. Only a line with none of them runs npx
 * or uvx with exactly the arguments the cage gives it; for any other, `notPlain` says why (never
 * quoting an argument, which may hold a credential), and it stays a program mcpcage does not cage. An
 * argument with a space is accepted after the first: the client quotes it, cmd passes the quotes on,
 * and the runner reads them away. In the first, the runner's path, the quotes open the line, where
 * cmd removes them by rules of its own.
 */
export function cmdRunner(
  argv: readonly unknown[],
  platform: NodeJS.Platform = process.platform,
): { runner: Runner; line: string[] } | { runner: Runner; notPlain: string } | undefined {
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
  const runner = runnerOf(program, platform) ?? runnerOf(line[0] ?? "", platform);
  if (runner === undefined) return undefined;
  if (switches.slice(0, -1).some((option) => !/^\/[ds]$/i.test(option))) return { runner, notPlain: "it gives cmd a switch other than /d and /s before /c" };
  for (const word of line) {
    if (word === "") return { runner, notPlain: "an argument after /c is empty, which the client can give cmd only in quotes" };
    const read = cmdWouldRead([word], runner);
    if (read !== undefined) return { runner, notPlain: `an argument after /c has ${read}` };
  }
  if (line[0] !== program) {
    return {
      runner,
      notPlain: runnerOf(line[0]!, platform) === runner
        ? `the path of ${runner} has a space, so the client quotes it, and cmd removes quotes there by rules of its own`
        : `it gives ${runner} and what follows in one argument, which cmd splits by rules of its own`,
    };
  }
  return { runner, line };
}

/** The programs that cmdRunner finds after `cmd /c`. */
type Runner = "npx" | "uvx";

function runnerOf(command: string, platform: NodeJS.Platform): Runner | undefined {
  return isNpx(command, platform) ? "npx" : isUvx(command, platform) ? "uvx" : undefined;
}

/**
 * What cmd would read itself in `words` when it re-reads them as a command line (the `%*` of npm's
 * .cmd shim, or the line after `cmd /c`): the first such character's description, or undefined for
 * words it would pass on unchanged. An argument that holds one cannot be given to npx, uvx, or the
 * server mcpcage starts for a .cmd entry, as written. `program` is what the description names as
 * reading the redirected input and output.
 */
export function cmdWouldRead(words: readonly string[], program = "npx"): string | undefined {
  for (const word of words) {
    const read = CMD_READS.find(([characters]) => characters.test(word));
    if (read !== undefined) return read[1].replace("{program}", program);
  }
  return undefined;
}

/** What cmd reads itself in the line after `/c`, with what it does. */
const CMD_READS: ReadonlyArray<[RegExp, string]> = [
  [/[&|]/, "& or |, with which cmd starts another command"],
  [/[<>]/, "< or >, with which cmd redirects what {program} reads or writes"],
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
 * macOS too (see withoutCase).
 */
export function isNpx(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return /(^|[/\\])npx(\.cmd)?$/.test(withoutCase(command, platform));
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
 * checked against the old approved ones instead of being trusted as a new server. For a PyPI server
 * the extras, --with and --python are left out too: they change what is installed, as a version does.
 */
export function serverIdFor(spec: LaunchSpec): string {
  const identity =
    spec.kind === "npm"
      ? { kind: spec.kind, name: spec.packageName || spec.localPath, args: spec.args }
      : spec.kind === "image"
        ? { kind: spec.kind, image: imageRepository(spec.image), args: spec.args }
        : spec.kind === "pypi"
          ? { kind: spec.kind, project: spec.project, command: spec.command, args: spec.args }
          : { kind: spec.kind, command: spec.command, args: spec.args };
  const label =
    spec.kind === "npm"
      ? spec.packageName || basename(spec.localPath ?? "local")
      : spec.kind === "image"
        ? imageRepository(spec.image)
        : spec.kind === "pypi"
          ? spec.project
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
