import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { readConfigFile } from "./clients.js";
import { terminalSafe } from "./terminal.js";
import { windowsPlaces } from "./windows-places.js";

/*
 * uvx reads the user's own uv settings, which can name a package index: then it installs a server
 * and its dependencies from there, and the cage, which builds from PyPI only, would build packages
 * of the same names from PyPI instead, a dependency confusion the user did not ask for. So a uvx
 * server is not caged while those settings name an index (DESIGN Q7): protect says why, wrap and
 * --fix leave the entry as it is, and `run` refuses to start it. For tool commands uv reads the
 * user-level and the system-level uv.toml only, never a project's ("For tool commands, which operate
 * at the user level, local configuration files will be ignored", https://docs.astral.sh/uv/concepts/configuration-files/),
 * or the one file UV_CONFIG_FILE names, in place of both. mcpcage never runs uv on the host, and has
 * no TOML parser: a line scan is enough, since a false positive only leaves a server uncaged, with
 * the reason.
 */

/** Where to look for uv's settings: the user's environment, home directory and, on Windows, Windows' own places. */
export interface UvPlaces {
  platform: NodeJS.Platform;
  /** The user's own environment: protect's and wrap's, run in the user's terminal, or what `run` was started with. */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** On Windows, APPDATA and ProgramData as Windows has them (see windowsPlaces), never as an environment says. */
  windows?: { appData?: string; programData?: string };
}

/** The places of this machine: mcpcage's environment and home directory, and Windows' own places there. */
export function uvPlacesHere(): UvPlaces {
  const places: UvPlaces = { platform: process.platform, env: process.env, home: homedir() };
  if (process.platform === "win32") {
    const windows = windowsPlaces();
    places.windows = { appData: windows.APPDATA, programData: windows.ProgramData };
  }
  return places;
}

/**
 * The files uv may read its settings from for a tool command (https://docs.astral.sh/uv/reference/storage/):
 * the one UV_CONFIG_FILE names (relative to the current directory, as uv takes it); on macOS and
 * Linux the user's uv.toml under XDG_CONFIG_HOME, when that is an absolute path, and under
 * ~/.config, then the system's under each absolute directory of XDG_CONFIG_DIRS and /etc; on Windows
 * the user's under %APPDATA% and the system's under %PROGRAMDATA%. uv takes the first of the user's
 * that exists, and of the system's; all are looked at, so that a client started without XDG_CONFIG_HOME
 * and a terminal with it are both covered.
 */
export function uvConfigFiles(places: UvPlaces): string[] {
  const files: string[] = [];
  const given = places.env.UV_CONFIG_FILE;
  if (given !== undefined && given !== "") files.push(resolve(given));
  if (places.platform === "win32") {
    for (const dir of [places.windows?.appData, places.windows?.programData]) if (dir !== undefined && win32.isAbsolute(dir)) files.push(win32.join(dir, "uv", "uv.toml"));
    return files;
  }
  const xdg = places.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && posix.isAbsolute(xdg)) files.push(posix.join(xdg, "uv", "uv.toml"));
  files.push(posix.join(places.home, ".config", "uv", "uv.toml"));
  for (const dir of (places.env.XDG_CONFIG_DIRS ?? "").split(":")) if (posix.isAbsolute(dir)) files.push(posix.join(dir, "uv", "uv.toml"));
  files.push("/etc/uv/uv.toml");
  return [...new Set(files)];
}

/** The settings of uv.toml that choose where packages come from (an [[index]] table, or one of these keys). */
const INDEX_KEYS = ["index", "index-url", "extra-index-url", "default-index", "find-links", "no-index", "index-strategy", "keyring-provider"];
const INDEX_KEY = new RegExp(`(?:^|[\\s{,.])(?:${INDEX_KEYS.join("|")})\\s*=`);
const INDEX_TABLE = /^\s*\[{1,2}\s*(?:[A-Za-z0-9_-]+\s*\.\s*)*index\s*\]{1,2}/;

/**
 * Whether the text of a uv.toml names a package index: a line that opens an [[index]] table, or sets
 * one of INDEX_KEYS, under any table and as a dotted or quoted key too. Strings are read first, so
 * that a # or a key's name inside a value is neither a comment nor a key; a quoted key keeps its
 * name; what follows a # outside a string is a comment. `no-index = false` and the keys of [pip],
 * which uvx does not read, count too: a false positive leaves a server uncaged, with the reason.
 */
export function namesIndex(text: string): boolean {
  for (const raw of text.split(/\r?\n/)) {
    let line = "";
    for (let at = 0; at < raw.length; at++) {
      const character = raw[at]!;
      if (character === "#") break;
      if (character !== '"' && character !== "'") {
        line += character;
        continue;
      }
      let end = at + 1;
      while (end < raw.length && raw[end] !== character) end += character === '"' && raw[end] === "\\" ? 2 : 1;
      const inner = raw.slice(at + 1, end);
      line += INDEX_KEYS.includes(inner) ? inner : "_";
      at = end;
    }
    if (INDEX_TABLE.test(line) || INDEX_KEY.test(line)) return true;
  }
  return false;
}

/**
 * Why the user's uv settings stop the cage, in words that name the file: the first of uvConfigFiles
 * that names an index, or that is there and could not be read (too large, not a regular file, not
 * readable), whose settings are then unknown. Undefined when none does.
 */
export function uvSettingsReason(places: UvPlaces = uvPlacesHere()): string | undefined {
  for (const file of uvConfigFiles(places)) {
    let text: string;
    try {
      text = readConfigFile(file).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      return `your uv settings (${shown(file, places)}) could not be read, so whether they name a package index is unknown, and the cage builds from PyPI only`;
    }
    if (namesIndex(text)) return `your uv settings (${shown(file, places)}) name a package index, and the cage builds from PyPI only`;
  }
  return undefined;
}

/** A file in the home directory written from ~, safe to print. */
function shown(file: string, places: UvPlaces): string {
  const syntax = places.platform === "win32" ? win32 : posix;
  const home = places.home.replace(/[\\/]+$/, "");
  const inside = home !== "" && (file === home || file.startsWith(`${home}${syntax.sep}`));
  return terminalSafe(inside ? `~${file.slice(home.length)}` : file);
}
