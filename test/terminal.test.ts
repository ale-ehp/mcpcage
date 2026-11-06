import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { boundedLog, MAX_LOG_BYTES, printable, streamSafely, terminalSafe } from "../src/terminal.js";
import { root } from "./helpers.js";

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

describe("a program's output streamed to the terminal", () => {
  /** Runs `script` with this node through streamSafely, into a file, and returns its status and what was written. */
  function streamed(script: string, extra: string[] = []): { status: number | null; written: string } {
    const out = join(mkdtempSync(join(tmpdir(), "mcpcage-stream-")), "out.txt");
    const fd = openSync(out, "w");
    try {
      const { status } = streamSafely(process.execPath, ["-e", script, out, ...extra], {}, fd);
      return { status, written: readFileSync(out, "utf8") };
    } finally {
      closeSync(fd);
    }
  }

  it.each([["stderr", "process.stderr"], ["stdout", "process.stdout"]])("takes the color codes out of what a program prints on %s, and spells out what else a terminal would act on", (_name, stream) => {
    // What the classic builder prints for a step that writes on stderr, which it colors even into a
    // file, with what a package could put in it: a screen clear, a window title, a one-byte CSI, a
    // right-to-left override, concealed text; and docker's own carriage returns.
    const lines = [
      "Sending build context to Docker daemon  3.072kB\r\r\n",
      " ---> Running in 48b5567208ec\n",
      "\u001b[91mResolved \u001b[0m\u001b[91m31 packages\u001b[0m\n",
      "\u001b[91mnpm warn deprecated x@1.0.0: \u001b[2J\u001b]0;owned\u0007\u009b2Kgone\u202eevil \u001b[8mhidden\n",
      "\u001b[0m ---> Removed intermediate container 48b5567208ec\n",
      "\n",
      "tail without a line break",
    ];
    const { status, written } = streamed(`for (const line of ${JSON.stringify(lines)}) ${stream}.write(line); process.exitCode = 3;`);
    expect(status).toBe(3);
    expect(written).not.toMatch(/[\u001b\u009b\u0007\u202e\r]/);
    expect(written.split("\n")).toEqual([
      "Sending build context to Docker daemon  3.072kB",
      " ---> Running in 48b5567208ec",
      "Resolved 31 packages",
      "npm warn deprecated x@1.0.0: [U+001B][2J[U+001B]]0;owned[U+0007][U+009B]2Kgone[U+202E]evil hidden",
      " ---> Removed intermediate container 48b5567208ec",
      "",
      "tail without a line break",
      "",
    ]);
  });

  it("shows each line while the program still runs, not once it has ended", () => {
    // The program waits until its first line is in the file the lines go to, as a long build would
    // print its steps one by one.
    const script = [
      "const { readFileSync } = require('node:fs');",
      "process.stdout.write('first\\n');",
      "const until = Date.now() + 10000;",
      "const look = () => {",
      "  if (readFileSync(process.argv[1], 'utf8').includes('first')) return console.log('seen while running');",
      "  if (Date.now() > until) return console.log('not seen');",
      "  setTimeout(look, 20);",
      "};",
      "look();",
    ].join("\n");
    expect(streamed(script)).toEqual({ status: 0, written: "first\nseen while running\n" });
  });

  it("keeps a character whose bytes come in two pieces, and shows a line too long to wait for in pieces", () => {
    const script = "process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50); setTimeout(() => process.stdout.write('x'.repeat(70000) + 'y'), 100);";
    const { written } = streamed(script);
    expect(written.split("\n")).toEqual(["café", "x".repeat(65536), `${"x".repeat(70000 - 65536)}y`, ""]);
    // Nor between the halves of a character outside the BMP.
    const emoji = streamed("process.stdout.write('x'.repeat(65535) + '\\u{1F600}' + 'z');").written.split("\n");
    expect(emoji).toEqual(["x".repeat(65535), "\u{1F600}z", ""]);
  });

  it.each([
    ["an error thrown in it", "throw new Error('the worker broke');", undefined],
    // As Worker.terminate and a worker out of memory end it: no 'exit' handler runs. Its heartbeat stops.
    ["an end where no handler runs", "process.removeAllListeners('exit'); process.exit(1);", { every: 20, look: 200 }],
  ])("ends, with an error, when its worker stops before it tells the end: %s", (_how, failure, beat) => {
    // In a process of its own, from the build, under a time limit: the thread that waits on the worker
    // blocks, and one that waited for ever would hold vitest with it.
    const dir = mkdtempSync(join(tmpdir(), "mcpcage-stream-stop-"));
    const script = join(dir, "stop.mjs");
    writeFileSync(
      script,
      [
        `import { streamSafely } from ${JSON.stringify(pathToFileURL(join(root, "dist", "terminal.js")).href)};`,
        "const started = Date.now();",
        "try {",
        "  streamSafely(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {}, 2, JSON.parse(process.argv[2]));",
        "  console.log('returned');",
        "} catch (error) {",
        "  console.log(`threw after ${Date.now() - started} ms: ${error.message}`);",
        "}",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [script, JSON.stringify({ failure, beat })], { encoding: "utf8", timeout: 20_000 });
    expect(result.signal, `waited for ever: ${result.stdout}${result.stderr}`).toBeNull();
    const told = /^threw after (\d+) ms: (.*)$/m.exec(result.stdout);
    expect(told?.[2], result.stdout + result.stderr).toBe(`the thread that ran ${process.execPath} stopped before ${process.execPath} ended`);
    // Before the program would have ended by itself: the worker stops it, or is found gone.
    expect(Number(told![1])).toBeLessThan(5000);
  });

  it.skipIf(process.platform === "win32")("returns no status for a program a signal ended, and throws when the program cannot start", () => {
    expect(streamed("process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);").status).toBeNull();
    expect(() => streamSafely("/nonexistent/docker", [], {}, 2)).toThrow(/ENOENT/);
  });
});
