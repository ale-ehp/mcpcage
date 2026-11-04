import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { claudeCodeSections, type ConfigLocation } from "../src/clients.js";
import { parseEnvFile } from "../src/installed.js";
import { hasComments, parseJsonc } from "../src/jsonc.js";
import { renderReport, scanConfigs } from "../src/protect.js";
import { anyText, checkAsync, check, jsonValue, TIMEOUT } from "./fuzz.js";
import { freshHome } from "./helpers.js";

/*
 * The configuration files mcpcage reads are written by anyone: by hand, by an editor, by another
 * tool. Whatever they hold, reading them must give the value JSON gives, or a plain syntax error, and
 * a scan must go on and report.
 */

/** JSON text as editors write it: indented or not, with comments and trailing commas where VS Code allows them. */
function decorate(value: unknown, extras: { comments: string[]; commas: boolean[]; indent: boolean }): { text: string; comments: number } {
  let comments = 0;
  let index = 0;
  const pick = () => extras.comments[index++ % Math.max(1, extras.comments.length)] ?? "";
  const gap = () => {
    const comment = pick();
    if (comment !== "") comments++;
    return `${extras.indent ? "\n  " : ""}${comment}${comment.startsWith("//") ? "\n" : ""}`;
  };
  const comma = () => (extras.commas[index % Math.max(1, extras.commas.length)] ? "," : "");
  const write = (inner: unknown): string => {
    if (Array.isArray(inner)) return inner.length === 0 ? `[${gap()}]` : `[${inner.map((item) => `${gap()}${write(item)}`).join(",")}${comma()}${gap()}]`;
    if (inner !== null && typeof inner === "object") {
      const entries = Object.entries(inner);
      return entries.length === 0 ? `{${gap()}}` : `{${entries.map(([key, item]) => `${gap()}${JSON.stringify(key)}${gap()}:${gap()}${write(item)}`).join(",")}${comma()}${gap()}}`;
    }
    return JSON.stringify(inner);
  };
  const text = `${gap()}${write(value)}${gap()}`;
  return { text, comments };
}

/** Comments with what makes a scanner stumble: quotes, slashes, stars, line breaks. */
const comment = fc.oneof(
  { weight: 2, arbitrary: fc.constant("") },
  { weight: 1, arbitrary: anyText(12).map((text) => `// ${text.replace(/[\r\n]/g, " ")}`) },
  { weight: 1, arbitrary: anyText(12).map((text) => `/* ${text.replace(/\*\//g, "* /")} */`) },
  { weight: 1, arbitrary: fc.constantFrom('/* "quoted" */', "/** **/", "/*/ */", "// http://x.y/*", "/* // */", "//\r") },
);

/** Strings that look like comments or commas to a careless scanner. */
const trickyString = fc.constantFrom("http://example.com", "/* not a comment */", "// nor this", 'a\\"b', "\\", "x,]", "x,}", "*/", "\u2028", "\ufeff");

describe("configuration readers, fuzzed", () => {
  it(
    "read JSON with comments and trailing commas as the JSON it holds",
    () => {
      const value = fc.oneof(jsonValue(4), fc.dictionary(trickyString, fc.oneof(trickyString, jsonValue(2))));
      check(
        fc.property(value, fc.array(comment, { maxLength: 6 }), fc.array(fc.boolean(), { maxLength: 4 }), fc.boolean(), (inner, comments, commas, indent) => {
          const { text, comments: count } = decorate(inner, { comments, commas, indent });
          expect(parseJsonc(text), text).toEqual(JSON.parse(JSON.stringify(inner)));
          expect(hasComments(text), text).toBe(count > 0);
          expect(parseJsonc(`\ufeff${text}`)).toEqual(parseJsonc(text));
        }),
        1000,
      );
    },
    TIMEOUT,
  );

  it(
    "read any text as JSON or refuse it with a syntax error",
    () => {
      const text = fc.oneof(anyText(80), fc.json().chain((json) => fc.tuple(fc.nat({ max: json.length }), anyText(6)).map(([at, inserted]) => json.slice(0, at) + inserted + json.slice(at))));
      check(
        fc.property(text, (input) => {
          hasComments(input);
          try {
            parseJsonc(input);
          } catch (error) {
            expect(error).toBeInstanceOf(SyntaxError);
          }
          const variables = parseEnvFile(input);
          for (const [name, value] of Object.entries(variables)) {
            expect(typeof name).toBe("string");
            expect(typeof value).toBe("string");
          }
          claudeCodeSections(input);
        }),
        2000,
      );
    },
    TIMEOUT,
  );

  it(
    "scan configuration files of any content and report each of them",
    async () => {
      let runs = 0;
      const content = fc.oneof(
        anyText(60),
        jsonValue(4).map((value) => JSON.stringify(value)),
        fc.dictionary(fc.constantFrom("mcpServers", "servers", "projects", "__proto__"), fc.oneof(jsonValue(3), fc.dictionary(anyText(6), fc.record({ command: fc.oneof(fc.constantFrom("npx", "mcpcage", "cmd", "docker", "uvx"), jsonValue(1)), args: fc.oneof(fc.array(fc.oneof(anyText(10), fc.constantFrom("-y", "run", "--", "/c", "npx", "pkg"))), jsonValue(1)), env: jsonValue(2), url: jsonValue(1), type: jsonValue(1), envFile: jsonValue(1), headers: jsonValue(2) }, { requiredKeys: [] })))).map((value) => JSON.stringify(value)),
      );
      await checkAsync(
        fc.asyncProperty(fc.array(content, { minLength: 1, maxLength: 3 }), async (contents) => {
          const dir = join(freshHome(), `scan-${++runs}`);
          mkdirSync(dir, { recursive: true });
          const locations: ConfigLocation[] = contents.map((text, index) => {
            const file = join(dir, `config-${index}.json`);
            writeFileSync(file, text);
            return { client: index === 0 ? "claude-code" : "cursor", clientName: "x", scope: "user", file, key: index === 2 ? "servers" : "mcpServers", jsonc: index === 2, exists: true, ...(index === 0 ? { nested: [] } : {}) };
          });
          const report = await scanConfigs({ locations, home: dir, offline: true, cacheDir: join(dir, "cache"), npmRunner: () => ({ status: 1, stdout: "", stderr: "offline" }) });
          expect(report.files).toHaveLength(contents.length);
          expect(typeof renderReport(report, { home: dir })).toBe("string");
        }),
        200,
        10,
      );
    },
    TIMEOUT,
  );
});
