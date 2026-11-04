import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readConfigFile } from "./clients.js";
import { isJsonObject } from "./jsonc.js";
import { clientPlaces } from "./sensitive.js";

/*
 * Whether a wrapped entry starts mcpcage, or another program that only has its name. Anyone who can
 * write a file can name it mcpcage, and put a package.json that says "mcpcage" next to it: a
 * look-alike with one was reported caged, and left alone by --fix, while it ran on the host. Only two
 * files are known to be mcpcage: the command `wrap` and `protect --fix` write into configurations,
 * and the mcpcage that is running now. And what else the entry's own `env`, and the `envFile` VS
 * Code loads with it, decide on the host for the mcpcage it starts: the programs its PATH picks, and
 * the places `run` refuses to mount.
 */

/** An mcpcage known to this one, another program (or one that cannot be told apart), or nothing that can be found. */
export type McpcageKind = "installed" | "other program" | "not found";

/** A command whose file depends on something not known here: the directory the client starts it from. */
const UNKNOWN = Symbol("unknown");

/**
 * What a wrapped entry's command is on this machine. It counts as mcpcage only when it is, symlinks
 * followed, the same file as `own` (the command `wrap` and `--fix` write: pnpm and Volta install a
 * script or a program of their own, not a link into the package, so whatever it is, it is mcpcage)
 * or as the entry point of the mcpcage that is running. A bare name is looked up as the client's
 * spawn looks it up: in the PATH the entry's own `env` sets, else in this process's PATH. A
 * `command: "mcpcage"` with an `env.PATH` of the attacker's choice was vouched for as caged, because
 * it was looked up in mcpcage's PATH. A relative path, or a relative directory in the entry's PATH,
 * depends on the directory the client starts the entry from: it is never taken for mcpcage.
 */
export function mcpcageAt(entry: { command: string; env?: unknown }, own?: string): McpcageKind {
  const found = startedBy(entry);
  if (found === undefined) return "not found";
  if (found === UNKNOWN) return "other program";
  const real = realFile(found);
  if (real === undefined) return "not found";
  const known = [own === undefined ? undefined : realCommand(own), runningMcpcage()];
  return known.includes(real) ? "installed" : "other program";
}

/** The part of an entry's PATH that is not the user's (see foreignPath). */
export interface ForeignPath {
  /** Its directories that are not on this process's PATH, as written, each once: "" for an empty element. */
  dirs: string[];
  /** A value that is not a string, which the client's spawn converts into a directory name nobody chose. */
  notString?: boolean;
}

/**
 * The directories of the PATH an entry's `env` sets that are not on the PATH of this process, or
 * undefined when it sets none, or only directories of the user's. A client starts the entry with
 * that PATH, and every program started from there inherits it: the node that the
 * `#!/usr/bin/env node` of mcpcage's script finds, the dirname, sed and uname that a pnpm shim runs,
 * the docker that mcpcage runs and the credential helper that docker runs. Comparing node and docker
 * with the user's missed the others: a uname of the entry's choice ran on the host, from the pnpm
 * shim of mcpcage, and the entry was reported caged. A directory of the user's PATH holds only what
 * the user's own shell may start, so a PATH made of them alone (the minimal PATH of many Claude
 * Desktop configurations) is accepted; a relative directory, or an empty element, depends on the
 * directory the client starts the entry from, and is never one. Directories are compared as they
 * resolve, symlinks followed, without case on macOS and Windows, whose file systems ignore it.
 */
export function foreignPath(env: unknown): ForeignPath | undefined {
  const path = pathOf(env);
  if (path === undefined) return undefined;
  if (path === UNKNOWN) return { dirs: [], notString: true };
  const yours = new Set((process.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir)).map(dirKey));
  const dirs = [...new Set(path.split(delimiter))].filter((dir) => !isAbsolute(dir) || !yours.has(dirKey(dir)));
  return dirs.length === 0 ? undefined : { dirs };
}

/**
 * A directory as it resolves, symlinks followed, without case on macOS and Windows, and with the
 * names the system keeps on disk: realpathSync kept an 8.3 short name (C:\PROGRA~1), and a PATH
 * that spelled the user's own directory in full counted as another one.
 */
function dirKey(dir: string): string {
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    // Not there, or not yet: compared as written, `..` and a final separator resolved.
    real = resolve(dir);
  }
  return process.platform === "darwin" || process.platform === "win32" ? real.toLowerCase() : real;
}

/** The variables that say where clients keep their configurations (see userConfigs in clients.ts). */
const PLACE_VARIABLES = ["COPILOT_HOME", "XDG_CONFIG_HOME", "APPDATA"];

