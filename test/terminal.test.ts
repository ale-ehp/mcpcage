import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { boundedLog, MAX_LOG_BYTES, printable, terminalSafe } from "../src/terminal.js";

describe("terminal-safe text", () => {
  it("spells out every character a terminal would act on or hide, and leaves the rest alone", () => {
    // ESC and a clear-screen sequence, a carriage return, a one-byte CSI (U+009B), a right-to-left
    // override, a zero-width space, a line separator and a lone surrogate.
    expect(terminalSafe("a\u001b[2J\rb\u009b2Kc‮d​e f\ud800g")).toBe("a[U+001B][2J\\rb[U+009B]2Kc[U+202E]d[U+200B]e[U+2028]f[U+D800]g");
    expect(terminalSafe("line\nnext\ttab")).toBe("line\\nnext\\ttab");
    expect(terminalSafe("Café, 東京, 😀, «quotes»")).toBe("Café, 東京, 😀, «quotes»");
  });

  it("clips what it shows, never in the middle of a spelled character", () => {
    expect(printable("ab\u001bcd", 4)).toEqual({ shown: "ab", clipped: true });
    expect(printable("ab\u001bcd", 12)).toEqual({ shown: "ab[U+001B]cd", clipped: false });
  });
});

/**
 * A stream that takes nothing, like a client that does not read mcpcage's stderr, until `drain` is
 * called, and everything from then on until `stall` is.
 */
function stalledStream() {
  let flowing = false;
  const held: Array<() => void> = [];
  let received = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      received += chunk.toString();
      if (flowing) done();
      else held.push(done);
    },
  });
  return {
    stream,
    received: () => received,
    drain: () => {
      flowing = true;
      for (const done of held.splice(0)) done();
    },
    stall: () => {
      flowing = false;
    },
  };
}

describe("the bounded log", () => {
  it("drops lines while more than 1 MiB waits, and says how many once the stream drains", async () => {
    const { stream, received, drain } = stalledStream();
    const log = boundedLog(stream);
    const line = (n: number) => `mcpcage: dropped output from the server that is not JSON-RPC: noise ${n} ${"x".repeat(64)}`;
    let longest = 0;
    for (let n = 0; n < 100_000; n++) {
      log(line(n));
      longest = Math.max(longest, stream.writableLength);
    }
    // Before, all 100,000 lines waited in memory.
    expect(longest).toBeLessThanOrEqual(MAX_LOG_BYTES + line(99_999).length + 1);

    drain();
    const report = /^mcpcage: dropped (\d+) lines of log output while the client was not reading it$/m;
    await vi.waitFor(() => expect(received()).toMatch(report));
    const lines = received().split("\n").filter(Boolean);
    const kept = lines.filter((text) => text.includes(" noise "));
    // The lines that got through are the first ones, in order, and the count accounts for every other.
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, n) => line(n)));
    expect(Number(report.exec(received())![1])).toBe(100_000 - kept.length);
    expect(lines).toEqual([...kept, expect.stringMatching(report)]);

    // Once drained, lines get through again, and nothing more is reported dropped.
    log("mcpcage: after the drain");
    await vi.waitFor(() => expect(received()).toContain("mcpcage: after the drain\n"));
    expect(received().match(/of log output while the client was not reading it/g)).toHaveLength(1);
  });

  it("counts every line of a message it drops, and starts counting again after each drain", async () => {
    const { stream, received, drain, stall } = stalledStream();
    const log = boundedLog(stream, 10);
    log("a line that fills the queue");
    log("a\nmessage\nof three lines");
    log("one more");
    drain();
    await vi.waitFor(() => expect(received()).toContain("\nmcpcage: dropped 4 lines of log output while the client was not reading it\n"));
    stall();
    log("a line that fills the queue again");
    log("dropped");
    log("dropped too");
    drain();
    await vi.waitFor(() => expect(received()).toContain("\nmcpcage: dropped 2 lines of log output while the client was not reading it\n"));
    expect(received()).not.toContain("dropped\n");
  });
});
