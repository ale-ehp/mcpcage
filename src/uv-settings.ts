import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { readConfigFile } from "./clients.js";
import { isJsonObject } from "./jsonc.js";
import type { UvEnvironment } from "./launch.js";
import { NETWORK_PATH, networkPath } from "./network-path.js";
import { terminalSafe } from "./terminal.js";
import { windowsPlaces, windowsRedirectedAppData } from "./windows-places.js";

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
  /**
   * On Windows, APPDATA and ProgramData as Windows has them (see windowsPlaces): looked at whatever the
   * environment says, the environment's APPDATA too; and `redirected`, the user's AppData\Roaming
   * where folder redirection puts it on a share (see redirectedAppData), the one network path read.
   */
  windows?: { appData?: string; programData?: string; redirected?: string };
}

/** The places of this machine: mcpcage's environment and home directory, and Windows' own places there. */
export function uvPlacesHere(): UvPlaces {
  const places: UvPlaces = { platform: process.platform, env: process.env, home: homedir() };
  if (process.platform === "win32") {
    const windows = windowsPlaces();
    const redirected = windowsRedirectedAppData();
    places.windows = { appData: windows.APPDATA, programData: windows.ProgramData, ...(redirected === undefined ? {} : { redirected }) };
  }
  return places;
}

/**
 * The files uv may read its settings from for a tool command (https://docs.astral.sh/uv/reference/storage/):
 * the one UV_CONFIG_FILE names (relative to the current directory, as uv takes it); on macOS and
 * Linux the user's uv.toml under XDG_CONFIG_HOME, when that is an absolute path, and under
 * ~/.config, then the system's under each directory of XDG_CONFIG_DIRS, under /etc/xdg and under
 * /etc; on Windows the user's under %APPDATA% and the system's under %PROGRAMDATA%, and those the
 * environment's places point to (see SETTINGS_VARIABLES). uv takes the first of the user's that
 * exists, and of the system's; all are looked at, so that a client started without XDG_CONFIG_HOME
 * or XDG_CONFIG_DIRS and a terminal with them are both covered.
 */
export function uvConfigFiles(places: UvPlaces): string[] {
  return settingsPlaces(places).files;
}

/**
 * The files of uvConfigFiles, and the first variable of the environment that points uv to a network
 * path (see networkPath), which is not one of them: never opened, it stops the cage (see
 * uvSettingsReason). The user's AppData\Roaming on a share, as the registry gives it, is read: Windows
 * itself reads it in every program of the session, and the environment's APPDATA is read when it is
 * that folder. Any other network path of the environment is not, the user's own included, because
 * `run` cannot tell the user's variables from an entry's: the client starts it with both in one
 * environment, and an entry's APPDATA on its author's share would get the user's credentials from
 * every start. protect reads the user's environment by the same rule, so that both say the same.
 */
function settingsPlaces(places: UvPlaces): { files: string[]; network?: string } {
  // Every path is read by the rules of the system asked about. On that system's own machine, the
  // only one uv reads these files on, they are the host's rules, with its current directory for a
  // relative UV_CONFIG_FILE, as uv takes it. Read by the host's rules whatever the system, /x/uv.toml
  // became C:\x\uv.toml on Windows when Linux was asked about, and on macOS D:\uv.toml became a
  // name relative to the current directory when Windows was.
  const syntax = places.platform === "win32" ? win32 : posix;
  const redirected = places.windows?.redirected;
  const own = redirected === undefined ? undefined : win32.join(redirected, "uv", "uv.toml").toLowerCase();
  const files: string[] = [];
  let network: string | undefined;
  // The value is tested as well as the files made from it: path.resolve takes \\host, a host without
  // a share, for the root of the current drive, and \\host\uv\uv.toml became C:\host\uv\uv.toml, a
  // local file mcpcage read where uv joins the value as it is and reads the share uv of that host.
  const add = (name: string, value: string, found: string[]) => {
    const fromNetwork = networkPath(value, places.platform);
    for (const file of found) {
      if ((!fromNetwork && !networkPath(file, places.platform)) || (name === "APPDATA" && file.toLowerCase() === own)) files.push(file);
      else network ??= name;
    }
  };
  const pointed = (name: string) => {
    const variable = variableIn(places.env, name, places.platform);
    if (variable !== undefined) add(variable.name, variable.value, settingsFiles(name, variable.value, places.platform));
  };
  const given = variableIn(places.env, "UV_CONFIG_FILE", places.platform);
  if (given !== undefined) add(given.name, given.value, [syntax.resolve(given.value)]);
  if (places.platform === "win32") {
    for (const name of SETTINGS_VARIABLES.win32) pointed(name);
    for (const dir of [places.windows?.appData, places.windows?.programData]) if (dir !== undefined && win32.isAbsolute(dir)) files.push(win32.join(dir, "uv", "uv.toml"));
    if (redirected !== undefined) files.push(win32.join(redirected, "uv", "uv.toml"));
  } else {
    pointed("XDG_CONFIG_HOME");
    pointed("HOME");
    add("HOME", places.home, [posix.join(places.home, ".config", "uv", "uv.toml")]);
    pointed("XDG_CONFIG_DIRS");
    files.push("/etc/xdg/uv/uv.toml", "/etc/uv/uv.toml");
  }
  return { files: [...new Set(files)], ...(network === undefined ? {} : { network }) };
}

