import { posix } from "node:path";

/*
 * Paths mcpcage never looks at (stat, realpath, exists, open, read, readdir) when a configuration
 * entry names them, or mcpcage derives them from what it names: looking at one reaches another
 * machine. On Windows a path that starts with two slashes or backslashes, in any mix, names a share
 * (\\server\share, //server/share, \\?\UNC\server\share) or a device (\\.\pipe\..., \\?\C:\...,
 * which no entry needs, refused too): Windows resolves a share by connecting to its server, and
 * authenticates with the credentials of the user's session (NTLM). Checked on Windows 10 21H2 with
 * a share on another machine of the network: envFileOf given an envFile there, mcpcageAt given a
 * command there, and a plain fs.statSync of such a path each opened TCP connections to its port 445.
 * So an entry that names a path on its author's host, in a cloned repository's .vscode/mcp.json or
 * written by any program, handed that host the user's NTLM response as soon as `mcpcage protect`
 * read it. On macOS /net/<host> is the automounter's -hosts map where it is turned on (its line in
 * /etc/auto_master is commented out on macOS 15.6.1): looking there mounts that host over NFS. A
 * symlink or a junction on a local disk that points at a share is not seen by this test of the
 * path's text, which is all that can be known without looking.
 */

/** Why mcpcage leaves such a path alone, in words that follow its field: "its envFile is a network path, which mcpcage does not open". */
export const NETWORK_PATH = "a network path, which mcpcage does not open";

/**
 * Whether looking at `path` on `platform` may reach another machine (see above): on Windows any
 * path that starts with two slashes or backslashes, on macOS one under /net/<host>, after `.`, `..`
 * and repeated slashes are taken out as the system takes them, and without case, as APFS compares
 * names. Never on Linux, which has no such default. A path is tested as mcpcage would hand it to
 * the system: after the variables mcpcage fills in, and before anything looks at it.
 */
export function networkPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return /^[\\/]{2}/.test(path);
  if (platform === "darwin") return /^\/net\/[^/]/i.test(posix.resolve("/", path));
  return false;
}
