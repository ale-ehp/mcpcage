// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { writeSync } from "node:fs";
import type { Writable } from "node:stream";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

/*
 * What mcpcage prints for a person to read: text from a server with every character a terminal would
 * act on or hide spelled out, and log lines that cannot pile up in memory while nobody reads them.
 */

// What a terminal shows as nothing, or not at all: controls, format and unassigned characters,
// line separators and variation selectors. Controls include ESC and the C1 range (U+009B is a
// one-byte CSI in many terminals), with which a server's text could clear or overwrite the screen
// the user reads before approving; format characters include the bidi controls, which reorder it.
// biome-ignore lint/suspicious/noMisleadingCharacterClass: the variation selectors are matched on their own, as code points (u flag)
export const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
const EVERY_UNPRINTABLE = new RegExp(UNPRINTABLE.source, "gu");

/**
 * `text` as a terminal should show it, whole: invisible and control characters spelled out as
 * [U+XXXX], line breaks and tabs as \n, \r and \t. Everything mcpcage prints that a server wrote, a
 * tool name, a description, a schema key, a method, an id, a package name, goes through it, so that
 * what the reviewer reads is what the model reads, and the server cannot move the cursor, clear the
 * screen or start a line of its own.
 */
export function terminalSafe(text: string): string {
  return text.replace(EVERY_UNPRINTABLE, spell);
}

/** `terminalSafe`, clipped after `max` characters of what it shows. */
export function printable(text: string, max: number): { shown: string; clipped: boolean } {
  let shown = "";
  for (const char of text) {
    const next = spell(char);
    if (shown.length + next.length > max) return { shown, clipped: true };
    shown += next;
  }
  return { shown, clipped: false };
}

/** The most characters of a server's text that one of mcpcage's log lines shows. */
const MAX_EXCERPT = 200;

/**
 * `text` as terminalSafe shows it, clipped after `max` characters of that, with its full length when
 * clipped. Only what is shown is spelled out: through terminalSafe whole, a server's id of 1,048,576
 * U+009B became 8 MiB of "[U+009B]" in one log line, built before anything could cut it.
 */
export function excerpt(text: string, max = MAX_EXCERPT): string {
  const { shown, clipped } = printable(text, max);
  return clipped ? `${shown}... (${text.length} chars)` : shown;
}

function spell(char: string): string {
  if (char === "\n") return "\\n";
  if (char === "\r") return "\\r";
  if (char === "\t") return "\\t";
  if (!UNPRINTABLE.test(char)) return char;
  return `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`;
}

/** The most bytes of log lines that may wait to be written to mcpcage's stderr. */
export const MAX_LOG_BYTES = 1024 * 1024;

/**
 * A log function that writes one line per message to `stream` and never queues more than about
 * `limit` bytes. mcpcage's stderr is a pipe to the client, which may never read it: a server flooding
 * stdout with junk, each piece logged, piled 7.3 MB of lines up in mcpcage's memory for 100,000 of
 * them. So a message that does not fit in what is left of `limit` is dropped and its lines counted,
 * and once the stream has written what it took, one line says how many were lost. The audit log is
 * written apart, and keeps them all.
 *
 * The message itself counts, in bytes, the line break included: only what already waited was checked
 * before, so one message went out whole however long it was, and a server's id spelled out queued
 * 8 MiB in one write. A message longer than what is left while a quarter of `limit` or more is left
 * cannot be an ordinary line, which takes a few hundred bytes: it goes out cut to what is left, with
 * its full length, so that it is seen without being held whole.
 */