/**
 * The variables that tell uv 0.13.7 where its settings are, by system (see settingsFiles). An entry's
 * env, or its envFile, that sets one points uvx at other settings than the user's: they are looked at
 * too (see entryUvSettingsReason), before wrap or --fix drop or move the variable.
 */
const SETTINGS_VARIABLES = {
  win32: ["APPDATA", "USERPROFILE", "SYSTEMDRIVE", "PROGRAMDATA"],
  other: ["XDG_CONFIG_HOME", "HOME", "XDG_CONFIG_DIRS"],
} as const;

/**
 * The uv.toml files a variable of SETTINGS_VARIABLES points uv to, read as uv 0.13.7 reads it (with
 * etcetera 0.11, the crate it locks), a relative path from the current directory. On macOS and Linux
 * the user's file is under XDG_CONFIG_HOME when that is absolute, else under $HOME/.config (etcetera's
 * Xdg strategy, std's home_dir: the HOME variable), and the system's under each directory of
 * XDG_CONFIG_DIRS as it is (uv-dirs, locate_system_config_xdg: XDG_CONFIG_DIRS=conf made uv read
 * conf/uv/uv.toml of its current directory; it reads /etc/xdg when the variable is unset or empty, as
 * on most machines). On Windows the user's is under the APPDATA variable, which folder redirection
 * sets to a share or to a folder named after the user, else under the folder Windows gives, else
 * under USERPROFILE's AppData\Roaming (etcetera's Windows strategy); the system's under
 * %SYSTEMDRIVE%\ProgramData (uv-dirs, locate_system_config_windows). PROGRAMDATA is where Windows
 * says that folder is: looked at too, which can only leave a server uncaged. UV_CONFIG_FILE names the
 * file itself, from the current directory when relative, as uv takes it.
 */
function settingsFiles(name: string, value: string, platform: NodeJS.Platform): string[] {
  if (name === "UV_CONFIG_FILE") return [(platform === "win32" ? win32 : posix).resolve(value)];
  if (platform === "win32") {
    if (name === "APPDATA" || name === "PROGRAMDATA") return [win32.resolve(value, "uv", "uv.toml")];
    if (name === "USERPROFILE") return [win32.resolve(value, "AppData", "Roaming", "uv", "uv.toml")];
    // uv writes `{SYSTEMDRIVE}\` before joining: C: becomes C:\, the drive's root, not its current directory.
    if (name === "SYSTEMDRIVE") return [win32.resolve(`${value}\\`, "ProgramData", "uv", "uv.toml")];
    return [];
  }
  if (name === "XDG_CONFIG_HOME") return posix.isAbsolute(value) ? [posix.join(value, "uv", "uv.toml")] : [];
  if (name === "HOME") return [posix.resolve(value, ".config", "uv", "uv.toml")];
  if (name === "XDG_CONFIG_DIRS") return [...new Set(value.split(":").filter((dir) => dir !== ""))].map((dir) => posix.resolve(dir, "uv", "uv.toml"));
  return [];
}

/** A variable of `env`, compared without case on Windows, as uv's reads of them are there, with its name as written; undefined when it is not set, empty, or not a string. */
function variableIn(env: Readonly<Record<string, unknown>>, name: string, platform: NodeJS.Platform): { name: string; value: string } | undefined {
  const written = platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === name) : Object.hasOwn(env, name) ? name : undefined;
  const value = written === undefined ? undefined : env[written];
  return written !== undefined && typeof value === "string" && value !== "" ? { name: written, value } : undefined;
}

/**
 * The settings of uv.toml that choose where packages come from (an [[index]] table, or one of these
 * keys). With torch-backend = "cpu", uv 0.13.7 asked download.pytorch.org for torch, as with
 * --torch-backend, which the cage refuses.
 */
const INDEX_KEYS = ["index", "index-url", "extra-index-url", "default-index", "find-links", "no-index", "index-strategy", "keyring-provider", "torch-backend"];

