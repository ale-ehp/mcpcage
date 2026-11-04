import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "./jsonc.js";
import { LineSplitter, MAX_LINE_BYTES } from "./lines.js";
import { isToolList, MAX_DEPTH, MAX_TOOLS, nestedDeeperThan, type ToolDefinition } from "./manifest.js";

const PROTOCOL_VERSION = "2025-06-18";
const VERSION = packageVersion();
/** How much of the end of the server's stderr an error shows, and how much of it is kept to show it. */
const STDERR_SHOWN = 500;
const STDERR_KEPT = 64 * 1024;

/**
 * Hides the values a server was given in a text it wrote (see redactor in protect.ts). With `from`,
 * only the text from there on is returned: a value that starts before it is still found whole, and
 * what is left of it after `from` hidden.
 */
export type Redact = (text: string, from?: number) => string;

/**
 * A minimal MCP client over stdio: initialize, then every page of tools/list. It reads the tools a
 * server offers without approving or pinning anything, for `mcpcage protect --inspect`, and reads
 * the server with the proxy's limits: a line over MAX_LINE_BYTES is dropped as it streams in, and
 * a listing of more than MAX_TOOLS tools is refused, as is one whose pages together take more than
 * MAX_LINE_BYTES. What its errors quote of the server goes through `redact` before it is cut.
 */
