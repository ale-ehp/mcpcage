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

describe("a message longer than what the log still holds", () => {
  it("cuts one message too long for the limit to what is left, with its full length, and drops the next", async () => {
    const { stream, received, drain } = stalledStream();
    const log = boundedLog(stream);
    // A server's id of 1,048,576 U+009B, spelled out. Before, all 8 MiB of it waited in one write.
    const id = `mcpcage: dropped a response from the server to a request the client is not waiting for (id "${"[U+009B]".repeat(1024 * 1024)}")`;
    log(id);
    expect(stream.writableLength).toBeLessThanOrEqual(MAX_LOG_BYTES);
    // Neither fits in what is left, and less than a quarter of the limit is left: both are dropped.
    log("x".repeat(600 * 1024));
    log("mcpcage: an ordinary line");
    expect(stream.writableLength).toBeLessThanOrEqual(MAX_LOG_BYTES);

    drain();
    await vi.waitFor(() => expect(received()).toContain("mcpcage: dropped 2 lines of log output while the client was not reading it\n"));
    const [cut, ...rest] = received().split("\n").filter(Boolean);
    const note = /\.\.\. \(a message of (\d+) bytes, cut at (\d+)\)$/.exec(cut!)!;
    expect(Number(note[1])).toBe(Buffer.byteLength(id));
    expect(cut!.slice(0, -note[0].length)).toBe(id.slice(0, Number(note[2])));
    expect(Buffer.byteLength(cut!) + 1).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(Buffer.byteLength(cut!) + 1).toBeGreaterThan(MAX_LOG_BYTES - 100);
    expect(rest).toEqual(["mcpcage: dropped 2 lines of log output while the client was not reading it"]);
  });

  it("cuts a message that does not fit while a quarter of the limit or more is left, and drops one that does not fit once less is", async () => {
    const { stream, received, drain } = stalledStream();
    const log = boundedLog(stream, 1000);
    log("a".repeat(299));
    log("b".repeat(1000)); // 700 bytes left: cut to them
    expect(stream.writableLength).toBeLessThanOrEqual(1000);
    expect(stream.writableLength).toBeGreaterThan(990);
    drain();
    await vi.waitFor(() => expect(received()).toContain("cut at"));
    const [whole, cut] = received().split("\n");
    expect(whole).toBe("a".repeat(299));
    expect(cut).toMatch(/^b+\.\.\. \(a message of 1000 bytes, cut at \d+\)$/);

    const second = stalledStream();
    const small = boundedLog(second.stream, 1000);
    small("a".repeat(799));
    small("b".repeat(1000)); // 200 bytes left, under a quarter: dropped and counted
    expect(second.stream.writableLength).toBe(800);
    second.drain();
    await vi.waitFor(() => expect(second.received()).toContain("mcpcage: dropped 1 line of log output"));
    expect(second.received()).not.toContain("b");
  });

  it("measures a message in bytes and never cuts a character in half", async () => {
    const { stream, received, drain } = stalledStream();
    const log = boundedLog(stream, 100);
    // 300 bytes in 100 characters: before, the message was not measured at all, and went out whole.
    log("東".repeat(100));
    expect(stream.writableLength).toBeLessThanOrEqual(100);
    drain();
    await vi.waitFor(() => expect(received()).toContain("cut at"));
    expect(received()).toMatch(/^(東+)\.\.\. \(a message of 300 bytes, cut at (\d+)\)\n$/);
    const [, kept, at] = /^(東+)\.\.\. \(a message of 300 bytes, cut at (\d+)\)\n$/.exec(received())!;
    expect(Buffer.byteLength(kept!)).toBe(Number(at));
    expect(received()).not.toContain("�");
  });
});
