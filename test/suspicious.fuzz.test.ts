import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/manifest.js";
import { describeFindings, describeResultSigns, describeViolationsWithFindings, scanChange, scanResult, scanResultText, scanText, scanTool, type Finding } from "../src/suspicious.js";
import { UNPRINTABLE } from "../src/terminal.js";
import { anyText, check, jsonValue, TIMEOUT } from "./fuzz.js";

/*
 * The rules read text a server wrote, built to defeat them: they must never throw, take time in
 * proportion to the text, and print only short, printable snippets, whatever the text holds.
 */

/** Pieces of what the rules look for, which repeated make the inputs regular expressions choke on. */
const PIECES = [
  "<!--", "-->", "<important", "</IMPORTANT>", "<system ", "http://", "https://a.b/", "data:a;", "data:x/y;base64,", ";base64,", "a@", "b.", "@a.b", "1.", "1.1.1.", "255.",
  "do not ", "don't ", "never ", "tell ", "the user", "users ", "ignore ", "previous ", "instructions", "you are now", "before using ", "this tool", "use ", "the ", "tool ",
  "instead of ", "server ", ".ssh", "id_rsa", ".env", ".aws/", "~/", "/", "AAAA", "0a", "Zz9", "=", "+", " ", "\t", "\n", "\r\n", "\u200b", "\u200d", "\u202e", "\u2066",
  "\ufe0f", "\u{e0041}", "\u{e0001}", "\u{1f469}", "\u00ad", "x", ".", ",", ":", "'", '"', "`", "<", ">", "(", ")",
];

/** About this many characters: a rule that backtracks quadratically takes seconds on them, a linear scan milliseconds. */
const SIZE = 120_000;

/** Text made of those pieces: one to three of them repeated to SIZE, a shorter run, or a mixture ending in any text. */
const adversarial = fc.oneof(
  { weight: 3, arbitrary: fc.array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 3 }).map((pieces) => pieces.join("").repeat(Math.ceil(SIZE / pieces.join("").length))) },
  { weight: 1, arbitrary: fc.tuple(fc.array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 2000 })).map(([pieces, times]) => pieces.join("").repeat(times)) },
  { weight: 1, arbitrary: fc.tuple(fc.array(fc.constantFrom(...PIECES), { maxLength: 30 }), anyText(200)).map(([pieces, text]) => pieces.join("") + text) },
);

/** Scans `text` both ways, within a time proportional to its length, and checks what they find. */
function scanInTime(text: string): void {
  const started = performance.now();
  const findings = [...scanText(text), ...scanResultText(text)];
  const took = performance.now() - started;
  // 120,000 characters take about 10 ms here: the limit is generous for a slow machine, and far
  // below what a rule that backtracks over the text takes.
  expect(took, `${text.length} characters took ${Math.round(took)} ms`).toBeLessThan(250 + text.length / 1000);
  expect(findings.length).toBeLessThanOrEqual(2 * 20 * 100);
  findings.forEach(readable);
}

/** A finding as a person reads it: printable on one line, short. */
function readable(finding: Finding): void {
  for (const text of [finding.snippet, finding.rule, finding.message]) {
    expect(UNPRINTABLE.test(text), JSON.stringify(text)).toBe(false);
    expect(text).not.toMatch(/[\r\n\t]/);
  }
  expect(finding.snippet.length).toBeLessThanOrEqual(200);
}

describe("the rules, fuzzed", () => {
  it(
    "read each piece repeated in time proportional to it",
    () => {
      for (const piece of PIECES) scanInTime(piece.repeat(Math.ceil(SIZE / piece.length)));
    },
    TIMEOUT,
  );

  it(
    "read any text made of those pieces in time proportional to it, with a bounded number of short printable findings",
    () => {
      // Each run scans up to 120,000 characters twice: a long run takes a tenth of its runs here.
      check(fc.property(adversarial, scanInTime), 60, 10);
    },
    TIMEOUT,
  );

  it(
    "never throw on a definition, a change, a result or an error of any shape, and print what they find on lines of their own",
    () => {
      // A definition always has a string name: the proxy and --inspect take only such lists (isToolList).
      const definition = fc.tuple(anyText(20), jsonValue(4)).map(([name, rest]) => ({ ...(rest !== null && typeof rest === "object" && !Array.isArray(rest) ? rest : { description: rest }), name }) as ToolDefinition);
      const response = fc.record({
        result: fc.oneof(
          jsonValue(3),
          fc.record({ content: fc.array(fc.oneof(jsonValue(2), fc.record({ type: fc.constantFrom("text", "resource", "resource_link"), text: anyText(), resource: jsonValue(2), uri: anyText(), name: anyText() }, { requiredKeys: ["type"] })), { maxLength: 4 }), structuredContent: jsonValue(3), isError: jsonValue(0) }, { requiredKeys: [] }),
        ),
        error: fc.oneof(fc.constant(undefined), jsonValue(2), fc.record({ code: jsonValue(0), message: fc.oneof(anyText(), jsonValue(1)) })),
      });
      check(
        fc.property(definition, definition, response, (before, after, answer) => {
          const findings = [...scanTool(after), ...scanChange(before, after), ...scanChange(undefined, after), ...scanResult(answer as { result?: unknown; error?: unknown })];
          findings.forEach(readable);
          for (const line of describeFindings(findings)) expect(UNPRINTABLE.test(line) || /[\r\n]/.test(line), line).toBe(false);
          for (const line of describeViolationsWithFindings([{ kind: "changed-tool", name: after.name, before, after }, { kind: "new-tool", name: after.name, after }]).split("\n")) {
            expect(UNPRINTABLE.test(line) || /\r/.test(line), line).toBe(false);
          }
          const said = describeResultSigns(after.name, findings);
          if (said !== undefined) expect(UNPRINTABLE.test(said) || /[\r\n]/.test(said), said).toBe(false);
        }),
        500,
      );
    },
    TIMEOUT,
  );
});
