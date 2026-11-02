/*
 * JSON with comments, as VS Code writes its mcp.json files: `//` and `/* *\/` comments and trailing
 * commas are allowed. A small scanner rather than regular expressions, because a comment marker
 * inside a string ("https://example.com") is text, not a comment.
 */

/** Parses JSON that may carry comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  // The byte order mark becomes a space, like everything removed: JSON.parse error positions still
  // point at the right place in the file.
  return JSON.parse(blankTrailingCommas(blankComments(text.replace(/^﻿/, " ")).text));
}

/** Whether the text has comments, which rewriting the file with JSON.stringify would lose. */
export function hasComments(text: string): boolean {
  return blankComments(text).comments > 0;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every comment replaced by spaces, line breaks kept, so positions and line numbers do not move. */
function blankComments(text: string): { text: string; comments: number } {
  const parts: string[] = [];
  let comments = 0;
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = stringEnd(text, index);
    } else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      const end = text[index + 1] === "/" ? lineEnd(text, index) : blockEnd(text, index);
      parts.push(text.slice(copied, index), text.slice(index, end).replace(/[^\r\n]/g, " "));
      comments++;
      copied = index = end;
    } else {
      index++;
    }
  }
  parts.push(text.slice(copied));
  return { text: parts.join(""), comments };
}

/** A comma followed only by whitespace and a closing bracket becomes a space. */
function blankTrailingCommas(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = stringEnd(text, index);
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < text.length && WHITESPACE.has(text[next]!)) next++;
      if (text[next] === "}" || text[next] === "]") {
        parts.push(text.slice(copied, index), " ");
        copied = index + 1;
      }
    }
    index++;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** Index just after the closing quote of the string that starts at `start` (escapes skipped). */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") index += 2;
    else if (text[index] === '"') return index + 1;
    else index++;
  }
  return text.length;
}

function lineEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index++;
  return index;
}

/** An unterminated block comment runs to the end of the text, as editors show it. */
function blockEnd(text: string, start: number): number {
  const close = text.indexOf("*/", start + 2);
  return close === -1 ? text.length : close + 2;
}
