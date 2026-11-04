import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AuditLog } from "./audit.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { LineSplitter, MAX_LINE_BYTES } from "./lines.js";
import { checkTools, isToolList, MAX_DEPTH, MAX_TOOLS, nestedDeeperThan, pinTools, tooDeep, type Pin, type ToolDefinition } from "./manifest.js";
import { loadPin, savePending, savePin } from "./pinstore.js";
import { countFindings, countSuspicious, describeResultSigns, describeViolationsWithFindings, highSeveritySigns, scanResult } from "./suspicious.js";

/** JSON-RPC error code mcpcage uses when it refuses a message (implementation-defined range). */
export const BLOCKED = -32001;

/**
 * Requests a server may send to the client without --allow-server-requests: a ping, and the list of
 * roots, which a filesystem server asks for to learn the directories it may use.
 */
const SERVER_REQUESTS_ALLOWED = new Set(["ping", "roots/list"]);

/**
 * The server requests that make the client act for the server, and what each one asks. Both are a way
 * in for a prompt injection and a way out for data: sampling runs the model on the server's prompt,
 * elicitation puts the server's question to the user. A request mcpcage does not know is refused too.
 */
const SERVER_REQUESTS_REFUSED = new Map([
  ["sampling/createMessage", "the server asked your client to run the model"],
  ["elicitation/create", "the server asked your client to put a question to you"],
]);

export interface ProxyOptions {
  serverId: string;
  /** The process to spawn: `docker run ...` for a caged server, or the host command with --no-sandbox. */
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Refuse servers whose tools were never approved, instead of trusting them on first use. */
  strict: boolean;
  /** Let every request from the server reach the client, sampling and elicitation included. */
  allowServerRequests: boolean;
  audit: AuditLog;
  input: Readable;
  output: Writable;
  log: (message: string) => void;
}

type Id = string | number;
type Message = { jsonrpc?: string; id?: Id | null; method?: string; params?: any; result?: any; error?: any };

/**
 * Sits between an MCP client and an MCP server on stdio (newline-delimited JSON-RPC).
 * Everything passes through unchanged except these decisions:
 *  1. a `tools/list` result is compared with the approved manifest; a new or changed tool
 *     blocks the list and locks the session (rug-pull protection);
 *  2. a `tools/call` for a tool that is not approved never reaches the server;
 *  3. what the server writes to stdout reaches the client only as JSON-RPC: other output, lines over
 *     MAX_LINE_BYTES and responses to requests the client is not waiting for are dropped;
 *  4. a request from the server reaches the client only if it is a ping or roots/list, unless
 *     allowServerRequests is set; sampling, elicitation and unknown methods get an error instead.
 * A tool's result always passes unchanged, but the signs of hidden instructions in its text are
 * recorded and the high-severity ones printed. Every decision, call and result is recorded in the
 * hash-chained audit log.
 */