export function boundedLog(stream: Writable, limit = MAX_LOG_BYTES): (message: string) => void {
  let dropped = 0;
  const report = () => {
    if (dropped === 0) return;
    const count = dropped;
    dropped = 0;
    write(`mcpcage: dropped ${count} line${count === 1 ? "" : "s"} of log output while the client was not reading it\n`);
  };
  // The callback of a write runs once the stream is done with it. With nothing left after it, the
  // stream has drained: the count goes out even if no other line ever comes. This holds whatever
  // the stream's highWaterMark, where its 'drain' event comes only after a write it refused.
  const write = (text: string) => {
    stream.write(text, () => {
      if (stream.writableLength === 0) report();
    });
  };
  return (message) => {
    const bytes = Buffer.byteLength(message) + 1;
    const room = limit - stream.writableLength;
    // A line that does not fit is dropped whole, never cut, while less than a quarter of `limit` is
    // left: the rest waits then, and the callback of its last write sends the count once it drains.
    if (bytes > room && room < limit / 4) {
      for (let at = message.indexOf("\n"); at !== -1; at = message.indexOf("\n", at + 1)) dropped++;
      dropped++;
      return;
    }
    // The queue can fall under the limit before it drains: the count then goes out ahead of the
    // first line that gets through, where the gap is.
    report();
    write(bytes <= room ? `${message}\n` : `${cut(message, bytes - 1, limit - stream.writableLength)}\n`);
  };
}

/**
 * The start of `message` (`bytes` long) with a note of its full length, in at most `room` bytes with
 * the line break when the note fits there. TextEncoder.encodeInto stops before a character that would
 * not fit whole, so none is cut in half, and it copies only what is kept.
 */
function cut(message: string, bytes: number, room: number): string {
  const note = (kept: number) => `... (a message of ${bytes} bytes, cut at ${kept})`;
  // The note with the full length is at least as long as the note with what is kept.
  const space = Math.max(0, room - Buffer.byteLength(note(bytes)) - 1);
  const { read, written } = new TextEncoder().encodeInto(message, new Uint8Array(space));
  return `${message.slice(0, read)}${note(written)}`;
}

/*
 * The worker of streamSafely: it starts the program, and hands each piece it prints, then its exit, to
 * the thread that waits, adding one to the count it waits on. Node's own modules only, as a plain
 * script: it runs in a worker of its own, which loads no file of mcpcage.
 *
 * The waiting thread runs no event loop, so it learns of the worker's end only from the worker: one
 * that ended without telling left it in Atomics.wait for ever, the program's output with it. So the
 * worker tells from its own process 'exit' handler, which Node runs for an error thrown in it, a
 * rejected promise and process.exit (seen on Node 22 and 26), and stops the program; and it raises a
 * second count, its heartbeat, every BEAT ms, which stops when the worker is terminated without
 * running a line more (Worker.terminate, a worker out of memory), where no handler runs.
 */
const FORWARD_START = `
const { workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { file, args, env, port, count, beat } = workerData;
let told = false;
let child;
const tell = (message) => {
  port.postMessage(message);
  Atomics.add(count, 0, 1);
  Atomics.notify(count, 0);
};
const end = (message) => {
  if (told) return;
  told = true;
  tell(message);
};
process.on("exit", () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
  end({ stopped: true });
});
setInterval(() => Atomics.add(count, 1, 1), beat);
`;
const FORWARD_END = `
try {
  child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  for (const [stream, from] of [[1, child.stdout], [2, child.stderr]]) {
    from.setEncoding("utf8");
    from.on("data", (text) => tell({ stream, text }));
  }
  child.on("error", (error) => end({ error: String(error && error.message) }));
  child.on("close", (status) => end({ status }));
} catch (error) {
  end({ error: String(error && error.message) });
}
`;

/** How often the worker beats, and how long the waiting thread waits between two looks at the beat. */
const BEAT = { every: 1000, look: 15_000 };