/**
 * The other keys of uv.toml that change what uvx installs, with what uvx does with each, as their
 * variables and flags do (see UV_REFUSED and UVX_FLAGS in launch.ts): the cage resolves without the
 * user's settings, so an entry is not caged while they set one. Each run with `uv tool run` 0.13.7 in
 * its image: resolution = "lowest" installed idna 2.0 for idna>=2 (3.20 without it); exclude-newer,
 * and exclude-newer-package for idna, of 2020-01-01 idna 2.8; prerelease = "allow" httpx 1.0.dev6
 * (0.28.1 without it), and prerelease-package = { httpx = "allow" } the same for httpx alone (a key
 * of uv.toml whose flag, --prerelease-package, uvx is refused with as unsupported); a
 * [[dependency-metadata]] entry giving idna 3.10 requires-dist six installed
 * six with it; no-binary = true, and no-binary-package = ["idna"], chose idna-3.10.tar.gz over its
 * wheel. A value that is uv's default (resolution = "highest") counts too: a false positive leaves a
 * server uncaged, with the reason.
 */
const OTHER_VERSIONS = "uvx installs other versions there than the cage builds";
const FROM_SOURCE = "uvx builds packages from source there, and the cage installs PyPI wheels only";
const INSTALL_KEYS: ReadonlyMap<string, string> = new Map([
  ["resolution", "uvx chooses other versions there than the newest, which the cage installs"],
  ["prerelease", OTHER_VERSIONS],
  ["prerelease-package", OTHER_VERSIONS],
  ["exclude-newer", OTHER_VERSIONS],
  ["exclude-newer-package", OTHER_VERSIONS],
  ["dependency-metadata", "uvx installs other dependencies there than the cage builds"],
  ["no-binary", FROM_SOURCE],
  ["no-binary-package", FROM_SOURCE],
  // As UV_INSECURE_HOST and --allow-insecure-host, which are refused: uv 0.13.7 put the host of
  // allow-insecure-host = ["pypi.org"] in its allow_insecure_host (`uv tool run --show-settings`).
  ["allow-insecure-host", "uvx turns off certificate checks for a host there, which only another index or a proxy needs"],
]);

/**
 * A scan of the text of a uv.toml for the first of `keys` it sets, or opens as a table ([[index]],
 * [[dependency-metadata]], [exclude-newer-package]), under any table and as a dotted or quoted key
 * too, or as the first part of a dotted key: uv 0.13.7 read `exclude-newer-package.idna = <date>` as
 * exclude-newer-package = { idna = <date> }, which the scan, looking for an = after the name, did not
 * find. Strings are read first, so that a # or a key's name inside a value is neither a comment nor a
 * key; a quoted key keeps its name, its escapes decoded as uv decodes them (see unescaped); what
 * follows a # outside a string is a comment. Keys of [pip], which uvx does not read, count too: a
 * false positive leaves a server uncaged, with the reason.
 */
function scanFor(keys: readonly string[]): (text: string) => string | undefined {
  const names = keys.join("|");
  const key = new RegExp(`(?:^|[\\s{,.])(${names})\\s*[=.]`);
  const table = new RegExp(`^\\s*\\[{1,2}\\s*(?:[A-Za-z0-9_-]+\\s*\\.\\s*)*(${names})\\s*\\]{1,2}`);
  return (text) => {
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
        const inner = character === '"' ? unescaped(raw.slice(at + 1, end)) : raw.slice(at + 1, end);
        line += keys.includes(inner) ? inner : "_";
        at = end;
      }
      const found = table.exec(line) ?? key.exec(line);
      if (found !== null) return found[1];
    }
    return undefined;
  };
}

const indexKeyIn = scanFor(INDEX_KEYS);
const stoppingKeyIn = scanFor([...INDEX_KEYS, ...INSTALL_KEYS.keys()]);

/** Whether the text of a uv.toml names a package index: an [[index]] table, or one of INDEX_KEYS (see scanFor). `no-index = false` counts too. */
export function namesIndex(text: string): boolean {
  return indexKeyIn(text) !== undefined;
}

/**
 * What the text of a uv.toml sets that keeps the cage from building what uvx installs, in words that
 * follow the file's name: that it names a package index, or the first key of INSTALL_KEYS it sets and
 * what uvx does with it. Undefined when it sets none.
 */
export function settingThatStops(text: string): string | undefined {
  const key = stoppingKeyIn(text);
  if (key === undefined) return undefined;
  return INDEX_KEYS.includes(key) ? "name a package index, and the cage builds from PyPI only" : `set ${key}: ${INSTALL_KEYS.get(key)!}`;
}

/** The one-letter escapes of a TOML basic string, TOML 1.1's \e among them. */
const ONE_LETTER: Readonly<Record<string, string>> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };

