// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entryUvSettingsReason } from "../src/uv-settings.js";

// An entry whose env points uvx at other uv settings than the user's: they are looked at too.

const layer = (variables: Record<string, string>) => [{ where: 'its "env"', variables }] as never;

function settingsIn(root: string, relative: string[], text: string): void {
  const folder = join(root, ...relative.slice(0, -1));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, relative.at(-1) as string), text);
}

describe("entryUvSettingsReason", () => {
  it.skipIf(process.platform === "win32").each(["XDG_CONFIG_HOME", "HOME"])("reads the uv.toml that %s leads to on Linux", (name) => {
    const root = mkdtempSync(join(tmpdir(), "mcpcage-uv-places-"));
    settingsIn(root, name === "HOME" ? [".config", "uv", "uv.toml"] : ["uv", "uv.toml"], 'index-url = "https://example.invalid/simple"\n');
    const reason = entryUvSettingsReason(layer({ [name]: root }), "linux", "/home/x");
    expect(reason).toContain(`sets ${name}`);
  });

  it.skipIf(process.platform === "win32")("reads each directory of XDG_CONFIG_DIRS, and ignores one that is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "mcpcage-uv-places-"));
    settingsIn(root, ["uv", "uv.toml"], 'index-url = "https://example.invalid/simple"\n');
    expect(entryUvSettingsReason(layer({ XDG_CONFIG_DIRS: `:${root}:` }), "linux", "/home/x")).toContain("sets XDG_CONFIG_DIRS");
  });

  it("ignores an XDG_CONFIG_HOME that is not an absolute path", () => {
    expect(entryUvSettingsReason(layer({ XDG_CONFIG_HOME: "relative/dir" }), "linux", "/home/x")).toBeUndefined();
  });

  it("looks at the places Windows variables lead to, and finds nothing where there is no file", () => {
    for (const name of ["APPDATA", "PROGRAMDATA", "USERPROFILE", "SYSTEMDRIVE"]) {
      expect(entryUvSettingsReason(layer({ [name]: "/definitely/not/here" }), "win32", "C:\\Users\\x")).toBeUndefined();
    }
  });

  it("refuses a variable that names a share, without opening it", () => {
    expect(entryUvSettingsReason(layer({ APPDATA: "\\\\server\\share" }), "win32", "C:\\Users\\x")).toContain("the cage builds from PyPI only");
  });
});
