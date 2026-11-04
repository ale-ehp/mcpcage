import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { vi } from "vitest";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const cli = join(root, "dist", "cli.js");
export const fakeServer = join(root, "test", "fixtures", "fake-server.mjs");
export const hostileServer = join(root, "test", "fixtures", "hostile-server.mjs");

/** A path written with `/`, as this system writes it: mcpcage shows ~/.ssh as ~\.ssh on Windows. */
export function native(path: string): string {
  return path.split("/").join(sep);
}

/** `text` in a regular expression, matched as it is: a Windows path is full of backslashes. */
export function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "mcpcage-test-"));
}

/**
 * Connects a real MCP client to `mcpcage run <runArgs> -- <server>`, like Claude or Cursor would. Pass
 * `client` to connect one with its own capabilities and handlers.
 */
export async function connect(options: { home: string; runArgs: string[]; server: string[]; env?: Record<string, string>; client?: Client }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "run", ...options.runArgs, "--", ...options.server],
    env: { ...(process.env as Record<string, string>), MCPCAGE_HOME: options.home, ...options.env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = options.client ?? new Client({ name: "mcpcage-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

/** Starts the fake notes server on the host (--no-sandbox) under a fixed id. */
export function connectFake(home: string, variant: string, extra: string[] = []) {
  return connect({
    home,
    runArgs: ["--no-sandbox", "--id", "notes", ...extra],
    server: [process.execPath, fakeServer],
    env: { FAKE_VARIANT: variant },
  });
}

/** Starts test/fixtures/hostile-server.mjs in the given mode on the host (--no-sandbox), under the id "hostile". */
export function connectHostile(home: string, mode: string, options: { runArgs?: string[]; client?: Client } = {}) {
  return connect({
    home,
    runArgs: ["--no-sandbox", "--id", "hostile", ...(options.runArgs ?? [])],
    server: [process.execPath, hostileServer, mode],
    client: options.client,
  });
}

export function mcpcage(home: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, MCPCAGE_HOME: home } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The environment of a user whose home directory is `home`, with mcpcage's data in `cage`. Variables
 * that would point the CLI at this machine's real client configurations are left out. On Windows the
 * home directory is USERPROFILE, which os.homedir() reads instead of HOME, and the clients keep their
 * files under APPDATA: without them the CLI scanned the real profile of whoever ran the tests.
 */
export function fakeUserEnv(home: string, cage: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["COPILOT_HOME", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "XDG_CONFIG_HOME"]) delete env[name];
  return { ...env, HOME: home, ...windowsHome(home), MCPCAGE_HOME: cage, ...extra };
}

/** The variables Windows sets for a user whose home directory is `home`; none elsewhere. */
export function windowsHome(home: string): Record<string, string> {
  if (process.platform !== "win32") return {};
  return { USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
}

/** Makes `home` the home directory of this process, as fakeUserEnv does for the CLI; vi.unstubAllEnvs() undoes it. */
export function stubHome(home: string): void {
  vi.stubEnv("HOME", home);
  for (const [name, value] of Object.entries(windowsHome(home))) vi.stubEnv(name, value);
}

/** Runs the CLI with exactly this environment (see fakeUserEnv). */
export function mcpcageWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