/**
 * The variables of an entry's `env` that move, for the mcpcage it starts, the client
 * configurations `run` refuses to mount (see clientPlaces in sensitive.ts): `run` looks for them
 * with its own environment, which the client gives the entry's `env`. With COPILOT_HOME pointed
 * elsewhere in the entry, `run` mounted the user's real Copilot directory, the caged server added a
 * server of its own there, which Copilot then started uncaged, and protect called the entry caged.
 * A variable counts when the places it gives differ from those of this process's environment (an
 * XDG_CONFIG_HOME moves nothing on macOS), and so does a value that is not a string, which the
 * client's spawn converts into a path nobody chose.
 */
export function movedPlaces(env: unknown): string[] {
  if (!isJsonObject(env)) return [];
  const windows = process.platform === "win32";
  const places = (variables: NodeJS.ProcessEnv) =>
    clientPlaces({ platform: process.platform, home: homedir(), env: variables })
      .map((place) => place.path)
      .join("\n");
  const yours = places(process.env);
  return Object.entries(env).flatMap(([name, value]) => {
    const variable = PLACE_VARIABLES.find((known) => known === (windows ? name.toUpperCase() : name));
    if (variable === undefined) return [];
    return typeof value !== "string" || places({ ...process.env, [variable]: value }) !== yours ? [name] : [];
  });
}

/** The file an entry's `envFile` names, and what it sets (see envFileOf). */
export interface EnvFile {
  /** The value of `envFile`, as written; undefined when it is not a string. */
  path?: string;
  /** Its variables, when the file could be read; undefined when it could not, so what it sets is unknown. */
  variables?: Record<string, string>;
}

/** The most an envFile may weigh for mcpcage to read it: a .env file holds a few lines. */
export const MAX_ENV_FILE_BYTES = 1024 * 1024;

/**
 * The file VS Code loads for an entry with an `envFile`, and what it sets; undefined for an entry
 * without one. VS Code adds its variables to the environment it starts the entry with, as it adds
 * those of `env`: once the entry starts mcpcage, they act on the host the same way. An entry with
 * `"envFile": "${workspaceFolder}/.env"` whose .env set NODE_OPTIONS was reported caged, and its
 * preload ran on the host. The file is read as a configuration is (a regular file, without waiting
 * on a FIFO), up to MAX_ENV_FILE_BYTES. Of the variables VS Code fills in, `${workspaceFolder}` is
 * known in a project's own configuration only, and `${userHome}` always: a file named with another,
 * or by a relative path, depends on what the editor has open, and counts as one that could not be
 * read. `configFile` is the configuration that holds the entry.
 */
export function envFileOf(entry: { [field: string]: unknown }, configFile: string): EnvFile | undefined {
  const value = entry.envFile;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return {};
  const file = envFilePath(value, configFile);
  return { path: value, variables: file === undefined ? undefined : readEnvFile(file) };
}

/** The absolute path an `envFile` names, its variables filled in, or undefined when that is not known here. */
function envFilePath(value: string, configFile: string): string | undefined {
  const workspace = workspaceOf(resolve(configFile));
  let known = true;
  const path = value.replace(/\$\{([^}]*)\}/g, (whole, name: string) => {
    if (name === "workspaceFolder" && workspace !== undefined) return workspace;
    if (name === "userHome") return homedir();
    if (name === "/" || name === "pathSeparator") return sep;
    known = false;
    return whole;
  });
  return known && isAbsolute(path) ? path : undefined;
}

/**
 * The folder `${workspaceFolder}` stands for in a project's own configuration: the one that holds its
 * .vscode (or .cursor) directory. ~/.cursor/mcp.json is Cursor's user configuration, whose
 * `${workspaceFolder}` is whichever folder is open.
 */
function workspaceOf(configFile: string): string | undefined {
  const dir = dirname(configFile);
  if (basename(dir) !== ".vscode" && basename(dir) !== ".cursor") return undefined;
  const workspace = dirname(dir);
  return dirKey(workspace) === dirKey(homedir()) ? undefined : workspace;
}

