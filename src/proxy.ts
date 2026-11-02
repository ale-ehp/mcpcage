import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AuditLog } from "./audit.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { checkTools, describeViolations, isToolList, pinTools, type Pin, type ToolDefinition } from "./manifest.js";
import { loadPin, savePending, savePin } from "./pinstore.js";

/** JSON-RPC error code mcpcage uses when it refuses a message (implementation-defined range). */
export const BLOCKED = -32001;

export interface ProxyOptions {
  serverId: string;
  /** The process to spawn: `docker run ...` for a caged server, or the host command with --no-sandbox. */
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Refuse servers whose tools were never approved, instead of trusting them on first use. */
  strict: boolean;
  audit: AuditLog;
  input: Readable;
  output: Writable;
  log: (message: string) => void;
}

type Id = string | number;
type Message = { jsonrpc?: string; id?: Id | null; method?: string; params?: any; result?: any; error?: any };

/**
 * Sits between an MCP client and an MCP server on stdio (newline-delimited JSON-RPC).
 * Everything passes through unchanged except three decisions:
 *  1. a `tools/list` result is compared with the approved manifest; a new or changed tool
 *     blocks the list and locks the session (rug-pull protection);
 *  2. a `tools/call` for a tool that is not approved never reaches the server;
 *  3. anything the server writes to stdout that is not JSON is dropped, so it cannot corrupt the client.
 * Every decision, call and result is recorded in the hash-chained audit log.
 */