export function listTools(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  redact: Redact = (text, from = 0) => text.slice(from),
): Promise<ToolDefinition[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const tools: ToolDefinition[] = [];
    const waiting = new Map<number, string>();
    let nextId = 1;
    let stderr = "";
    let done = false;
    // Lines over MAX_LINE_BYTES, thrown away unread: the answer may have been one of them.
    let dropped = 0;
    let longest = 0;
    // The bytes of the pages that brought tools. Each page is a line, held to MAX_LINE_BYTES, and the
    // listing is held to the same over all its pages: a server that sent page after page of one tool
    // with a description of 15 MiB grew mcpcage's memory by as much each time, to 4 GB in seconds.
    let listed = 0;

    /** Why an answer may be missing: the lines too long to read, and the end of the server's stderr. */
    const tail = () => {
      const limit = `over the ${MAX_LINE_BYTES / 1024 / 1024} MiB limit`;
      const note =
        dropped === 0
          ? ""
          : dropped === 1
            ? `; dropped a line of ${longest} bytes from the server, ${limit}`
            : `; dropped ${dropped} lines from the server ${limit}, the longest of ${longest} bytes`;
      // Hidden before it is cut: cut first, a value the cut splits leaves a piece that is not the value.
      const text = stderr.trimEnd();
      const end = redact(text, Math.max(0, text.length - STDERR_SHOWN)).trimStart();
      return `${note}${end ? `: ${end}` : ""}`;
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      // A server that ignores SIGTERM must not keep mcpcage waiting.
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      if (error) reject(error);
      else resolve(tools);
    };
    // A server that writes without reading its stdin would pile what mcpcage sends it up in mcpcage's
    // memory, so while a line's worth is still waiting, nothing is added. Pings with ids of 1 MiB
    // queued over 32 MiB of answers before the timeout; once the answers were held back, pages with
    // cursors of 1 MiB, the next page asked for after each, queued 64 MiB of requests. An answer to
    // the server is dropped, as answerServer in proxy.ts drops it; a message the listing needs ends
    // the inspection instead, since the listing cannot go on without it.
    const send = (message: Record<string, unknown>, needed: boolean) => {
      if (done || !child.stdin.writable) return;
      if (child.stdin.writableLength >= MAX_LINE_BYTES) {
        if (needed) finish(new Error(`the server does not read what mcpcage sends it: over ${MAX_LINE_BYTES / 1024 / 1024} MiB are waiting${tail()}`));
        return;
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };
    // mcpcage answers the server's own requests.
    const answer = (message: Record<string, unknown>) => send(message, false);
    const request = (method: string, params: Record<string, unknown>) => {
      const id = nextId++;
      waiting.set(id, method);
      send({ id, method, params }, true);
    };
    const timer = setTimeout(() => finish(new Error(`the server did not answer within ${timeoutMs / 1000} s${tail()}`)), timeoutMs);

    child.stderr.setEncoding("utf8");
    // More than is shown is kept, so that a value that starts before the part shown is whole where
    // `redact` looks for it. Cut at twice the size only, so that a server writing a byte at a time
    // does not make mcpcage copy the whole of it for each.
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2 * STDERR_KEPT) stderr = stderr.slice(-STDERR_KEPT);
    });
    child.stdin.on("error", () => undefined); // the server may exit before reading what was sent
    child.on("error", (error) => finish(new Error(`could not start ${command}: ${error.message}`)));
    // "close" comes after stdout is drained, so an answer written just before exiting is still read.
    child.on("close", (code, signal) => {
      finish(new Error(`the server stopped before listing its tools (${signal ? `signal ${signal}` : `exit code ${code}`})${tail()}`));
    });

    /** One line from the server: an answer, a request to answer, or noise to skip. */
    const read = (line: string) => {
      if (done) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return; // log lines on stdout are not part of the protocol
      }
      if (!isJsonObject(message)) return;
      if (typeof message.method === "string") {
        // A request from the server (ping, roots/list...): answer it, so the server does not wait for us.
        // Only an id JSON-RPC allows is echoed back: a nested one would be serialized again.
        if (typeof message.id === "string" || typeof message.id === "number") {
          answer(message.method === "ping" ? { id: message.id, result: {} } : { id: message.id, error: { code: -32601, message: "Method not found" } });
        }
        return;
      }
      const id = typeof message.id === "number" ? message.id : undefined;
      const method = id === undefined ? undefined : waiting.get(id);
      if (id === undefined || method === undefined) return;
      waiting.delete(id);
      if (message.error !== undefined) {
        const reason =
          isJsonObject(message.error) && typeof message.error.message === "string"
            ? message.error.message
            : nestedDeeperThan(message.error, MAX_DEPTH)
              ? "an error nested too deep to show"
              : JSON.stringify(message.error);
        finish(new Error(`the server answered ${method} with an error: ${redact(reason).slice(0, 300)}`));
        return;
      }
      if (method === "initialize") {
        send({ method: "notifications/initialized" }, true);
        request("tools/list", {});
        return;
      }
      const result = message.result;
      if (!isJsonObject(result) || !isToolList(result.tools)) {
        finish(new Error("the server's answer to tools/list holds no list of tools"));
        return;
      }
      if (tools.length + result.tools.length > MAX_TOOLS) {
        finish(new Error(`the server lists more than ${MAX_TOOLS.toLocaleString("en-US")} tools, which mcpcage refuses`));
        return;
      }
      // A page without tools keeps nothing: only the cursor, which goes out with the next request.
      if (result.tools.length > 0) listed += Buffer.byteLength(line);
      if (listed > MAX_LINE_BYTES) {
        finish(new Error(`the server's tools take more than ${MAX_LINE_BYTES / 1024 / 1024} MiB over all its pages, which mcpcage refuses`));
        return;
      }
      for (const tool of result.tools) tools.push(tool);
      if (typeof result.nextCursor === "string" && result.nextCursor !== "") request("tools/list", { cursor: result.nextCursor });
      else finish();
    };
    // Whatever goes wrong while reading a line fails this inspection, and only this one: an exception
    // escaping here would end mcpcage before `protect` reported on the other servers.
    const lines = new LineSplitter(
      MAX_LINE_BYTES,
      (line) => {
        try {
          read(line);
        } catch (error) {
          finish(new Error(`reading the server's answer failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      },
      (bytes) => {
        dropped += 1;
        longest = Math.max(longest, bytes);
      },
    );
    child.stdout.on("data", (chunk: Buffer) => lines.push(chunk));
    child.stdout.on("end", () => lines.end());

    request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mcpcage", version: VERSION } });
  });
}

/** mcpcage's version for clientInfo, from the package.json shipped next to the code (src/ and dist/ alike). */
function packageVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