/**
 * The text of a TOML basic string (between double quotes) with its escapes decoded, as uv's TOML
 * parser reads it: uv 0.13.7 took "index\u002Durl", "index\U0000002Durl" and "index\x2Durl" for
 * index-url, and [["ind\u0065x"]] for [[index]], and asked the index they named for the server. The
 * scan compared the raw text, and found none of them. An escape TOML does not have is left as it is:
 * uv 0.13.7 refuses the whole file for it ("missing escaped value"), so it installs nothing from it.
 */
function unescaped(text: string): string {
  return text.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|(.))/gs, (whole, four?: string, eight?: string, two?: string, letter?: string) => {
    const hex = four ?? eight ?? two;
    if (hex === undefined) return ONE_LETTER[letter!] ?? whole;
    const code = Number.parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Why the user's uv settings stop the cage, in words that name the file: the first of uvConfigFiles
 * that names an index, or that is there and could not be read (too large, not a regular file, not
 * readable), whose settings are then unknown. Undefined when none does.
 */
export function uvSettingsReason(places: UvPlaces = uvPlacesHere()): string | undefined {
  const { files, network } = settingsPlaces(places);
  if (network !== undefined) return `your environment sets ${network} to ${NETWORK_PATH}, and the cage builds from PyPI only`;
  for (const file of files) {
    const found = readSettings(file);
    const what = `your uv settings (${shown(file, places.home, places.platform)})`;
    if (found === "unreadable") return `${what} could not be read, so whether they name a package index is unknown, and the cage builds from PyPI only`;
    if (found !== undefined) return `${what} ${found.says}`;
  }
  return undefined;
}

/**
 * Why the uv settings a uvx entry's own variables point uvx to stop the cage: an env, or an envFile,
 * that sets one of SETTINGS_VARIABLES makes uvx read the uv.toml there (see settingsFiles), which the
 * user's own settings are not, and wrap and --fix drop or move the variable as they cage the entry: an
 * env HOME whose .config/uv/uv.toml named an index was dropped, protect then called the entry caged,
 * and the cage built the same names from PyPI. The reason names the variable and the file. The user's
 * own environment (`own`) is left out: uvSettingsReason looks at the places it gives. A caged
 * entry's UV_CONFIG_FILE is looked at too, as `run` looks at it (see UvEnvironment); an entry's not
 * caged yet is refused before (see parseLaunch). Every variable of every layer is looked at, one a
 * later layer sets again too, which can only leave a server uncaged. Undefined when none stops it.
 */
export function entryUvSettingsReason(environment: UvEnvironment, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | undefined {
  for (const layer of environment) {
    if (layer.own === true || !isJsonObject(layer.variables)) continue;
    for (const name of [...(layer.caged === true ? ["UV_CONFIG_FILE"] : []), ...(platform === "win32" ? SETTINGS_VARIABLES.win32 : SETTINGS_VARIABLES.other)]) {
      const variable = variableIn(layer.variables, name, platform);
      if (variable === undefined) continue;
      for (const file of settingsFiles(name, variable.value, platform)) {
        // Never from an entry: its author's share would get the user's credentials (see networkPath, and
        // settingsPlaces), a host without a share (\\host) included, which path.resolve makes a local path.
        if (networkPath(variable.value, platform) || networkPath(file, platform)) return `${layer.where} sets ${variable.name} to ${NETWORK_PATH}, and the cage builds from PyPI only`;
        const found = readSettings(file);
        const what = `${layer.where} sets ${variable.name}, so uvx reads the uv settings in ${shown(file, home, platform)}`;
        if (found === "unreadable") return `${what}, which could not be read: whether they name a package index is unknown, and the cage builds from PyPI only`;
        if (found !== undefined) return `${what}, which ${found.says}`;
      }
    }
  }
  return undefined;
}

/**
 * What a uv.toml sets that stops the cage (see settingThatStops), "unreadable" when it is there and
 * could not be read (too large, not a regular file, not readable), so its settings are unknown;
 * undefined when it is not there or sets nothing of the kind.
 */
function readSettings(file: string): { says: string } | "unreadable" | undefined {
  let text: string;
  try {
    text = readConfigFile(file).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    return "unreadable";
  }
  const says = settingThatStops(text);
  return says === undefined ? undefined : { says };
}

/** A file in the home directory written from ~, safe to print. */
function shown(file: string, home: string, platform: NodeJS.Platform): string {
  const syntax = platform === "win32" ? win32 : posix;
  const base = home.replace(/[\\/]+$/, "");
  const inside = base !== "" && (file === base || file.startsWith(`${base}${syntax.sep}`));
  return terminalSafe(inside ? `~${file.slice(base.length)}` : file);
}
