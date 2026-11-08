// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
// A bare JSON-RPC server, no SDK, to check what mcpcage's own MCP client does (src/inspect.ts):
// it prints a log line first, asks the client for a ping, and serves tools/list in two pages.
// Any step out of order is answered with an error, so the test sees it. RAW_MODE=error breaks tools/list.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const state = { initialized: false, pinged: false };

console.log("raw server starting"); // noise on stdout, which a client must ignore
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const { protocolVersion, clientInfo } = message.params;
    if (protocolVersion !== "2025-06-18" || clientInfo?.name !== "mcpcage") {
      send({ id: message.id, error: { code: -32602, message: `unexpected initialize ${JSON.stringify(message.params)}` } });
      return;
    }
    send({ id: message.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "raw", version: "1.0.0" } } });
    send({ id: "ping-1", method: "ping" });
  } else if (message.method === "notifications/initialized") {
    state.initialized = true;
  } else if (message.id === "ping-1") {
    state.pinged = message.result !== undefined;
  } else if (message.method === "tools/list") {
    const problem = process.env.RAW_MODE === "error" ? "tools are broken" : !state.initialized ? "tools/list before notifications/initialized" : undefined;
    if (problem) send({ id: message.id, error: { code: -32603, message: problem } });
    else if (message.params?.cursor === undefined) send({ id: message.id, result: { tools: [{ name: "first", description: "Page one." }], nextCursor: "page-2" } });
    else if (!state.pinged) send({ id: message.id, error: { code: -32603, message: "the client never answered the ping" } });
    else send({ id: message.id, result: { tools: [{ name: "second", description: "Page two." }] } });
  }
});
