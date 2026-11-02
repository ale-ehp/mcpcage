import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isJsonObject, parseJsonc } from "./jsonc.js";

export type ClientId = "claude-desktop" | "claude-code" | "cursor" | "vscode" | "copilot" | "windsurf";

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
};

/**
 * Where each client keeps its MCP servers, as the clients' own documentation states it (checked
 * 2026-11-02). Absent files are listed too, so a report can say what was looked at.
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
  add("vscode", "user", path.join(appData, "Code", "User", "mcp.json"), "servers");
  add("vscode", "user", path.join(appData, "Code - Insiders", "User", "mcp.json"), "servers");
  add("vscode", "project", path.join(project, ".vscode", "mcp.json"), "servers");
  add("copilot", "user", path.join(options.env.COPILOT_HOME || path.join(home, ".copilot"), "mcp-config.json"));
  add("windsurf", "user", path.join(home, ".codeium", "windsurf", "mcp_config.json"));
  add("windsurf", "user", path.join(home, ".codeium", "windsurf-next", "mcp_config.json"));

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

/** A file that cannot be read or parsed has only its root section; the scan reports the error. */
function readQuietly(file: string): unknown {
  try {
    return parseJsonc(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
