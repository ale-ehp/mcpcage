import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { isJsonObject } from "./jsonc.js";
import { clientPlaces } from "./sensitive.js";

/*
 * Whether a wrapped entry starts mcpcage, or another program that only has its name. Anyone who can
 * write a file can name it mcpcage, and put a package.json that says "mcpcage" next to it: a
 * look-alike with one was reported caged, and left alone by --fix, while it ran on the host. Only two
 * files are known to be mcpcage: the command `wrap` and `protect --fix` write into configurations,
 * and the mcpcage that is running now. And what else the entry's own `env` decides on the host for
 * the mcpcage it starts: the programs its PATH picks, and the places `run` refuses to mount.
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

/** A directory as it resolves, symlinks followed, without case on macOS and Windows. */
function dirKey(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
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
      const file = join(dir, `${command}${extension}`);
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

function realFile(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}