/** The color codes of a line (SGR): the classic builder wraps what a step writes on stderr in red. */
const COLORS = /\u001b\[[0-9;:]*m/g;

/** The most of one line that waits for its end: a program that prints no line break is shown in pieces of this many characters. */
const MAX_LINE = 64 * 1024;

/** The streams of a program streamSafely reads: stdout and stderr. */
const STREAMS = [1, 2] as const;

/**
 * The lines of a program's two streams (see streamSafely), from the pieces each delivers: `take`
 * adds a piece of `stream` (1 for stdout, 2 for stderr) to what that stream left without a line
 * break, or with `last` ends it, and `show` gets each line found, in order, without its line break.
 * A line break is \n; a carriage return ends a line too, and the empty lines it leaves are dropped;
 * what waits for its line break is shown in pieces of `max` characters (MAX_LINE; tests give less,
 * 2 at least, so that a cut before the second half of a character still moves on), never between
 * the two halves of a character outside the BMP.
 */
export function streamLines(show: (line: string, stream: number) => void, max = MAX_LINE): (stream: number, text: string, last: boolean) => void {
  const pending = new Map<number, string>(STREAMS.map((stream) => [stream, ""]));
  return (stream, text, last) => {
    const lines = `${pending.get(stream)}${text}`.split("\n");
    let rest = lines.pop()!;
    if (last && rest !== "") {
      lines.push(rest);
      rest = "";
    }
    while (rest.length > max) {
      // Never between the two halves of a character outside the BMP.
      const at = /[\ud800-\udbff]/.test(rest[max - 1]!) ? max - 1 : max;
      lines.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    pending.set(stream, rest);
    for (const line of lines) {
      const parts = line.split("\r");
      for (const part of parts.length === 1 ? parts : parts.filter((piece) => piece !== "")) show(part, stream);
    }
  };
}

/** A line of streamLines as streamSafely writes it: its color codes taken out, the rest as terminalSafe shows it. */
export function streamLine(line: string): string {
  return terminalSafe(line.replace(COLORS, ""));
}

/**
 * Runs `file` with `args` and `env`, nothing on its standard input, and writes what it prints on
 * stdout and on stderr to the file descriptor `fd` as it comes, a line at a time, each as terminalSafe
 * shows it, its color codes taken out. Waits for it, as spawnSync does, and returns its exit status
 * (null when a signal ended it).
 *
 * docker build is run so: the steps of a build print what the packages make them print (npm's
 * deprecation notes quote the package's author), and the classic builder wraps a step's stderr in
 * color codes even when it writes to a file. Given the terminal, a package could move the cursor,
 * clear the screen or retitle the window of the user who builds it. Color codes are taken out rather
 * than spelled out, which would put [U+001B][91m around each line uv prints; a carriage return, which
 * writes a line over the one before, ends a line, and the empty lines it leaves are not shown. The
 * program runs in a worker thread while this one waits on a count the worker raises, so that its lines
 * are shown while it runs, as with spawnSync and the terminal, and written by this thread, whose
 * mcpcage code spells them out.
 */
export function streamSafely(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  fd = 2,
  testOnly?: { failure: string; beat?: { every: number; look: number } },
): { status: number | null } {
  // The count of messages, then the worker's heartbeat (see FORWARD_START).
  const count = new Int32Array(new SharedArrayBuffer(8));
  const { port1, port2 } = new MessageChannel();
  const beat = testOnly?.beat ?? BEAT;
  // `testOnly`, for tests alone (mcpcage never passes it): a line the worker runs before it starts the
  // program, which makes it fail before it can tell its end.
  const source = `${FORWARD_START}${testOnly?.failure ?? ""}\n${FORWARD_END}`;
  const worker = new Worker(source, { eval: true, workerData: { file, args, env, port: port2, count, beat: beat.every }, transferList: [port2] });
  // Its error is told through its 'exit' handler; nobody would listen to this event.
  worker.on("error", () => {});
  worker.unref();
  const take = streamLines((line) => writeSync(fd, `${streamLine(line)}\n`));
  const stopped = () => new Error(`the thread that ran ${file} stopped before ${file} ended`);
  let seen = 0;
  let beats = 0;
  let still = 0;
  try {
    for (;;) {
      // Two looks in a row without a beat: the worker is gone, terminated where no handler runs.
      if (Atomics.wait(count, 0, seen, beat.look) === "timed-out") {
        const now = Atomics.load(count, 1);
        still = now === beats ? still + 1 : 0;
        beats = now;
        if (still >= 2) {
          for (const stream of STREAMS) take(stream, "", true);
          throw stopped();
        }
      }
      seen = Atomics.load(count, 0);
      for (let received = receiveMessageOnPort(port1); received !== undefined; received = receiveMessageOnPort(port1)) {
        const message = received.message as { stream: number; text: string } | { status: number | null } | { error: string } | { stopped: true };
        if ("text" in message) {
          take(message.stream, message.text, false);
          continue;
        }
        for (const stream of STREAMS) take(stream, "", true);
        if ("stopped" in message) throw stopped();
        if ("error" in message) throw new Error(message.error);
        return { status: message.status };
      }
    }
  } finally {
    port1.close();
    void worker.terminate();
  }
}
