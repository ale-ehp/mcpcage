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
 * them. So while more than `limit` bytes wait, messages are dropped and their lines counted, and once
 * the stream has written what it took, one line says how many were lost. The audit log is written
 * apart, and keeps them all.
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
    if (stream.writableLength > limit) {
      for (let at = message.indexOf("\n"); at !== -1; at = message.indexOf("\n", at + 1)) dropped++;
      dropped++;
      return;
    }
    // The queue can fall under the limit before it drains: the count then goes out ahead of the
    // first line that gets through, where the gap is.
    report();
    write(`${message}\n`);
  };
}
