#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
// Reports what a server can reach from where it runs. Under mcpcage every answer should be "no".
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

// Whether a new file can be created in `dir`. The name is random and an existing file is never
// written through, so nothing placed there in advance can catch the write; the file is removed after.
function canWrite(dir) {
  const file = join(dir, `probe-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(file, "probe", { flag: "wx" });
  } catch (error) {
    return error.code;
  }
  rmSync(file, { force: true });
  return true;
}

async function network() {
  try {
    const response = await fetch("https://example.com", { signal: AbortSignal.timeout(4000) });
    return `reachable (HTTP ${response.status})`;
  } catch (error) {
    return `blocked (${error.cause?.code ?? error.name})`;
  }
}

const server = new McpServer({ name: "mcpcage-probe", version: "1.0.0" });
server.registerTool("probe", { description: "Report the user, filesystem, network and environment this server can see." }, async () => {
  const report = {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    hostname: hostname(),
    home: homedir(),
    args: process.argv.slice(2),
    env: Object.keys(process.env).sort(),
    writeOwnCode: canWrite(here),
    writeTmp: canWrite("/tmp"),
    hostUsersDirVisible: existsSync("/Users"),
    postinstallRan: existsSync(join(here, "postinstall-ran")),
    network: await network(),
  };
  return { content: [{ type: "text", text: JSON.stringify(report) }] };
});

await server.connect(new StdioServerTransport());