/** The variables of an envFile, or undefined when it cannot be read: not there, not a regular file, too large. */
function readEnvFile(file: string): Record<string, string> | undefined {
  try {
    // Looked at before it is read, so that a large file is not read at all; readConfigFile reads
    // only a regular file, and stops past its own, larger, limit.
    if (statSync(file).size > MAX_ENV_FILE_BYTES) return undefined;
    const bytes = readConfigFile(file);
    return bytes.length > MAX_ENV_FILE_BYTES ? undefined : parseEnvFile(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The variables of a dotenv file, read so that every one VS Code could find is found: blank lines and
 * `#` comments skipped, an `export ` prefix, NAME=value with any name before the first `=` (a
 * BASH_FUNC_name%% too), and `NAME: value` as the dotenv package also reads it. Each line counts on
 * its own, one inside a value quoted over several lines too: a variable too many is a line too many
 * in the report, one too few would act on the host unreported. A value in quotes is what they hold;
 * any other is kept whole, a `#` included, since parsers differ on it: a PATH that one of them would
 * cut is then a directory that is not the user's, rather than the user's PATH. Collected, then made
 * into an object at once, as wrapEntry does (a variable named __proto__).
 */
export function parseEnvFile(text: string): Record<string, string> {
  const variables: Array<[string, string]> = [];
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals > 0) variables.push([line.slice(0, equals).trim(), envValue(line.slice(equals + 1))]);
    const colon = /^([\w.-]+):\s(.*)$/.exec(line);
    if (colon !== null) variables.push([colon[1]!, envValue(colon[2]!)]);
  }
  return Object.fromEntries(variables);
}

/** A value of a dotenv line: what its quotes hold, before a comment at most, or the whole of it. */
function envValue(raw: string): string {
  const value = raw.trim();
  return /^(['"`])(.*?)\1\s*(?:#.*)?$/.exec(value)?.[2] ?? value;
}

/**
 * The file a bare name finds in this process's PATH, as an entry's command is looked up (see onPath):
 * in its absolute directories only, never in the current directory. Undefined when none has it.
 */
export function commandOnPath(name: string): string | undefined {
  const found = onPath(name, process.env.PATH ?? "", false);
  return found === UNKNOWN ? undefined : found;
}

/** The file a command names here, symlinks followed, looked up in this process's PATH; undefined when there is none. */
function realCommand(command: string): string | undefined {
  const found = onPath(command, process.env.PATH ?? "", false);
  return found === undefined || found === UNKNOWN ? undefined : realFile(found);
}

/** The entry point of the running mcpcage (its dist/cli.js), symlinks followed. */
function runningMcpcage(): string | undefined {
  const script = process.argv[1];
  return script === undefined || !isAbsolute(script) ? undefined : realFile(script);
}

/** The file the client starts for an entry, as its spawn finds it. */
function startedBy(entry: { command: string; env?: unknown }): string | typeof UNKNOWN | undefined {
  const path = pathOf(entry.env);
  return path === undefined ? onPath(entry.command, process.env.PATH ?? "", false) : onPath(entry.command, path, true);
}

/**
 * The PATH an entry's `env` sets (names compared without case on Windows, as it compares them), or
 * undefined when it sets none. A value that is not a string is converted by the client's spawn into
 * a directory name nobody chose: what it finds there is not known.
 */
function pathOf(env: unknown): string | typeof UNKNOWN | undefined {
  if (!isJsonObject(env)) return undefined;
  const windows = process.platform === "win32";
  const name = Object.keys(env).find((key) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"));
  if (name === undefined) return undefined;
  const value = env[name];
  return typeof value === "string" ? value : UNKNOWN;
}

/**
 * The file a command names: an absolute path that exists, or a bare name's first match in `path`, as
 * `which` finds it. A relative directory in `path` is skipped in mcpcage's own PATH; in the PATH an
 * entry sets (`strict`), reached before a match, it makes the result unknown.
 */
function onPath(command: string, path: string | typeof UNKNOWN, strict: boolean): string | typeof UNKNOWN | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  // A relative path depends on the directory the client starts it from, which is not known here.
  if (/[/\\]/.test(command)) return UNKNOWN;
  if (path === UNKNOWN) return UNKNOWN;
  const windows = process.platform === "win32";
  const extensions = windows && !/\.[^.]+$/.test(command) ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of path.split(delimiter)) {
    if (!isAbsolute(dir)) {
      if (strict) return UNKNOWN;
      continue;
    }
    for (const extension of extensions) {
      // PATHEXT spells the extensions in capitals, npm and pnpm write mcpcage.cmd: --fix writes this name.
      const file = join(dir, `${command}${extension.toLowerCase()}`);
      try {
        if (!statSync(file).isFile()) continue;
        if (!windows) accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not here, or not a program: on to the next
      }
    }
  }
  return undefined;
}

/**
 * The file, symlinks followed, as the system spells it on disk. On Windows a bare name is found with
 * an extension of PATHEXT, which Windows writes in capitals, and a PATH may hold 8.3 short names
 * (C:\PROGRA~1): realpathSync kept those spellings, and the mcpcage.cmd that `where` names, which is
 * the command --fix writes, was another file than the mcpcage.CMD a bare `mcpcage` found.
 */
function realFile(file: string): string | undefined {
  try {
    return realpathSync.native(file);
  } catch {
    return undefined;
  }
}
