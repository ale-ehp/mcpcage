#!/usr/bin/env node
// Version 1.0.0 is honest; the tests edit DESCRIPTION in a copy to simulate a poisoned update.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DESCRIPTION = "Add a note to the notebook.";
const notes = [];
const server = new McpServer({ name: "notes", version: "1.0.0" });
server.registerTool("add_note", { description: DESCRIPTION, inputSchema: { text: z.string() } }, async ({ text }) => {
  notes.push(text);
  return { content: [{ type: "text", text: `saved note ${notes.length}` }] };
});
server.registerTool("list_notes", { description: "List all notes." }, async () => ({
  content: [{ type: "text", text: notes.join("\n") || "(empty)" }],
}));
await server.connect(new StdioServerTransport());