export function runProxy(options: ProxyOptions): Promise<number> {
  const { serverId, audit, log, strict, allowServerRequests } = options;
  let pin: Pin | undefined = loadPin(serverId, log);
  let pinnedThisSession = false;
  /** Why the session is locked, once a listing was blocked: every call is refused from then on. */
  let locked: string | undefined;
  const fromClient = new Map<Id, { method: string; tool?: string; cursor?: boolean; started: number }>();

  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env ?? process.env,
  });
  audit.write("start", { strict, allowServerRequests, pinned: pin !== undefined, tools: pin ? Object.keys(pin.tools).length : 0 });

  const toServer = (line: string) => {
    if (child.stdin.writable) child.stdin.write(`${line}\n`);
  };
  // Writing to a server that is gone fails with EPIPE, or with ERR_STREAM_DESTROYED once the stream is
  // closed. That must not end the proxy on its own: the exit handler below ends it with the server's
  // code and counts the requests left unanswered. Any other error gets one line.
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") log(`mcpcage: could not write to the server: ${error.message}`);
  });
  // A client that reads slower than the server writes would let the server's output pile up in
  // mcpcage's memory, so while the client is behind, mcpcage reads nothing more from the server.
  // Once the client is gone (see the output's error handler below), nothing is written to it.
  let clientBehind = false;
  let clientGone = false;
  const toClient = (message: Message | Message[] | string) => {
    if (clientGone || options.output.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`) || clientBehind) return;
    clientBehind = true;
    child.stdout.pause();
    options.output.once("drain", () => {
      clientBehind = false;
      if (!clientGone) child.stdout.resume();
    });
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
            ? `this session is locked because ${locked}`
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
  // A client that closes its end of mcpcage's stdout has gone away: writing to it fails with EPIPE, or
  // with ERR_STREAM_DESTROYED once the stream is closed, and process.stdout fails again at every
  // later write. Nothing can reach the client any more, so mcpcage stops reading the server and shuts
  // down as when the client's input closes. Any other error gets one line.
  options.output.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
      log(`mcpcage: could not write to the client: ${error.message}`);
    } else if (!clientGone) {
      clientGone = true;
      child.stdout.pause();
      clientLines.close();
    }
  });

  // Server -> client. Nothing the server writes is trusted: the client gets JSON-RPC that answers a
  // request it is waiting for, notifications, and only the requests it may receive.
  //
  // mcpcage answers a refused request itself. A server that sends requests without reading its stdin
  // would pile these answers up in memory, so while a line's worth is still waiting, none is added.
  const answerServer = (message: Message) => {
    if (child.stdin.writableLength < MAX_LINE_BYTES) toServer(JSON.stringify(message));
  };
  /** A request from the server: passed to the client, or refused here with an error (undefined). */
  const serverRequest = (message: Message & { id: Id; method: string }): Message | undefined => {
    const { id, method } = message;
    if (allowServerRequests || SERVER_REQUESTS_ALLOWED.has(method)) {
      audit.write("server-request", { id, method });
      return message;
    }
    const reason = `${SERVER_REQUESTS_REFUSED.get(method) ?? "the server sent a request that mcpcage does not know"}. Pass --allow-server-requests to allow it.`;
    audit.write("server-request-blocked", { id, method });
    log(`mcpcage: blocked ${method} from ${serverId}: ${reason}`);
    answerServer(blocked(id, `mcpcage blocked ${method}: ${reason}`));
    return undefined;
  };
  /**
   * A tool's result is data the model reads, and a server can write instructions into it. Blocking
   * or editing a result would break legitimate content, so mcpcage only says what it sees: the signs
   * go to the audit log, and the high-severity ones to stderr.
   */
  const resultSigns = (id: Id, tool: string, message: Message) => {
    const findings = scanResult(message);
    if (findings.length === 0) return;
    audit.write("result-signs", { id, tool, suspicious: countFindings(findings) });
    const warning = describeResultSigns(tool, findings);
    if (warning) log(`mcpcage: ${warning}. Run \`mcpcage audit show ${serverId}\` for the record.`);
  };
  /** A listing refused whole: the client gets an error, the session is locked, nothing is pinned or saved. */
  const refuseListing = (id: Id, refusal: string, lock: string, entry: Record<string, unknown>): Message => {
    locked = lock;
    audit.write("list-blocked", entry);
    log(`mcpcage: blocked tools/list from ${serverId}: ${refusal}. Nothing was pinned, and the session is locked.`);
    return blocked(id, `mcpcage blocked tools/list: ${refusal}.`);
  };
  /** What becomes of one message from the server: passed on, replaced, or dropped (undefined). */
  const fromServer = (message: Message): Message | undefined => {
    if (message.method !== undefined) {
      if (message.id === undefined) {
        if (message.method === "notifications/tools/list_changed") audit.write("tools-changed-notice");
        return message;
      }
      return serverRequest(message as Message & { id: Id; method: string });
    }
    const id = message.id;
    const request = isId(id) ? fromClient.get(id) : undefined;
    if (!isId(id) || !request) {
      // An answer to a request the client never sent, or a second answer to one it already got: a
      // client could take it for the answer to a request of its own. An id nested too deep is not
      // recorded as it is: writing it down would run out of stack.
      const shown = nestedDeeperThan(id, MAX_DEPTH) ? `(nested more than ${MAX_DEPTH} levels deep)` : (id ?? null);
      audit.write("unsolicited-response", { id: shown });
      log(`mcpcage: dropped a response from the server to a request the client is not waiting for (id ${JSON.stringify(shown)})`);
      return undefined;
    }
    fromClient.delete(id);

    if (request.method === "tools/call") {
      const answer = message.result ?? message.error ?? null;
      audit.write("call-result", {
        id,
        tool: request.tool,
        ok: message.error === undefined && message.result?.isError !== true,
        ms: Date.now() - request.started,
        // Measured by serializing it again, which a result nested too deep would run out of stack.
        bytes: nestedDeeperThan(answer, MAX_DEPTH) ? null : JSON.stringify(answer).length,
      });
      resultSigns(id, request.tool ?? "", message);
      return message;
    }
    if (request.method !== "tools/list" || !isToolList(message.result?.tools)) return message;

    const tools: ToolDefinition[] = message.result.tools;
    // Refused before anything walks it: nothing of such a listing is pinned, saved or explained.
    const most = MAX_TOOLS.toLocaleString("en-US");
    if (tools.length > MAX_TOOLS) {
      return refuseListing(id, `the server lists more than ${most} tools`, `the server listed more than ${most} tools`, {
        reason: "too-many",
        count: tools.length,
        limit: MAX_TOOLS,
      });
    }
    const deep = tooDeep(tools);
    if (deep) {
      return refuseListing(id, `the definition of "${deep.name}" is nested more than ${MAX_DEPTH} levels deep`, "the server listed a definition nested too deep", {
        reason: "too-deep",
        tool: deep.name,
        limit: MAX_DEPTH,
      });
    }
    if (!pin && strict) {
      locked = "the server's tool definitions changed";
      const unapproved = tools.map((tool) => ({ kind: "new-tool" as const, name: tool.name, after: tool }));
      savePending(serverId, tools, unapproved);
      audit.write("list-blocked", { reason: "not-approved", tools: tools.map((tool) => tool.name), suspicious: countSuspicious(unapproved) });
      log(`mcpcage: ${serverId} has no approved tools and --strict is on.\n${describeViolationsWithFindings(unapproved)}\nReview with \`mcpcage diff ${serverId}\`, then \`mcpcage approve ${serverId}\`.`);
      return blocked(id, `mcpcage blocked tools/list: server "${serverId}" has not been approved (--strict).`);
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
    locked = "the server's tool definitions changed";
    savePending(serverId, tools, violations);
    const suspicious = countSuspicious(violations);
    audit.write("list-blocked", {
      reason: "manifest-changed",
      violations: violations.map((violation) => ({ kind: violation.kind, tool: violation.name })),
      suspicious,
    });
    log(`mcpcage: blocked ${serverId}: its tool definitions changed since they were approved.\n${describeViolationsWithFindings(violations)}\nReview with \`mcpcage diff ${serverId}\`; approve with \`mcpcage approve ${serverId}\`.`);
    // The client may show only this message, so it carries the count of the worst signs too.
    const signs = suspicious.high > 0 ? ` ${highSeveritySigns(suspicious.high)}.` : "";
    return blocked(id, `mcpcage blocked tools/list: tool definitions of "${serverId}" changed since they were approved (rug-pull protection).${signs} Run \`mcpcage diff ${serverId}\`.`);
  };
  const fromServerLine = (line: string) => {
    if (line.trim() === "") return;
    const values = parseValues(line);
    const messages = values.filter(isJsonRpc);
    if (values.length === 0 || messages.length < values.length) {
      audit.write("stdout-noise", { bytes: line.length });
      log(`mcpcage: dropped output from the server that is not JSON-RPC: ${line.slice(0, 120)}`);
    }
    const out = messages.map(fromServer).filter((message) => message !== undefined);
    if (out.length === 0) return;
    // A line passed whole reaches the client exactly as the server wrote it; a batch keeps only what passed.
    if (out.length === values.length && out.every((message, index) => message === values[index])) {
      toClient(line);
      return;
    }
    // What is kept from a batch is serialized again: a message nested too deep would run out of stack.
    const kept = out.filter((message) => !nestedDeeperThan(message, MAX_DEPTH));
    if (kept.length < out.length) {
      audit.write("deep-message", { dropped: out.length - kept.length });
      log(`mcpcage: dropped ${out.length - kept.length} message(s) from a batch of the server, nested more than ${MAX_DEPTH} levels deep`);
    }
    if (kept.length > 0) toClient(kept.length === 1 ? kept[0]! : kept);
  };
  const serverLines = new LineSplitter(MAX_LINE_BYTES, fromServerLine, (bytes) => {
    audit.write("oversize-line", { bytes });
    log(`mcpcage: dropped a line of ${bytes} bytes from the server, over the ${MAX_LINE_BYTES / 1024 / 1024} MiB limit`);
  });
  child.stdout.on("data", (chunk: Buffer) => serverLines.push(chunk));
  child.stdout.on("end", () => serverLines.end());

  // Once the server is gone, the client interface is closed too. Reading the client's stdin would keep
  // this process alive, and a client that sees neither an answer nor an exit waits for its own timeout
  // and reports that, instead of the server's error printed above.
  return new Promise((resolve) => {
    child.on("error", (error) => {
      audit.write("spawn-error", { message: error.message });
      log(`mcpcage: could not start ${options.command}: ${error.message}`);
      clientLines.close();
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      audit.write("stop", { code, signal });
      if (fromClient.size > 0) {
        const requests = `${fromClient.size} request${fromClient.size === 1 ? "" : "s"}`;
        log(`mcpcage: the server exited (${code !== null ? `code ${code}` : `signal ${signal}`}) with ${requests} unanswered; see the lines above`);
      }
      clientLines.close();
      resolve(code ?? 1);
    });
  });
}

function blocked(id: Id, message: string): Message {
  return { jsonrpc: "2.0", id, error: { code: BLOCKED, message } };
}

/** The JSON values on one line from the server: the messages of a batch, or the one message; none if it is not JSON. */
function parseValues(line: string): unknown[] {
  try {
    const value: unknown = JSON.parse(line);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

/**
 * A JSON-RPC 2.0 message: a request or a notification (a method, with an id or without), or a
 * response (a result or an error). Whether a response answers anything is decided by the proxy.
 */
function isJsonRpc(value: unknown): value is Message {
  if (!isObject(value)) return false;
  const message = value as Message;
  if (message.jsonrpc !== "2.0") return false;
  if (message.method !== undefined) return typeof message.method === "string" && (message.id === undefined || isId(message.id));
  return message.result !== undefined || message.error !== undefined;
}

function isId(value: unknown): value is Id {
  return typeof value === "string" || typeof value === "number";
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
