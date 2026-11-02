import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const cli = join(root, "dist", "cli.js");
export const fakeServer = join(root, "test", "fixtures", "fake-server.mjs");

export function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "mcpcage-test-"));
}

/** Connects a real MCP client to `mcpcage run <runArgs> -- <server>`, like Claude or Cursor would. */
export async function connect(options: { home: string; runArgs: string[]; server: string[]; env?: Record<string, string> }) {
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
  const client = new Client({ name: "mcpcage-test", version: "0.0.0" });
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

export function mcpcage(home: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, MCPCAGE_HOME: home } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
