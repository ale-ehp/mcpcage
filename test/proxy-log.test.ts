import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit.js";
import { runProxy } from "../src/proxy.js";
import { boundedLog, MAX_LOG_BYTES } from "../src/terminal.js";
import { freshHome } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A server whose text is 1,048,576 U+009B wherever it puts any, 2 MiB on the wire and 8 MiB spelled
 * out: on tools/list it answers a request never made, sends a request mcpcage does not know and a line
 * that is not JSON-RPC, then lists a tool nested too deep.
 */
const HUGE_SERVER = `
const huge = "\\u009b".repeat(1024 * 1024);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let deep = {};
for (let level = 0; level < 300; level++) deep = { inner: deep };
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method !== "tools/list") return;
  send({ id: huge, result: {} });
  send({ id: "server-1", method: huge, params: {} });
  process.stdout.write(huge + "\\n");
  send({ id: request.id, result: { tools: [{ name: huge, inputSchema: deep }] } });
});
`;

/** Runs the proxy in this process in front of HUGE_SERVER, lists tools once, and closes. */
async function listFromHugeServer(log: (message: string) => void) {
  vi.stubEnv("MCPCAGE_HOME", freshHome());
  const audit = new AuditLog("huge", "log-lines");
  const input = new PassThrough();
  let received = "";
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      received += chunk.toString();
      done();
    },
  });
  const exit = runProxy({ serverId: "huge", command: process.execPath, args: ["-e", HUGE_SERVER], strict: false, allowServerRequests: false, audit, input, output, log });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  await vi.waitFor(() => expect(received).toContain('"id":1'), { timeout: 10_000 });
  input.end();
  expect(await exit).toBe(0);
  const entries = readFileSync(audit.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { answer: JSON.parse(received) as { error: { message: string } }, entries };
}

describe("the server's text in mcpcage's log lines", () => {
  it("shows an excerpt of each id, method, line and tool name, with its full length, and records them whole in the audit log", async () => {
    const logged: string[] = [];
    const { answer, entries } = await listFromHugeServer((message) => logged.push(message));
    // Spelled out whole, each was a line of 8 MiB: an excerpt shows 200 characters at most.
    const spelled = (count: number) => "[U+009B]".repeat(count);
    const tool = `the definition of "${spelled(25)}... (1048576 chars)" is nested more than 256 levels deep`;
    expect(logged).toEqual([
      `mcpcage: dropped a response from the server to a request the client is not waiting for (id "${spelled(24)}... (1048578 chars))`,
      `mcpcage: blocked ${spelled(25)}... (1048576 chars) from huge: the server sent a request that mcpcage does not know. Pass --allow-server-requests to allow it.`,
      `mcpcage: dropped output from the server that is not JSON-RPC: ${spelled(25)}... (1048576 chars)`,
      `mcpcage: blocked tools/list from huge: ${tool}. Nothing was pinned, and the session is locked.`,
    ]);
    expect(answer.error.message).toBe(`mcpcage blocked tools/list: ${tool}.`);
    // The audit log keeps what the server sent.
    const huge = "\u009b".repeat(1024 * 1024);
    expect(entries).toContainEqual(expect.objectContaining({ event: "unsolicited-response", id: huge }));
    expect(entries).toContainEqual(expect.objectContaining({ event: "server-request-blocked", method: huge }));
    expect(entries).toContainEqual(expect.objectContaining({ event: "list-blocked", reason: "too-deep", tool: huge }));
  });

  it("keeps an id of a million C1 controls from queuing more than 1 MiB of log for a client that does not read it", async () => {
    // Report C, F9: this one id queued 8,388,703 bytes against the 1 MiB limit.
    const stderr = new Writable({ write(_chunk, _encoding, _done) {} });
    await listFromHugeServer(boundedLog(stderr));
    expect(stderr.writableLength).toBeLessThanOrEqual(MAX_LOG_BYTES);
    stderr.destroy();
  });
});
