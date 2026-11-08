// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrapConfig, wrapConfig } from "../src/config.js";

// What wrap and unwrap say about a file they cannot work on, before they change anything.

const dir = () => mkdtempSync(join(tmpdir(), "mcpcage-transform-"));

describe.each([
  ["wrap", (file: string) => wrapConfig(file, { dryRun: true })],
  ["unwrap", (file: string) => unwrapConfig(file, { dryRun: true })],
])("%s of a file it cannot work on", (_name, run) => {
  it("says the file does not exist", () => {
    const file = join(dir(), "missing.json");
    expect(() => run(file)).toThrow(`${file} does not exist`);
  });

  it("passes on a read error that is not a missing file", () => {
    const folder = join(dir(), "folder.json");
    mkdirSync(folder);
    expect(() => run(folder)).toThrow();
  });

  it("says a file with comments is not plain JSON", () => {
    const file = join(dir(), "c.json");
    writeFileSync(file, '{ // comment\n "mcpServers": {} }');
    expect(() => run(file)).toThrow("is not plain JSON");
  });

  it("says a file without a server list has none", () => {
    const file = join(dir(), "n.json");
    writeFileSync(file, '{ "theme": "dark" }');
    expect(() => run(file)).toThrow('has neither "mcpServers" nor "servers"');
  });

  it.skipIf(process.getuid?.() === 0)("passes on a file it may not read", () => {
    const file = join(dir(), "locked.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o000);
    expect(() => run(file)).toThrow();
  });
});
