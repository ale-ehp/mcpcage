import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pasteable } from "../src/protect.js";
import { terminalSafe, UNPRINTABLE } from "../src/terminal.js";
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

describe("the lines to paste into claude mcp add, fuzzed", () => {
  it.skipIf(process.platform === "win32")(
    "give /bin/sh back exactly the words, whatever they hold, and print as they are when no word holds what a terminal would act on",
    () => {
      check(
        fc.property(words, fc.constantFrom<NodeJS.Platform>("darwin", "linux"), (given, platform) => {
          const line = pasteable(given, platform);
          expect(line).toBeDefined();
          const result = spawnSync("/bin/sh", ["-c", `printf '%s\\0' ${line}`], { encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout.split("\0").slice(0, -1), JSON.stringify(line)).toEqual(given);
          // What protect prints is the line through terminalSafe: the same line when no word holds a
          // character it spells out.
          if (!given.some((one) => UNPRINTABLE.test(one) || /[\n\r\t]/.test(one))) expect(terminalSafe(line!)).toBe(line);
        }),
        100,
        20,
      );
    },
    TIMEOUT,
  );

  it(
    "on Windows give each word as it is to PowerShell and cmd, by the rule pasteable documents, or none when one cannot be",
    () => {
      check(
        fc.property(words, (given) => {
          const line = pasteable(given, "win32");
          // A word that cannot be pasted so: empty, holding what PowerShell or cmd reads even in double
          // quotes, or one that needs them and ends with \, which the program reads with the closing quote.
          const unpasteable = given.some((one) => one === "" || (!PLAIN.test(one) && (READ_IN_QUOTES.test(one) || one.endsWith("\\"))));
          if (line === undefined) {
            expect(unpasteable, JSON.stringify(given)).toBe(true);
            return;
          }
          expect(unpasteable, JSON.stringify(given)).toBe(false);
          // Read back by the rule: the same words, each plain, or in quotes with nothing either shell reads there.
          expect(windowsWords(line), line).toEqual(given);
          for (const token of line.match(/"[^"]*"|[^ "]+/g)!) {
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
