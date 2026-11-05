import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { namesIndex, uvConfigFiles, uvSettingsReason } from "../src/uv-settings.js";

describe("the scan of a uv.toml for a package index", () => {
  it("finds an [[index]] table and each key that chooses where packages come from, under any table", () => {
    const found = [
      '[[index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"',
      "  [[ index ]]  # spaces and a comment after it",
      '[["index"]]',
      'index = [{ name = "corp", url = "https://pypi.corp.example/simple" }]',
      'index-url = "https://pypi.corp.example/simple"',
      "extra-index-url = ['https://pypi.corp.example/simple']",
      'default-index="https://pypi.corp.example/simple"',
      'find-links = ["/opt/wheels"]',
      "no-index = true",
      'index-strategy = "unsafe-best-match"',
      'keyring-provider = "subprocess"',
      // [pip] is read by uv pip only, not by uvx: counted all the same.
      '[pip]\nindex-url = "https://pypi.corp.example/simple"',
      'pip.index-url = "https://pypi.corp.example/simple"',
      '"index-url" = "https://pypi.corp.example/simple"',
      "pip = { extra-index-url = ['x'] }",
      "\r\nno-cache = true\r\nfind-links = []\r\n",
    ];
    for (const text of found) expect(namesIndex(text), text).toBe(true);
  });

  it("skips comments, and keys' names inside values, and other keys", () => {
    const clean = [
      "",
      "# index-url = 'https://pypi.corp.example/simple'",
      "   #[[index]]",
      'no-cache = true # index-url = "x"',
      'cache-dir = "/tmp/index-url = x"',
      "python-preference = 'managed' # [[index]]",
      'note = "a # inside a string, then"   # index = x',
      'escaped = "a \\" quote, then index-url = x"',
      "my-index = 1",
      "indexes = 1",
      "index-urls = 1",
      "[tool.uv.pip]",
      "[index-options]",
      'exclude-newer = "2026-01-01"',
    ];
    for (const text of clean) expect(namesIndex(text), text).toBe(false);
    // A false positive only leaves a server uncaged, with the reason: this one is counted.
    expect(namesIndex("no-index = false")).toBe(true);
  });
});

describe("where uv's settings are looked for", () => {
  it("on macOS and Linux: UV_CONFIG_FILE, the user's uv.toml under XDG_CONFIG_HOME and ~/.config, the system's under XDG_CONFIG_DIRS and /etc", () => {
    expect(uvConfigFiles({ platform: "linux", env: {}, home: "/home/me" })).toEqual(["/home/me/.config/uv/uv.toml", "/etc/uv/uv.toml"]);
    expect(uvConfigFiles({ platform: "darwin", env: { UV_CONFIG_FILE: "/x/uv.toml", XDG_CONFIG_HOME: "/xdg", XDG_CONFIG_DIRS: "/etc/xdg::relative:/opt/conf" }, home: "/Users/me" })).toEqual([
      "/x/uv.toml",
      "/xdg/uv/uv.toml",
      "/Users/me/.config/uv/uv.toml",
      "/etc/xdg/uv/uv.toml",
      "/opt/conf/uv/uv.toml",
      "/etc/uv/uv.toml",
    ]);
    // A relative XDG_CONFIG_HOME is ignored, as the XDG specification says; a relative UV_CONFIG_FILE is taken from the current directory, as uv takes it.
    expect(uvConfigFiles({ platform: "linux", env: { XDG_CONFIG_HOME: "xdg", UV_CONFIG_FILE: "uv.toml" }, home: "/home/me" })).toEqual([resolve("uv.toml"), "/home/me/.config/uv/uv.toml", "/etc/uv/uv.toml"]);
    expect(uvConfigFiles({ platform: "linux", env: { UV_CONFIG_FILE: "" }, home: "/home/me" })).toEqual(["/home/me/.config/uv/uv.toml", "/etc/uv/uv.toml"]);
  });

  it("on Windows: %APPDATA% and %PROGRAMDATA% as Windows has them, never an environment's APPDATA", () => {
    const windows = { appData: "C:\\Users\\me\\AppData\\Roaming", programData: "C:\\ProgramData" };
    const env = { APPDATA: "C:\\evil", PROGRAMDATA: "C:\\evil", XDG_CONFIG_HOME: "C:\\evil" };
    expect(uvConfigFiles({ platform: "win32", env, home: "C:\\Users\\me", windows })).toEqual(["C:\\Users\\me\\AppData\\Roaming\\uv\\uv.toml", "C:\\ProgramData\\uv\\uv.toml"]);
    expect(uvConfigFiles({ platform: "win32", env: {}, home: "C:\\Users\\me" })).toEqual([]);
  });

  it("gives the first file that names an index, written from ~, and one that cannot be read as unknown", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-uv-settings-"));
    const home = join(top, "home");
    mkdirSync(join(home, ".config", "uv"), { recursive: true });
    const places = { platform: process.platform === "win32" ? ("linux" as const) : process.platform, env: { XDG_CONFIG_DIRS: join(top, "etc") }, home };
    expect(uvSettingsReason(places)).toBeUndefined();
    writeFileSync(join(home, ".config", "uv", "uv.toml"), "no-cache = true\n");
    expect(uvSettingsReason(places)).toBeUndefined();
    mkdirSync(join(top, "etc", "uv"), { recursive: true });
    writeFileSync(join(top, "etc", "uv", "uv.toml"), "[[index]]\nurl = 'https://pypi.corp.example/simple'\n");
    expect(uvSettingsReason(places)).toBe(`your uv settings (${join(top, "etc", "uv", "uv.toml")}) name a package index, and the cage builds from PyPI only`);
    writeFileSync(join(home, ".config", "uv", "uv.toml"), "index-url = 'https://pypi.corp.example/simple'\n");
    expect(uvSettingsReason(places)).toBe("your uv settings (~/.config/uv/uv.toml) name a package index, and the cage builds from PyPI only");
    // A uv.toml that is a directory, say: what it sets is unknown, and the cage is refused.
    const odd = { ...places, env: { UV_CONFIG_FILE: join(top, "etc") } };
    expect(uvSettingsReason(odd)).toBe(`your uv settings (${join(top, "etc")}) could not be read, so whether they name a package index is unknown, and the cage builds from PyPI only`);
  });
});
