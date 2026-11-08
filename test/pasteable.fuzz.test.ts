// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pastedLine } from "../src/protect.js";
import { terminalSafe } from "../src/terminal.js";
import { check, TIMEOUT } from "./fuzz.js";

/*
 * When Claude Code is running, protect --fix prints each server's command line for the user to paste
 * after `claude mcp add <name> --` (see pasteable). The arguments come from a configuration anyone
 * may have written: pasted into a shell, the line must give the program each word as it is and run
 * nothing a word holds.
 */

/** Characters shells read, quotes of every kind, line breaks and controls, invisible and astral characters. */
const character = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(..."'\"$`\\\n\t !*?~#&;|<>(){}[]%=-,.:/@+^") },
  { weight: 3, arbitrary: fc.constantFrom(..."aZ09_") },
  { weight: 1, arbitrary: fc.constantFrom("\r", "\u001b", "\u007f", "\u0085", "\u009b", " ", "é", "​", "‮", " ", "﻿", "“", "”", "„", "‘", "\u{1f600}", "$(id)", "${HOME}", "'\\''") },
  // Any code point but NUL, which no argument of a process can hold.
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }).filter((text) => text !== "\u0000") },
);
const word = fc.array(character, { maxLength: 6 }).map((characters) => characters.join(""));
const words = fc.array(word, { minLength: 1, maxLength: 5 });

/** How Windows' rule (see pasteable) reads a line: plain words, and words in double quotes, one space apart. */
function windowsWords(line: string): string[] | undefined {
  const read: string[] = [];
  let at = 0;
  while (at < line.length) {
    if (at > 0) {
      if (line[at] !== " ") return undefined;
      at++;
    }
    const quoted = /^"([^"]*)"(?= |$)/.exec(line.slice(at));
    const plain = /^[^ "]+/.exec(line.slice(at));
    const token = quoted ?? plain;
    if (token === null) return undefined;
    read.push(quoted !== null ? quoted[1]! : plain![0]);
    at += token[0].length;
  }
  return read;
}

/** What PowerShell reads inside double quotes ($, `, " and its typographic double quotes) and cmd (%, ! and "), and the controls. */
const READ_IN_QUOTES = /[$`"“”„%!\u0000-\u001F\u007F]/;
/** A word neither reads outside quotes: a letter or a digit, then those and _ . : \ / - (PowerShell reads a word that starts with - as a parameter). */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9_.:\\/-]*$/;

/** What protect prints instead of a line, by system (see pastedLine). */
const FALLBACK = {
  posix: /^one of its arguments holds a line break or a character the terminal shows differently: close Claude Code/,
  win32: /^one of its arguments is empty, ends with \\, or holds .*: close Claude Code/,
};

/** Whether the terminal would show a word otherwise than it is: printed so, a pasted line gives the server other words. */
const shownOtherwise = (word: string) => terminalSafe(word) !== word;

describe("the lines to paste into claude mcp add, fuzzed", () => {
  it.skipIf(process.platform === "win32")(
    "give /bin/sh back exactly the words as printed, or print why not when a word needed it",
    () => {
      check(
        fc.property(words, fc.constantFrom<NodeJS.Platform>("darwin", "linux"), (given, platform) => {
          const printed = pastedLine(given, platform);
          if (FALLBACK.posix.test(printed)) {
            expect(given.some(shownOtherwise), JSON.stringify(given)).toBe(true);
            return;
          }
          expect(given.some(shownOtherwise), JSON.stringify(given)).toBe(false);
          // The printed line itself, pasted: the shell gives the program exactly the words.
          const result = spawnSync("/bin/sh", ["-c", `printf '%s\\0' ${printed}`], { encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout.split("\0").slice(0, -1), JSON.stringify(printed)).toEqual(given);
        }),
        100,
        20,
      );
    },
    TIMEOUT,
  );

  it(
    "on Windows give each word as it is to PowerShell and cmd as printed, by the rule pasteable documents, or print why not when a word needed it",
    () => {
      check(
        fc.property(words, (given) => {
          const printed = pastedLine(given, "win32");
          // A word that cannot be pasted so: one the terminal would show otherwise, an empty one, one
          // holding what PowerShell or cmd reads even in double quotes, or one that needs them and ends
          // with \, which the program reads with the closing quote.
          const unpasteable = given.some((one) => shownOtherwise(one) || one === "" || (!PLAIN.test(one) && (READ_IN_QUOTES.test(one) || one.endsWith("\\"))));
          if (FALLBACK.win32.test(printed)) {
            expect(unpasteable, JSON.stringify(given)).toBe(true);
            return;
          }
          expect(unpasteable, JSON.stringify(given)).toBe(false);
          // The printed line read back by the rule: the same words, each plain, or in quotes with nothing either shell reads there.
          expect(windowsWords(printed), printed).toEqual(given);
          for (const token of printed.match(/"[^"]*"|[^ "]+/g)!) {
            if (token.startsWith('"')) {
              expect(token.slice(1, -1)).not.toMatch(READ_IN_QUOTES);
              expect(token.endsWith('\\"')).toBe(false);
            } else {
              expect(token).toMatch(PLAIN);
            }
          }
        }),
        2000,
      );
    },
    TIMEOUT,
  );
});
