// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { closeSync, mkdtempSync, openSync, ftruncateSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_CONFIG_BYTES, readConfigFile } from "../src/clients.js";

// What readConfigFile refuses before it reads anything: a file that is too large or not a regular file.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "mcpcage-config-files-"));
}

describe("readConfigFile", () => {
  it("reads a regular file", () => {
    const file = join(scratch(), "a.json");
    writeFileSync(file, '{"mcpServers":{}}');
    expect(readConfigFile(file).toString("utf8")).toBe('{"mcpServers":{}}');
  });

  it("refuses a file over the limit without reading it", () => {
    const file = join(scratch(), "huge.json");
    const fd = openSync(file, "w");
    ftruncateSync(fd, MAX_CONFIG_BYTES + 1);
    closeSync(fd);
    expect(() => readConfigFile(file)).toThrow(/too large to read/);
  });

  it("refuses a directory", () => {
    const dir = join(scratch(), "dir.json");
    mkdirSync(dir);
    expect(() => readConfigFile(dir)).toThrow("not a regular file");
  });
});
