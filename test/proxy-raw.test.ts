import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cli, freshHome } from "./helpers.js";

/*
 * JSON-RPC lines a client can write and the official SDK never does: calls sent as notifications,
 * names that are not strings, arguments nested deep. The server here lists the tools of LISTED, answers
 * calls and pings, and says on stderr each line that reaches it, which mcpcage passes on as
 * `[raw] got <line>`.
 */
const SERVER = `
const tools = JSON.parse(process.env.LISTED);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  process.stderr.write("got " + line + "\\n");
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.id === null) return;
  if (message.method === "tools/list") send({ id: message.id, result: { tools } });
  else if (message.method === "tools/call") send({ id: message.id, result: { content: [{ type: "text", text: "called " + JSON.stringify(message.params.name) }] } });
  else if (message.method === "ping") send({ id: message.id, result: {} });
});
`;

type Answer = { id?: unknown; result?: unknown; error?: { code: number; message: string } };

/** mcpcage run in front of SERVER, with a client that writes the lines it is given. */
function rawSession(home: string, listed: unknown[]) {
  const child = spawn(process.execPath, [cli, "run", "--no-sandbox", "--id", "raw", "--", process.execPath, "-e", SERVER], {
    env: { ...process.env, MCPCAGE_HOME: home, LISTED: JSON.stringify(listed) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  const answers = () => stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Answer);
  return {
    send: (message: unknown) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`),
    /** The client's answer to the request `id`, once it came. */
    answer: async (id: unknown) => {
      await vi.waitFor(() => expect(answers().map((answer) => answer.id)).toContain(id), { timeout: 10_000 });
      return answers().find((answer) => answer.id === id)!;
    },
    answers,
    /** Each line that reached the server, parsed. */
    got: () => stderr.split("\n").filter((line) => line.startsWith("[raw] got ")).map((line) => JSON.parse(line.slice("[raw] got ".length)) as Record<string, unknown>),
    stderr: () => stderr,
    close: async () => {
      child.stdin.end();
      return exited;
    },
  };
}

/** The audit entries of every session of the server "raw". */
function audit(home: string): Array<Record<string, unknown>> {
  const dir = join(home, "audit", "raw");
  return readdirSync(dir).flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
}

const call = (name: unknown, id?: unknown) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: "tools/call", params: { name, arguments: {} } });

describe("calls a client writes by hand", () => {
  it("drops a call sent as a notification to a tool that is not approved, and answers nothing", async () => {
    // Found by the proxy's property-based test: such a call reached the server, which can act on it.
    const home = freshHome();
    const session = rawSession(home, [{ name: "read_file", description: "Reads a file.", inputSchema: { type: "object" } }]);
    session.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await session.answer(1);
    session.send(call("delete_everything"));
    session.send(call("delete_everything", null));
    session.send([call("constructor"), call("read_file")]);
    session.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    await session.answer(2);
    expect(await session.close()).toBe(0);
    // Only the approved one reached the server, what is left of the batch; a notification is never
    // answered, so no refusal came back.
    expect(session.got()).toEqual([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, call("read_file"), { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(session.answers().map((answer) => answer.id)).toEqual([1, 2]);
    const blocked = audit(home).filter((entry) => entry.event === "call-blocked");
    expect(blocked.map((entry) => [entry.tool, entry.reason])).toEqual([
      ["delete_everything", 'tool "delete_everything" is not in the approved manifest'],
      ["delete_everything", 'tool "delete_everything" is not in the approved manifest'],
      ["constructor", 'tool "constructor" is not in the approved manifest'],
    ]);
  });
});
