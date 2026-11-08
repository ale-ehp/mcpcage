// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { checkTools, own, pinTools, toolFingerprint, type ToolDefinition } from "../src/manifest.js";
import { loadPin, savePin } from "../src/pinstore.js";
import { anyText, check, jsonValue, PROTOTYPE_NAMES, TIMEOUT } from "./fuzz.js";
import { freshHome } from "./helpers.js";

/*
 * A pin is a hash of the canonical JSON of each definition. It must not depend on the order a server
 * writes the keys in, and it must change with anything else the model reads. The names of the pinned
 * tools are what the call filter looks up: any name, the prototype's own included, must find exactly
 * the tool of that name, before and after the pin is saved and read back.
 */

beforeAll(() => {
  vi.stubEnv("MCPCAGE_HOME", freshHome());
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** JSON equality written apart from canonicalJson: the same keys with equal values, in any order; 0 and -0 are one number, as in JSON text. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return left === right;
}

/** The same value with the keys of every object in another order, own "__proto__" keys kept own. */
const shuffled = (value: unknown): fc.Arbitrary<unknown> => {
  if (Array.isArray(value)) return fc.tuple(...value.map(shuffled));
  if (!isObject(value)) return fc.constant(value);
  const entries = Object.entries(value);
  return fc
    .tuple(fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }), ...entries.map(([, inner]) => shuffled(inner)))
    .map(([order, ...inner]) => Object.fromEntries((order as Array<[string, unknown]>).map(([name]) => [name, inner[entries.findIndex(([other]) => other === name)]])));
};

/** Every place in a value: the path of keys and indexes from its root. */
function placesIn(value: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  const inner = Array.isArray(value) ? value.map((item, index) => placesIn(item, [...path, index])) : isObject(value) ? Object.entries(value).map(([name, item]) => placesIn(item, [...path, name])) : [];
  return [path, ...inner.flat()];
}

/** A small change at one place: another value, a key added, renamed or removed, another type for the same text. */
const changes: Array<(value: unknown, other: unknown) => unknown> = [
  (_value, other) => other,
  (value) => (typeof value === "string" ? `${value} ` : typeof value === "number" ? value + 1 : JSON.stringify(value) ?? "undefined"),
  (value) => (typeof value === "string" ? value.toUpperCase() : value !== null && typeof value === "object" ? "[object Object]" : String(value)),
  (value) => [value],
  (value, other) => (isObject(value) ? { ...value, ["__proto__"]: other } : { k: value }),
  (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).slice(1)) : Array.isArray(value) ? value.slice(1) : null),
  (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).map(([name, inner], index) => [index === 0 ? `${name}x` : name, inner])) : value === null ? "null" : typeof value === "boolean" ? !value : value),
];

function changeAt(value: unknown, path: Array<string | number>, change: (value: unknown) => unknown): unknown {
  if (path.length === 0) return change(value);
  const [step, ...rest] = path;
  if (Array.isArray(value)) return value.map((item, index) => (index === step ? changeAt(item, rest, change) : item));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, inner]) => [name, name === step ? changeAt(inner, rest, change) : inner]));
}

/** A tool definition: a name and any other fields, `_meta` among them. */
const definition = fc.tuple(fc.oneof(anyText(10), fc.constantFrom(...PROTOTYPE_NAMES)), jsonValue(4)).map(([name, rest]) => ({ ...(isObject(rest) ? rest : { inputSchema: rest }), name }) as ToolDefinition);

describe("pins, fuzzed", () => {
  it(
    "write the same canonical JSON for a value whatever the order of its keys",
    () => {
      check(
        fc.property(jsonValue(5).chain((value) => fc.tuple(fc.constant(value), shuffled(value))), ([value, other]) => {
          expect(canonicalJson(other)).toBe(canonicalJson(value));
        }),
        500,
      );
    },
    TIMEOUT,
  );

  it(
    "hash two definitions the same exactly when the model reads the same in them",
    () => {
      check(
        fc.property(
          definition.chain((tool) => fc.tuple(fc.constant(tool), fc.nat(), fc.nat({ max: changes.length - 1 }), jsonValue(2))),
          ([tool, where, which, other]) => {
            const places = placesIn(tool).filter((path) => path[0] !== "_meta" && path[0] !== "name");
            const path = places[where % places.length]!;
            // At the root, only a key added: a definition stays an object with its name.
            const change = path.length === 0 ? changes[4]! : changes[which]!;
            const changed = changeAt(tool, path, (value) => change(value, other)) as ToolDefinition;
            const visible = (value: ToolDefinition) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== "_meta"));
            expect(toolFingerprint(changed) === toolFingerprint(tool)).toBe(jsonEqual(visible(changed), visible(tool)));
          },
        ),
        1000,
      );
    },
    TIMEOUT,
  );

  it(
    "leave _meta out of the hash, and nothing else",
    () => {
      check(
        fc.property(definition, jsonValue(2), (tool, meta) => {
          expect(toolFingerprint({ ...tool, _meta: meta })).toBe(toolFingerprint(Object.fromEntries(Object.entries(tool).filter(([name]) => name !== "_meta")) as ToolDefinition));
        }),
        300,
      );
    },
    TIMEOUT,
  );

  it(
    "find a pinned tool by its exact name only, before and after the pin is saved",
    () => {
      let runs = 0;
      const name = fc.oneof(fc.constantFrom(...PROTOTYPE_NAMES, "", "read_file", "READ_FILE", "re\u0430d_file", "\u00e9", "e\u0301"), anyText(12));
      check(
        fc.property(fc.uniqueArray(definition, { selector: (tool) => tool.name, maxLength: 6 }), fc.array(name, { maxLength: 10 }), (tools, asked) => {
          const serverId = `pins-${++runs}`;
          const pin = pinTools(serverId, tools);
          savePin(pin);
          const loaded = loadPin(serverId, () => {})!;
          for (const candidate of [...tools.map((tool) => tool.name), ...asked]) {
            const listed = tools.find((tool) => tool.name === candidate);
            for (const from of [pin, loaded]) {
              expect(own(from.tools, candidate)?.hash).toBe(listed === undefined ? undefined : toolFingerprint(listed));
            }
          }
          // Read back, the same definitions are no change, and each changed one is.
          expect(checkTools(loaded, tools)).toEqual([]);
          for (const tool of tools) expect(checkTools(loaded, [{ ...tool, description: `${String(tool.description)}!` }])).toHaveLength(1);
        }),
        200,
        5,
      );
    },
    TIMEOUT,
  );
});
