import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeViolation, isToolList, jsonChanges, pinTools, type ToolDefinition, type Violation } from "../src/manifest.js";
import { approvePending, listServers, loadPin, loadPending, savePending, savePin } from "../src/pinstore.js";
import { asStored, freshHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = freshHome();
  vi.stubEnv("MCPCAGE_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A definition nested past MAX_DEPTH, written as text: JSON.stringify would recurse. */
const deep = (name: string) => `{"name":"${name}","inputSchema":${'{"items":'.repeat(300)}{}${"}".repeat(300)}}`;

describe("a tools/list answer", () => {
  it("is a list of objects that each have a string name, and nothing else", () => {
    expect(isToolList([])).toBe(true);
    expect(isToolList([{ name: "read" }, { name: "" }])).toBe(true);
    for (const value of [{ tools: [] }, "read", null, 3]) expect(isToolList(value), JSON.stringify(value)).toBe(false);
    for (const entry of [null, "read", 7, {}, { name: 1 }, { name: null }]) expect(isToolList([{ name: "ok" }, entry]), JSON.stringify(entry)).toBe(false);
  });
});

describe("what a blocked listing shows the user", () => {
  it("shows every field of a new tool but its name and _meta, the usual ones first, the others sorted, strings as they are", () => {
    const after: ToolDefinition = {
      name: "notes",
      zeta: [1],
      _meta: { hidden: true },
      annotations: { readOnlyHint: true },
      alpha: "a",
      outputSchema: { type: "object" },
      inputSchema: { type: "object", required: ["b"], properties: {} },
      description: "Reads notes.",
      title: "Notes",
    };
    expect(describeViolation({ kind: "new-tool", name: "notes", after })).toEqual([
      '+ new tool "notes" was not in the approved manifest',
      "    title: Notes",
      "    description: Reads notes.",
      '    inputSchema: {"properties":{},"required":["b"],"type":"object"}',
      '    outputSchema: {"type":"object"}',
      '    annotations: {"readOnlyHint":true}',
      "    alpha: a",
      "    zeta: [1]",
    ]);
  });

  it("clips a long field, with its full length", () => {
    const [, field] = describeViolation({ kind: "new-tool", name: "t", after: { name: "t", description: "d".repeat(500) } });
    expect(field).toBe(`    description: ${"d".repeat(400)}... (500 chars)`);
  });

  it("lists what changed by path, sorted, leaving out the top-level _meta only", () => {
    expect(jsonChanges(1, 2)).toEqual(["(root): 1 -> 2"]);
    expect(jsonChanges(null, { a: 1 })).toEqual(['(root): null -> {"a":1}']);
    expect(jsonChanges({ a: 1 }, null)).toEqual(['(root): {"a":1} -> null']);
    // A value that is not a string is shown with its keys sorted, as the fingerprint reads it.
    expect(jsonChanges({ b: 1, a: 2 }, "text")).toEqual(['(root): {"a":2,"b":1} -> "text"']);
    expect(jsonChanges({ b: 1, a: 1 }, { b: 2, a: 2 })).toEqual(["a: 1 -> 2", "b: 1 -> 2"]);
    expect(jsonChanges({ _meta: { x: 1 }, d: "a" }, { _meta: { x: 2 }, d: "a" })).toEqual([]);
    expect(jsonChanges({ inputSchema: { _meta: 1 } }, { inputSchema: { _meta: 2 } })).toEqual(["inputSchema._meta: 1 -> 2"]);
  });
});

describe("the pin on disk", () => {
  const tool = { name: "add", description: "Adds." };

  it("is written for its owner alone", () => {
    savePin(pinTools("s", [tool]));
    expect(statSync(join(home, "servers", "s", "pin.json")).mode & 0o777).toBe(asStored(0o600));
  });

  it("loads without a word when nothing in it is nested too deep", () => {
    savePin(pinTools("s", [tool]));
    const warn = vi.fn();
    expect(Object.keys(loadPin("s", warn)!.tools)).toEqual(["add"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("names every tool it leaves out in one line, to stderr unless told otherwise", () => {
    const entry = (definition: string) => `{"hash":"legacy","definition":${definition}}`;
    mkdirSync(join(home, "servers", "s"), { recursive: true });
    writeFileSync(join(home, "servers", "s", "pin.json"), `{"version":1,"serverId":"s","approvedAt":"x","tools":{"a":${entry(deep("a"))},"b":${entry(deep("b"))}}}`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadPin("s")!.tools).toEqual({});
    expect(stderr.mock.calls.map(([text]) => text)).toEqual([
      'mcpcage: left out the approved tools "a", "b" of s: their definitions are nested more than 256 levels deep, so they count as new and need a fresh approval\n',
    ]);
  });
});

describe("the servers mcpcage knows", () => {
  it("are the directories of its store, sorted, and none before the store exists", () => {
    expect(listServers()).toEqual([]);
    savePin(pinTools("b-server", []));
    savePin(pinTools("a-server", []));
    writeFileSync(join(home, "servers", "stray-file"), "");
    expect(listServers()).toEqual(["a-server", "b-server"]);
  });
});

describe("the pending manifest", () => {
  const one = { name: "one", description: "1" };
  const two = { name: "two", description: "2" };

  it("keeps the changes of every page, the last one for each tool", () => {
    const changed: Violation = { kind: "changed-tool", name: "one", before: { name: "one" }, after: one };
    savePending("s", [one], [{ kind: "new-tool", name: "one", after: one }]);
    const pending = savePending("s", [two], [changed, { kind: "new-tool", name: "two", after: two }]);
    expect(pending.tools).toEqual([one, two]);
    expect(pending.violations).toEqual([changed, { kind: "new-tool", name: "two", after: two }]);
    expect(loadPending("s")!.violations).toEqual(pending.violations);
    expect(savePending("t", [one], []).violations).toEqual([]);
  });

  it("starts over when the one on disk holds a definition nested too deep, on either side of a change", () => {
    const write = (violation: string) => {
      mkdirSync(join(home, "servers", "s"), { recursive: true });
      writeFileSync(join(home, "servers", "s", "pending.json"), `{"serverId":"s","seenAt":"x","tools":[${JSON.stringify(one)}],"violations":[${violation}]}`);
    };
    for (const violation of [
      `{"kind":"changed-tool","name":"one","before":${deep("one")},"after":${JSON.stringify(one)}}`,
      `{"kind":"changed-tool","name":"one","before":${JSON.stringify(one)},"after":${deep("one")}}`,
      `{"kind":"new-tool","name":"one","after":${deep("one")}}`,
    ]) {
      write(violation);
      expect(savePending("s", [two], []).tools, violation.slice(0, 40)).toEqual([two]);
    }
  });

  it("approves nothing for a server with nothing pending", () => {
    expect(approvePending("never-seen")).toBeUndefined();
  });
});
