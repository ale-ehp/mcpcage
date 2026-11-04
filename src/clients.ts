import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isJsonObject, parseJsonc } from "./jsonc.js";

export type ClientId = "claude-desktop" | "claude-code" | "cursor" | "vscode" | "copilot" | "windsurf" | "devin";

export interface ConfigLocation {
  client: ClientId;
  clientName: string;
  scope: "user" | "project";
  file: string;
  key: "mcpServers" | "servers";
  /** VS Code files, where comments and trailing commas are allowed. */
  jsonc: boolean;
  exists: boolean;
  /** For ~/.claude.json: the root `mcpServers` and every `projects[path].mcpServers`. */
  nested?: Array<{ path: string[]; label: string }>;
}

export const CLIENT_NAMES: Record<ClientId, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  copilot: "GitHub Copilot CLI",
  windsurf: "Windsurf",
  devin: "Devin",
};

/**
 * Where each client keeps its MCP servers, as the clients' own documentation states it (checked
 * 2026-11-02; Devin's checked 2026-11-03). Absent files are listed too, so a report can say what
 * was looked at.
 */
export function discoverConfigs(options: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; project: string }): ConfigLocation[] {
  const path = options.platform === "win32" ? win32 : posix;
  const project = options.project;
  const user = userConfigs(options);

  const locations: ConfigLocation[] = [];
  const add = (client: ClientId, scope: "user" | "project", file: string, key: "mcpServers" | "servers" = "mcpServers") => {
    // With --project at the home directory, <project>/.cursor/mcp.json is ~/.cursor/mcp.json: list it once.
    if (locations.some((location) => location.file === file)) return;
    locations.push({ client, clientName: CLIENT_NAMES[client], scope, file, key, jsonc: client === "vscode", exists: existsSync(file) });
  };
  const addUser = (client: ClientId) => {
    for (const config of user.filter((config) => config.client === client)) {
      add(client, "user", config.file, config.key);
      // Each named profile has its own mcp.json; only the ones that exist are listed.
      if (client === "vscode") for (const file of profileFiles(path.join(config.dir!, "profiles"), path)) add(client, "user", file, config.key);
    }
  };
  addUser("claude-desktop");
  addUser("claude-code");
  add("claude-code", "project", path.join(project, ".mcp.json"));
  addUser("cursor");
  add("cursor", "project", path.join(project, ".cursor", "mcp.json"));
  addUser("vscode");
  add("vscode", "project", path.join(project, ".vscode", "mcp.json"), "servers");
  addUser("copilot");
  addUser("windsurf");
  addUser("devin");
  add("devin", "project", path.join(project, ".devin", "mcp_config.json"));
  add("devin", "project", path.join(project, ".devin", "mcp_config.local.json"));

  const claudeCode = locations.find((location) => location.client === "claude-code" && location.scope === "user");
  if (claudeCode?.exists) claudeCode.nested = claudeCodeSections(readQuietly(claudeCode.file));
  return locations;
}

/** A client's user file, and the client's own directory when the file is in one. */
export interface UserConfig {
  client: ClientId;
  file: string;
  dir?: string;
  key: "mcpServers" | "servers";
}

/**
 * Each client's user file, where this environment puts it: discoverConfigs reads these, and
 * sensitive.ts counts them and their directories wherever the environment moves them. Nothing is
 * read from the disk. ~/.claude.json has no directory of its own: its directory is the home.
 */
export function userConfigs(options: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv }): UserConfig[] {
  const windows = options.platform === "win32";
  const path = windows ? win32 : posix;
  // The documentation names %USERPROFILE% and %APPDATA% on Windows.
  const home = (windows && options.env.USERPROFILE) || options.home;
  const appData = windows
    ? options.env.APPDATA || path.join(home, "AppData", "Roaming")
    : options.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : path.join(home, ".config");

  const configs: UserConfig[] = [];
  const add = (client: ClientId, dir: string | undefined, file: string, key: "mcpServers" | "servers" = "mcpServers") => {
    configs.push(dir === undefined ? { client, file, key } : { client, file: path.join(dir, file), dir, key });
  };
  add("claude-desktop", path.join(appData, "Claude"), "claude_desktop_config.json");
  add("claude-code", undefined, path.join(home, ".claude.json"));
  add("cursor", path.join(home, ".cursor"), "mcp.json");
  // On Linux VS Code keeps its user data under $XDG_CONFIG_HOME when that is set (userDataPath.ts in
  // VS Code's sources); a relative value is ignored, as the XDG specification says.
  const xdg = options.env.XDG_CONFIG_HOME;
  const vscodeData = options.platform === "linux" && xdg && posix.isAbsolute(xdg) ? xdg : appData;
  for (const product of ["Code", "Code - Insiders"]) add("vscode", path.join(vscodeData, product, "User"), "mcp.json", "servers");
  add("copilot", options.env.COPILOT_HOME || path.join(home, ".copilot"), "mcp-config.json");
  add("windsurf", path.join(home, ".codeium", "windsurf"), "mcp_config.json");
  add("windsurf", path.join(home, ".codeium", "windsurf-next"), "mcp_config.json");
  // Devin keeps its user file under ~/.config on macOS as on Linux, not under Library/Application Support.
  add("devin", path.join(windows ? appData : path.join(home, ".config"), "devin"), "mcp_config.json");
  return configs;
}

/**
 * The places ~/.claude.json keeps servers: the root `mcpServers` (user scope) and one
 * `mcpServers` per project (local scope), in the order the file lists them.
 */
export function claudeCodeSections(config: unknown): Array<{ path: string[]; label: string }> {
  const sections = [{ path: ["mcpServers"], label: "user" }];
  const projects = isJsonObject(config) ? config.projects : undefined;
  if (isJsonObject(projects)) {
    for (const [project, settings] of Object.entries(projects)) {
      if (isJsonObject(settings) && isJsonObject(settings.mcpServers)) {
        sections.push({ path: ["projects", project, "mcpServers"], label: `project ${project}` });
      }
    }
  }
  return sections;
}

/** `<profiles>/<id>/mcp.json` for every VS Code profile that has one, in a stable order. */
function profileFiles(profiles: string, path: typeof posix): string[] {
  let ids: string[];
  try {
    ids = readdirSync(profiles).sort();
  } catch {
    return []; // no profiles yet
  }
  return ids.map((id) => path.join(profiles, id, "mcp.json")).filter((file) => existsSync(file));
}

/** A file that cannot be read or parsed has only its root section; the scan reports the error. */
function readQuietly(file: string): unknown {
  try {
    return parseJsonc(readConfigFile(file).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The most a configuration file may weigh for mcpcage to read it. Real ones stay far below: a
 * ~/.claude.json with years of history keeps a few hundred kilobytes. Anything on the machine may
 * write one, and a file of gigabytes, read whole and parsed, would take mcpcage down with it.
 */
export const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

/**
 * The bytes of a configuration file, its size looked at before anything is read: a file over
 * MAX_CONFIG_BYTES is refused unread, and one that grows past it while it is read is refused too.
 */
export function readConfigFile(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const tooLarge = (size: number) =>
      new Error(`too large to read (${(size / 1024 / 1024).toFixed(1)} MiB; mcpcage reads configuration files up to ${MAX_CONFIG_BYTES / 1024 / 1024} MiB)`);
    const size = fstatSync(fd).size;
    if (size > MAX_CONFIG_BYTES) throw tooLarge(size);
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) {
      total += read;
      if (total > MAX_CONFIG_BYTES) throw tooLarge(total);
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}
