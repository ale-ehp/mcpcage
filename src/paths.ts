import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Root of everything mcpcage stores. MCPCAGE_HOME overrides it (tests, CI, shared machines). */
export function cageHome(): string {
  return process.env.MCPCAGE_HOME ?? join(homedir(), ".mcpcage");
}

// A server id names a directory of the store. One given on the command line was used as given, so
// `--id ../../x` read and wrote pins, pending definitions and audit logs outside the store.
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `id`, when it can be a server id; otherwise a plain error, prefixed with `option` (`--id`) when given. */
export function checkServerId(id: string, option?: string): string {
  if (SERVER_ID.test(id)) return id;
  throw new Error(`${option === undefined ? "" : `${option}: `}${JSON.stringify(id)} is not a valid server id: use letters, digits, dots, dashes and underscores`);
}

export function serverDir(serverId: string): string {
  return inStore("servers", serverId);
}

export function auditDir(serverId: string): string {
  return inStore("audit", serverId);
}

/**
 * `<store>/<area>/<serverId>`, refused unless it is inside `<store>/<area>`: a second line of defense
 * behind checkServerId, for an id that reaches the store some other way.
 */
function inStore(area: string, serverId: string): string {
  const parent = join(cageHome(), area);
  const dir = join(parent, serverId);
  const path = relative(resolve(parent), resolve(dir));
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`the server id ${JSON.stringify(serverId)} leads outside mcpcage's store (${parent})`);
  }
  return dir;
}