export function runProxy(options: ProxyOptions): Promise<number> {
  const { serverId, audit, log, strict } = options;
  let pin: Pin | undefined = loadPin(serverId);
  let pinnedThisSession = false;
  let locked = false;
  const fromClient = new Map<Id, { method: string; tool?: string; cursor?: boolean; started: number }>();

  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env ?? process.env,
  });
  audit.write("start", { strict, pinned: pin !== undefined, tools: pin ? Object.keys(pin.tools).length : 0 });

  const toServer = (line: string) => {
    if (child.stdin.writable) child.stdin.write(`${line}\n`);
  };
  const toClient = (message: Message | string) => {
    options.output.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  };
  const refuse = (id: Id, message: string) => toClient({ jsonrpc: "2.0", id, error: { code: BLOCKED, message } });

  // Client -> server.
  const clientLines = createInterface({ input: options.input, crlfDelay: Infinity });
  clientLines.on("line", (line) => {
    if (line.trim() === "") return;
    const messages = parse(line);
    if (!messages) {
      audit.write("client-noise", { bytes: line.length });
      return;
    }
    const forward: Message[] = [];
    for (const message of messages) {
      if (message.method !== undefined && message.id !== undefined && message.id !== null) {
        if (message.method === "tools/call") {
          const tool = typeof message.params?.name === "string" ? message.params.name : "";
          const reason = locked
            ? "this session is locked because the server's tool definitions changed"
            : !pin
              ? "no approved tool manifest yet (the client must list tools first)"
              : !pin.tools[tool]
                ? `tool "${tool}" is not in the approved manifest`
                : undefined;
          if (reason) {
            audit.write("call-blocked", { id: message.id, tool, reason });
            refuse(message.id, `mcpcage blocked tools/call: ${reason}. Run \`mcpcage diff ${serverId}\` to review.`);
            continue;
          }
          const args = message.params?.arguments ?? {};
          audit.write("call", { id: message.id, tool, args: sha256(canonicalJson(args)), argKeys: Object.keys(args).sort() });
          fromClient.set(message.id, { method: message.method, tool, started: Date.now() });
        } else {
          const cursor = message.method === "tools/list" && message.params?.cursor !== undefined;
          fromClient.set(message.id, { method: message.method, cursor, started: Date.now() });
        }
      }
      forward.push(message);
    }
    if (forward.length === messages.length) toServer(line);
    else if (forward.length === 1) toServer(JSON.stringify(forward[0]));
    else if (forward.length > 1) toServer(JSON.stringify(forward));
  });
  clientLines.on("close", () => {
    child.stdin.end();
    // Give the server a moment to exit on its own once its stdin closes.
    setTimeout(() => child.kill("SIGTERM"), 5000).unref();
  });

  // Server -> client.
  const serverLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  serverLines.on("line", (line) => {
    if (line.trim() === "") return;
    const messages = parse(line);
    if (!messages) {
      audit.write("stdout-noise", { bytes: line.length });
      log(`mcpcage: dropped non-JSON output from the server: ${line.slice(0, 120)}`);
      return;
    }
    let changed = false;
    const out = messages.map((message) => {
      if (message.method !== undefined) {
        if (message.id !== undefined) audit.write("server-request", { id: message.id, method: message.method });
        else if (message.method === "notifications/tools/list_changed") audit.write("tools-changed-notice");
        return message;
      }
      if (message.id === undefined || message.id === null) return message;
      const request = fromClient.get(message.id);
      if (!request) return message;
      fromClient.delete(message.id);

      if (request.method === "tools/call") {
        audit.write("call-result", {
          id: message.id,
          tool: request.tool,
          ok: message.error === undefined && message.result?.isError !== true,
          ms: Date.now() - request.started,
          bytes: JSON.stringify(message.result ?? message.error ?? null).length,
        });
        return message;
      }
      if (request.method !== "tools/list" || !isToolList(message.result?.tools)) return message;

      const tools: ToolDefinition[] = message.result.tools;
      if (!pin && strict) {
        locked = true;
        savePending(serverId, tools, tools.map((tool) => ({ kind: "new-tool" as const, name: tool.name, after: tool })));
        audit.write("list-blocked", { reason: "not-approved", tools: tools.map((tool) => tool.name) });
        log(`mcpcage: ${serverId} has no approved tools and --strict is on. Review with \`mcpcage diff ${serverId}\`, then \`mcpcage approve ${serverId}\`.`);
        changed = true;
        return blocked(message.id, `mcpcage blocked tools/list: server "${serverId}" has not been approved (--strict).`);
      }
      // Trust on first use: the first listing becomes the approved manifest. Only later pages of
      // that same listing (requests with a cursor) may extend it; a fresh listing in the same
      // session is verified like any other, so a server cannot swap definitions right after pinning.
      if (!pin || (pinnedThisSession && request.cursor)) {
        pin = pinTools(serverId, tools, pin);
        pinnedThisSession = true;
        savePin(pin);
        audit.write("pinned", { tools: tools.map((tool) => ({ name: tool.name, hash: pin!.tools[tool.name]!.hash })) });
        return message;
      }

      const violations = checkTools(pin, tools);
      if (violations.length === 0) {
        audit.write("list-verified", { tools: tools.length });
        return message;
      }
      locked = true;
      savePending(serverId, tools, violations);
      audit.write("list-blocked", {
        reason: "manifest-changed",
        violations: violations.map((violation) => ({ kind: violation.kind, tool: violation.name })),
      });
      log(`mcpcage: blocked ${serverId}: its tool definitions changed since they were approved.\n${describeViolations(violations)}\nReview with \`mcpcage diff ${serverId}\`; approve with \`mcpcage approve ${serverId}\`.`);
      changed = true;
      return blocked(message.id, `mcpcage blocked tools/list: tool definitions of "${serverId}" changed since they were approved (rug-pull protection). Run \`mcpcage diff ${serverId}\`.`);
    });
    if (!changed) toClient(line);
    else toClient(out.length === 1 ? out[0]! : (out as unknown as Message));
  });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      audit.write("spawn-error", { message: error.message });
      log(`mcpcage: could not start ${options.command}: ${error.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      audit.write("stop", { code, signal });
      resolve(code ?? 1);
    });
  });
}

function blocked(id: Id, message: string): Message {
  return { jsonrpc: "2.0", id, error: { code: BLOCKED, message } };
}

function parse(line: string): Message[] | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (Array.isArray(value)) return value.filter(isObject) as Message[];
    return isObject(value) ? [value as Message] : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
