import { homedir } from "node:os";
import { join } from "node:path";

/** Root of everything mcpcage stores. MCPCAGE_HOME overrides it (tests, CI, shared machines). */
export function cageHome(): string {
  return process.env.MCPCAGE_HOME ?? join(homedir(), ".mcpcage");
}

export function serverDir(serverId: string): string {
  return join(cageHome(), "servers", serverId);
}

export function auditDir(serverId: string): string {
  return join(cageHome(), "audit", serverId);
}
