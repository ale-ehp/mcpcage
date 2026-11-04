import type { Writable } from "node:stream";

/*
 * What mcpcage prints for a person to read: text from a server with every character a terminal would
 * act on or hide spelled out, and log lines that cannot pile up in memory while nobody reads them.
 */

// What a terminal shows as nothing, or not at all: controls, format and unassigned characters,
// line separators and variation selectors. Controls include ESC and the C1 range (U+009B is a
// one-byte CSI in many terminals), with which a server's text could clear or overwrite the screen
// the user reads before approving; format characters include the bidi controls, which reorder it.
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
