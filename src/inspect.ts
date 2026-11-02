import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "./jsonc.js";
import { isToolList, type ToolDefinition } from "./manifest.js";

const PROTOCOL_VERSION = "2025-06-18";
const VERSION = packageVersion();

/**
 * A minimal MCP client over stdio: initialize, then every page of tools/list. It reads the tools a
 * server offers without approving or pinning anything, for `mcpcage protect --inspect`.
 */
export function listTools(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ToolDefinition[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const tools: ToolDefinition[] = [];
    const waiting = new Map<number, string>();
    let nextId = 1;
    let stderr = "";
    let done = false;

    const tail = () => {
      const text = stderr.trim();
      return text ? `: ${text.slice(-500)}` : "";
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill("SIGTERM");
      // A server that ignores SIGTERM must not keep mcpcage waiting.
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      if (error) reject(error);
      else resolve(tools);
    };
    const send = (message: Record<string, unknown>) => {
      if (!done && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };
    const request = (method: string, params: Record<string, unknown>) => {
      const id = nextId++;
      waiting.set(id, method);
      send({ id, method, params });
    };
    const timer = setTimeout(() => finish(new Error(`the server did not answer within ${timeoutMs / 1000} s${tail()}`)), timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdin.on("error", () => undefined); // the server may exit before reading what was sent
    child.on("error", (error) => finish(new Error(`could not start ${command}: ${error.message}`)));
    // "close" comes after stdout is drained, so an answer written just before exiting is still read.
    child.on("close", (code, signal) => {
      finish(new Error(`the server stopped before listing its tools (${signal ? `signal ${signal}` : `exit code ${code}`})${tail()}`));
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return; // log lines on stdout are not part of the protocol
      }
      if (!isJsonObject(message)) return;
      if (typeof message.method === "string") {
        // A request from the server (ping, roots/list...): answer it, so the server does not wait for us.
        if (message.id !== undefined && message.id !== null) {
          send(message.method === "ping" ? { id: message.id, result: {} } : { id: message.id, error: { code: -32601, message: "Method not found" } });
        }
        return;
      }
      const id = typeof message.id === "number" ? message.id : undefined;
      const method = id === undefined ? undefined : waiting.get(id);
      if (id === undefined || method === undefined) return;
      waiting.delete(id);
      if (message.error !== undefined) {
        const reason = isJsonObject(message.error) && typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
        finish(new Error(`the server answered ${method} with an error: ${reason.slice(0, 300)}`));
        return;
      }
      if (method === "initialize") {
        send({ method: "notifications/initialized" });
        request("tools/list", {});
        return;
      }
      const result = message.result;
      if (!isJsonObject(result) || !isToolList(result.tools)) {
        finish(new Error("the server's answer to tools/list holds no list of tools"));
        return;
      }
      tools.push(...result.tools);
      if (typeof result.nextCursor === "string" && result.nextCursor !== "") request("tools/list", { cursor: result.nextCursor });
      else finish();
    });

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
