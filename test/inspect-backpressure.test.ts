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
