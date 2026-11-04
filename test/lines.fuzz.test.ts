import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LineSplitter } from "../src/lines.js";
import { check, TIMEOUT } from "./fuzz.js";

/*
 * LineSplitter reads what a server writes, in the chunks the pipe happens to deliver. Whatever the
 * bytes and wherever the chunks split them, it must find the lines a reader of the whole stream finds,
 * and never hold more than its limit of one line.
 */

type Event = { line: string } | { oversize: number; head: string };

/** The lines of the whole stream, as `readline` with crlfDelay: Infinity finds them, with LineSplitter's limit. */
function reference(bytes: Uint8Array, max: number): Event[] {
  const events: Event[] = [];
  const emit = (from: number, to: number) => {
    const line = Buffer.from(bytes.subarray(from, to));
    events.push(line.length <= max ? { line: line.toString("utf8") } : { oversize: line.length, head: line.subarray(0, max).toString("hex") });
  };
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0x0a && bytes[index] !== 0x0d) continue;
    emit(start, index);
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) index++;
    start = index + 1;
  }
  if (start < bytes.length) emit(start, bytes.length);
  return events;
}

/** Bytes heavy in line endings, multi-byte UTF-8 and bytes that are no UTF-8 at all. */
const streamBytes = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0x20, max: 0x7e }).map((byte) => [byte]) },
      { weight: 3, arbitrary: fc.constantFrom([0x0a], [0x0d], [0x0d, 0x0a], [0x0a, 0x0d]) },
      { weight: 1, arbitrary: fc.constantFrom([0xc3, 0xa9], [0xe2, 0x80, 0xa8], [0xf0, 0x9f, 0x98, 0x80], [0xff], [0xc3], [0xe2, 0x80], [0x80], [0x00]) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 255 }).map((byte) => [byte]) },
    ),
    { maxLength: 200 },
  )
  .map((parts) => Uint8Array.from(parts.flat()));

/** The same bytes cut into chunks at arbitrary points, empty chunks included. */
const chunked = streamBytes.chain((bytes) =>
  fc.array(fc.integer({ min: 0, max: bytes.length }), { maxLength: 12 }).map((cuts) => {
    const points = [0, ...cuts.sort((left, right) => left - right), bytes.length];
    return { bytes, chunks: points.slice(1).map((end, index) => Buffer.from(bytes.subarray(points[index], end))) };
  }),
);

describe("LineSplitter, fuzzed", () => {
  it(
    "finds the lines of the whole stream whatever the chunks, and never holds more than its limit",
    () => {
      check(
        fc.property(chunked, fc.integer({ min: 1, max: 40 }), ({ bytes, chunks }, max) => {
          const events: Event[] = [];
          const splitter = new LineSplitter(
            max,
            (line) => events.push({ line }),
            (size, head) => events.push({ oversize: size, head: Buffer.from(head).toString("hex") }),
          );
          const held = () => (splitter as unknown as { held: Buffer }).held.length;
          for (const chunk of chunks) {
            splitter.push(chunk);
            expect(held()).toBeLessThanOrEqual(max);
          }
          splitter.end();
          expect(events).toEqual(reference(bytes, max));
        }),
        2000,
      );
    },
    TIMEOUT,
  );
});
