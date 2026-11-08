// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { streamLine, streamLines, UNPRINTABLE } from "../src/terminal.js";
import { check, TIMEOUT } from "./fuzz.js";

/*
 * streamSafely shows what docker build prints, which the packages of the build make it print, a line
 * at a time (see streamLines): whatever pieces the pipes of stdout and stderr deliver, and in whatever
 * order the two interleave, each stream's lines must be those of its whole text, nothing lost or
 * reordered, and none may hold anything a terminal acts on.
 */

/** Pieces of a program's output: line breaks, carriage returns, color codes and other escapes, C1 controls, invisible and astral characters. */
const unit = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom("a", "b", " ", "step 1/4", "é") },
  { weight: 3, arbitrary: fc.constantFrom("\n", "\r", "\r\n") },
  { weight: 2, arbitrary: fc.constantFrom("\u001b[31m", "\u001b[0m", "\u001b[38:5:1m", "\u001b[0;1m", "\u001b[2J", "\u001b]0;title\u0007", "\u001b", "[", "m") },
  { weight: 1, arbitrary: fc.constantFrom("\u009b", "\u0085", "\u0000", "\t", "\u0008", "\u007f", "​", "‮", " ", "﻿", "\u{1f600}", "\u{e0041}") },
);

/** A stream's text, as the units it is made of: a pipe delivers whole characters (the worker reads it as UTF-8), so a piece never ends inside one. */
const streamText = fc.array(unit, { maxLength: 30 });

/** The text cut into pieces, at any of the boundaries between its units. */
const pieces = (units: string[]) =>
  fc.uniqueArray(fc.nat({ max: units.length }), { maxLength: 6 }).map((cuts) => {
    const at = [0, ...cuts.sort((a, b) => a - b), units.length];
    return at.slice(1).map((end, index) => units.slice(at[index], end).join(""));
  });

/** The two streams' texts, each cut into pieces, and the order in which the pieces of both arrive. */
const output = fc
  .tuple(streamText, streamText)
  .chain(([out, err]) => fc.tuple(fc.constant([out.join(""), err.join("")]), pieces(out), pieces(err), fc.array(fc.boolean(), { maxLength: 20 })));

/** The lines streamLines shows for each stream, given its pieces in the order they arrive, then the end of both. */
function shown(arrivals: Array<[number, string]>, max?: number): Map<number, string[]> {
  const lines = new Map<number, string[]>([[1, []], [2, []]]);
  const take = streamLines((line, stream) => lines.get(stream)!.push(line), max);
  for (const [stream, text] of arrivals) take(stream, text, false);
  take(1, "", true);
  take(2, "", true);
  return lines;
}

/** The pieces of both streams, interleaved as `order` says, each stream's in its own order. */
function interleaved(out: string[], err: string[], order: boolean[]): Array<[number, string]> {
  const queues: Array<[number, string[]]> = [[1, [...out]], [2, [...err]]];
  const arrivals: Array<[number, string]> = [];
  for (const first of order) {
    const [stream, queue] = queues[first ? 0 : 1]!;
    if (queue.length > 0) arrivals.push([stream, queue.shift()!]);
  }
  for (const [stream, queue] of queues) for (const text of queue) arrivals.push([stream, text]);
  return arrivals;
}

describe("streamSafely's lines, fuzzed", () => {
  it(
    "are each stream's lines of its whole text, however its pieces are cut and the two streams interleave, and show nothing a terminal acts on",
    () => {
      check(
        fc.property(output, ([[out, err], outPieces, errPieces, order]) => {
          const whole = shown([[1, out], [2, err]]);
          const lines = shown(interleaved(outPieces, errPieces, order));
          expect(lines.get(1), JSON.stringify(out)).toEqual(whole.get(1));
          expect(lines.get(2), JSON.stringify(err)).toEqual(whole.get(2));
          for (const line of [...lines.get(1)!, ...lines.get(2)!]) {
            expect(line).not.toMatch(/[\n\r]/);
            // Written to the terminal: no ESC, no C1 control (U+009B is a CSI of its own), nothing invisible.
            expect(streamLine(line), JSON.stringify(line)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
            expect(streamLine(line)).not.toMatch(UNPRINTABLE);
          }
        }),
        1000,
      );
    },
    TIMEOUT,
  );

  it(
    "lose, repeat and reorder nothing when they wait longer than a line may, never cut a line within the limit, nor a character in two",
    () => {
      check(
        fc.property(output, fc.integer({ min: 2, max: 8 }), ([[out, err], outPieces, errPieces, order], max) => {
          const lines = shown(interleaved(outPieces, errPieces, order), max);
          const whole = shown([[1, out], [2, err]], max);
          for (const [stream, text] of [[1, out], [2, err]] as const) {
            expect(lines.get(stream)!.join(""), JSON.stringify(text)).toBe(text.replace(/[\n\r]/g, ""));
            // A line no longer than the limit is never cut, however its pieces come: the lines of the whole text.
            if (text.split("\n").every((line) => line.length <= max)) expect(lines.get(stream), JSON.stringify(text)).toEqual(whole.get(stream));
            // Each line is whole characters: no half of a pair at either end.
            for (const line of lines.get(stream)!) expect(line, JSON.stringify(line)).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
          }
        }),
        1000,
      );
    },
    TIMEOUT,
  );
});
