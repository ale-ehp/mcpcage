import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const CLIENT_NAMES: Record<ClientId, string> = {
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
  const windows = options.platform === "win32";
  const path = windows ? win32 : posix;
  // The documentation names %USERPROFILE% and %APPDATA% on Windows.
  const home = (windows && options.env.USERPROFILE) || options.home;
  const appData = windows
    ? options.env.APPDATA || path.join(home, "AppData", "Roaming")
    : options.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : path.join(home, ".config");
  const project = options.project;

  const locations: ConfigLocation[] = [];
  const add = (client: ClientId, scope: "user" | "project", file: string, key: "mcpServers" | "servers" = "mcpServers") => {
    // With --project at the home directory, <project>/.cursor/mcp.json is ~/.cursor/mcp.json: list it once.
    if (locations.some((location) => location.file === file)) return;
    locations.push({ client, clientName: CLIENT_NAMES[client], scope, file, key, jsonc: client === "vscode", exists: existsSync(file) });
  };
  add("claude-desktop", "user", path.join(appData, "Claude", "claude_desktop_config.json"));
  add("claude-code", "user", path.join(home, ".claude.json"));
  add("claude-code", "project", path.join(project, ".mcp.json"));
  add("cursor", "user", path.join(home, ".cursor", "mcp.json"));
  add("cursor", "project", path.join(project, ".cursor", "mcp.json"));
  // On Linux VS Code keeps its user data under $XDG_CONFIG_HOME when that is set (userDataPath.ts in
  // VS Code's sources); a relative value is ignored, as the XDG specification says.
  const xdg = options.env.XDG_CONFIG_HOME;
  const vscodeData = options.platform === "linux" && xdg && posix.isAbsolute(xdg) ? xdg : appData;
  for (const product of ["Code", "Code - Insiders"]) {
    const user = path.join(vscodeData, product, "User");
    add("vscode", "user", path.join(user, "mcp.json"), "servers");
    // Each named profile has its own mcp.json; only the ones that exist are listed.
    for (const file of profileFiles(path.join(user, "profiles"), path)) add("vscode", "user", file, "servers");
  }
  add("vscode", "project", path.join(project, ".vscode", "mcp.json"), "servers");
  add("copilot", "user", path.join(options.env.COPILOT_HOME || path.join(home, ".copilot"), "mcp-config.json"));
  add("windsurf", "user", path.join(home, ".codeium", "windsurf", "mcp_config.json"));
  add("windsurf", "user", path.join(home, ".codeium", "windsurf-next", "mcp_config.json"));
  // Devin keeps its user file under ~/.config on macOS as on Linux, not under Library/Application Support.
  add("devin", "user", path.join(windows ? appData : path.join(home, ".config"), "devin", "mcp_config.json"));
  add("devin", "project", path.join(project, ".devin", "mcp_config.json"));
  add("devin", "project", path.join(project, ".devin", "mcp_config.local.json"));

  const claudeCode = locations.find((location) => location.client === "claude-code" && location.scope === "user");
  if (claudeCode?.exists) claudeCode.nested = claudeCodeSections(readQuietly(claudeCode.file));
  return locations;
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
    return parseJsonc(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
