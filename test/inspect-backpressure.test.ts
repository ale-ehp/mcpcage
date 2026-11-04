import { describe, expect, it, vi } from "vitest";
import { listTools } from "../src/inspect.js";
import { MAX_LINE_BYTES } from "../src/lines.js";
import { hostileServer } from "./helpers.js";

// The inspection runs in this process, so the server it starts can be looked at: spawn is wrapped to
// note, after every write to the server's stdin, how much of it is still waiting in mcpcage's memory.
const stdin = vi.hoisted(() => ({ largest: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args);
    const input = child.stdin!;
    const write = input.write;
    input.write = function (this: typeof input, ...chunk: unknown[]) {
      const accepted = (write as (...chunk: unknown[]) => boolean).apply(this, chunk);
      stdin.largest = Math.max(stdin.largest, input.writableLength);
      return accepted;
    } as typeof input.write;
    return child;
  }) as typeof original.spawn;
  return { ...original, spawn };
});

describe("inspecting a server that sends requests and never reads", () => {
  it("queues no answer while a line's worth is waiting, and still ends with its timeout", async () => {
    // 64 pings with ids of 1 MiB: answered all, 64 MiB would wait in mcpcage's memory.
    await expect(listTools(process.execPath, [hostileServer, "ping-flood"], process.env, 5_000)).rejects.toThrow(
      "the server did not answer within 5 s: hostile-server sent 64 pings",
    );
    const answer = Buffer.byteLength(`${JSON.stringify({ jsonrpc: "2.0", id: "0".padEnd(1024 * 1024, "x"), result: {} })}\n`);
    expect(stdin.largest).toBeLessThanOrEqual(MAX_LINE_BYTES + answer);
    expect(stdin.largest).toBeGreaterThanOrEqual(MAX_LINE_BYTES); // the limit was reached: the pings were read
  });
});

describe("inspecting a server whose listing never ends", () => {
  it("asks for no next page while a line's worth is waiting, and says the server does not read", async () => {
    stdin.largest = 0;
    // It never reads, and needs not: mcpcage's ids are predictable. It answers initialize, then
    // requests 2 to 65 with a page of no tools and a cursor of 1 MiB, which each next request carries.
    const server = [
      `const send = (value) => new Promise((resolve) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n", resolve));`,
      `(async () => {`,
      `  await send({ id: 1, result: {} });`,
      `  for (let id = 2; id < 66; id++) await send({ id, result: { tools: [], nextCursor: "x".repeat(1024 * 1024) } });`,
      `  setInterval(() => {}, 1000);`,
      `})();`,
    ].join("\n");
    await expect(listTools(process.execPath, ["-e", server], process.env, 10_000)).rejects.toThrow("the server does not read what mcpcage sends it: over 16 MiB are waiting");
    const request = Buffer.byteLength(`${JSON.stringify({ jsonrpc: "2.0", id: 65, method: "tools/list", params: { cursor: "x".repeat(1024 * 1024) } })}\n`);
    expect(stdin.largest).toBeLessThanOrEqual(MAX_LINE_BYTES + request);
  });

  it("refuses tools that take more than 16 MiB over all their pages, and lists them under that", async () => {
    // It reads, and lists one tool of 6 MiB a page for PAGES pages.
    const server = [
      `const { createInterface } = require("node:readline");`,
      `const pages = Number(process.env.PAGES);`,
      `let served = 0;`,
      `const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");`,
      `createInterface({ input: process.stdin }).on("line", (line) => {`,
      `  const message = JSON.parse(line);`,
      `  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "big", version: "1" } } });`,
      `  if (message.method !== "tools/list") return;`,
      `  served += 1;`,
      `  const tool = { name: "tool_" + served, description: "d".repeat(6 * 1024 * 1024) };`,
      `  send({ id: message.id, result: { tools: [tool], ...(served < pages ? { nextCursor: "p" + served } : {}) } });`,
      `});`,
    ].join("\n");
    const list = (pages: number) => listTools(process.execPath, ["-e", server], { ...process.env, PAGES: String(pages) }, 15_000);
    expect((await list(2)).map((tool) => tool.name)).toEqual(["tool_1", "tool_2"]);
    await expect(list(3)).rejects.toThrow("the server's tools take more than 16 MiB over all its pages, which mcpcage refuses");
  });
});
