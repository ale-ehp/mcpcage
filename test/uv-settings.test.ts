import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { entryUvSettingsReason, namesIndex, settingThatStops, uvConfigFiles, uvSettingsReason } from "../src/uv-settings.js";

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
      // uv 0.13.7 asks download.pytorch.org for torch and its kin with it, as --torch-backend.
      'torch-backend = "cpu"',
    ];
    for (const text of found) expect(namesIndex(text), text).toBe(true);
  });

  it("decodes the escapes of a quoted key or table name, as uv's TOML parser does", () => {
    // The first four made uv 0.13.7 ask http://127.0.0.1:9/simple for the server, as the plain names do.
    const found = [
      '"index\\u002Durl" = "https://pypi.corp.example/simple"',
      '[["ind\\u0065x"]]\nurl = "https://pypi.corp.example/simple"',
      '"index\\U0000002Durl" = "https://pypi.corp.example/simple"',
      '"index\\x2Durl" = "https://pypi.corp.example/simple"',
      'pip."find\\u002dlinks" = []',
    ];
    for (const text of found) expect(namesIndex(text), text).toBe(true);
    // A literal string has no escapes, and a value with backslashes is a value (a Windows path).
    const clean = ["'index\\u002Durl' = 1", 'cache-dir = "C:\\\\Users\\\\me\\\\uv"', '"index\\\\u002Durl" = 1'];
    for (const text of clean) expect(namesIndex(text), text).toBe(false);
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

describe("the scan of a uv.toml for what else uvx installs otherwise", () => {
  const index = "name a package index, and the cage builds from PyPI only";
  const versions = (key: string) => `set ${key}: uvx installs other versions there than the cage builds`;
  const source = (key: string) => `set ${key}: uvx builds packages from source there, and the cage installs PyPI wheels only`;

  it("names each key that changes what uvx installs, under any table and as a table, and the index as before", () => {
    // Each run with `uv tool run` 0.13.7 in its image: resolution = "lowest" installed idna 2.0 for
    // idna>=2 (3.20 without it), exclude-newer and exclude-newer-package = { idna = <2020> } idna 2.8,
    // prerelease = "allow" httpx 1.0.dev6 (0.28.1 without it), a [[dependency-metadata]] entry giving
    // idna 3.10 requires-dist six installed six, and no-binary, no-binary-package = ["idna"] chose
    // idna-3.10.tar.gz over its wheel.
    const table: Array<[string, string]> = [
      ['resolution = "lowest"', "set resolution: uvx chooses other versions there than the newest, which the cage installs"],
      ['exclude-newer = "2020-01-01T00:00:00Z"', versions("exclude-newer")],
      ['exclude-newer-package = { idna = "2020-01-01T00:00:00Z" }', versions("exclude-newer-package")],
      ['[exclude-newer-package]\nidna = "2020-01-01T00:00:00Z"', versions("exclude-newer-package")],
      ['prerelease = "allow"', versions("prerelease")],
      ['[[dependency-metadata]]\nname = "idna"\nversion = "3.10"\nrequires-dist = ["six"]', "set dependency-metadata: uvx installs other dependencies there than the cage builds"],
      ['dependency-metadata = [{ name = "idna", version = "3.10", requires-dist = ["six"] }]', "set dependency-metadata: uvx installs other dependencies there than the cage builds"],
      ["no-binary = true", source("no-binary")],
      ['no-binary-package = ["idna"]', source("no-binary-package")],
      ['"no\\u002Dbinary" = true', source("no-binary")],
      ['pip = { no-binary = ["idna"] }', source("no-binary")],
      ['[[index]]\nurl = "https://pypi.corp.example/simple"', index],
      ['no-cache = true\nindex-url = "https://pypi.corp.example/simple"', index],
    ];
    for (const [text, says] of table) expect(settingThatStops(text), text).toBe(says);
    // The first one the file sets.
    expect(settingThatStops('resolution = "lowest"\nindex-url = "x"')).toBe("set resolution: uvx chooses other versions there than the newest, which the cage installs");
    // A false positive only leaves a server uncaged, with the reason: uv's defaults are counted too.
    expect(settingThatStops('resolution = "highest"')).toBe("set resolution: uvx chooses other versions there than the newest, which the cage installs");
  });

  it("skips comments, values and other keys", () => {
    const clean = ["", "# resolution = 'lowest'", 'cache-dir = "/tmp/exclude-newer = x"', "no-build = true", "python-preference = 'managed'", "binary = 1", "no-binary-packages = 1", "[tool.resolution-x]"];
    for (const text of clean) expect(settingThatStops(text), text).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("gives the reason with the file, the user's and the one an entry's variable points to", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-uv-keys-"));
    const home = join(top, "home");
    mkdirSync(join(home, ".config", "uv"), { recursive: true });
    writeFileSync(join(home, ".config", "uv", "uv.toml"), 'exclude-newer = "2020-01-01T00:00:00Z"\n');
    expect(uvSettingsReason({ platform: process.platform, env: {}, home })).toBe(`your uv settings (~/.config/uv/uv.toml) ${versions("exclude-newer")}`);
    expect(entryUvSettingsReason([{ where: "its env", variables: { HOME: home } }], process.platform, top)).toBe(
      `its env sets HOME, so uvx reads the uv settings in ~/home/.config/uv/uv.toml, which ${versions("exclude-newer")}`,
    );
  });
});

describe("where uv's settings are looked for", () => {
  it("on macOS and Linux: UV_CONFIG_FILE, the user's uv.toml under XDG_CONFIG_HOME and ~/.config, the system's under XDG_CONFIG_DIRS, /etc/xdg and /etc", () => {
    // /etc/xdg is uv's own default for XDG_CONFIG_DIRS, unset or empty: most machines have no such variable.
    const plain = ["/home/me/.config/uv/uv.toml", "/etc/xdg/uv/uv.toml", "/etc/uv/uv.toml"];
    expect(uvConfigFiles({ platform: "linux", env: {}, home: "/home/me" })).toEqual(plain);
    expect(uvConfigFiles({ platform: "linux", env: { XDG_CONFIG_DIRS: "" }, home: "/home/me" })).toEqual(plain);
    // Looked at with XDG_CONFIG_DIRS set too: a client started without it reads /etc/xdg.
    expect(uvConfigFiles({ platform: "darwin", env: { UV_CONFIG_FILE: "/x/uv.toml", XDG_CONFIG_HOME: "/xdg", XDG_CONFIG_DIRS: "/opt/conf::/etc/xdg" }, home: "/Users/me" })).toEqual([
      "/x/uv.toml",
      "/xdg/uv/uv.toml",
      "/Users/me/.config/uv/uv.toml",
      "/opt/conf/uv/uv.toml",
      "/etc/xdg/uv/uv.toml",
      "/etc/uv/uv.toml",
    ]);
    // A relative XDG_CONFIG_HOME is ignored, as the XDG specification says.
    expect(uvConfigFiles({ platform: "linux", env: { XDG_CONFIG_HOME: "xdg" }, home: "/home/me" })).toEqual(plain);
    expect(uvConfigFiles({ platform: "linux", env: { UV_CONFIG_FILE: "" }, home: "/home/me" })).toEqual(plain);
  });

  it.skipIf(process.platform === "win32")("takes a relative directory of XDG_CONFIG_DIRS from the current directory, as uv 0.13.7 does", () => {
    // uv joins each directory with uv/uv.toml as it is: XDG_CONFIG_DIRS=conf made it read conf/uv/uv.toml
    // of its current directory ("Found system configuration in: conf/uv/uv.toml").
    const files = uvConfigFiles({ platform: process.platform, env: { XDG_CONFIG_DIRS: `conf:${join("..", "other")}` }, home: "/home/me" });
    expect(files).toContain(resolve("conf", "uv", "uv.toml"));
    expect(files).toContain(resolve("..", "other", "uv", "uv.toml"));
  });

  it("takes a relative UV_CONFIG_FILE from the current directory, as uv takes it on the machine it runs on", () => {
    // Asked about this machine's own system, the only one uv reads it on: another system's current
    // directory is not this one's.
    const here = { platform: process.platform, env: { UV_CONFIG_FILE: join("settings", "uv.toml") }, home: tmpdir(), windows: {} };
    expect(uvConfigFiles(here)[0]).toBe(resolve("settings", "uv.toml"));
  });

  it("on Windows: %APPDATA% as the environment has it and as Windows has it, and %PROGRAMDATA% as Windows has it", () => {
    const windows = { appData: "C:\\Users\\me\\AppData\\Roaming", programData: "C:\\ProgramData" };
    // uv reads the APPDATA variable first (etcetera's Windows strategy), which folder redirection sets
    // to a share, or to a folder named after the user, which the registry gives with %USERNAME% in it.
    const env = { APPDATA: "\\\\fs01\\profiles$\\me\\AppData\\Roaming", XDG_CONFIG_HOME: "C:\\elsewhere" };
    expect(uvConfigFiles({ platform: "win32", env, home: "C:\\Users\\me", windows })).toEqual([
      "\\\\fs01\\profiles$\\me\\AppData\\Roaming\\uv\\uv.toml",
      "C:\\Users\\me\\AppData\\Roaming\\uv\\uv.toml",
      "C:\\ProgramData\\uv\\uv.toml",
    ]);
    // Windows compares the names of variables without case, and so does uv there.
    expect(uvConfigFiles({ platform: "win32", env: { AppData: "H:\\me\\AppData\\Roaming" }, home: "C:\\Users\\me", windows })[0]).toBe("H:\\me\\AppData\\Roaming\\uv\\uv.toml");
    expect(uvConfigFiles({ platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, home: "C:\\Users\\me", windows })).toEqual(["C:\\Users\\me\\AppData\\Roaming\\uv\\uv.toml", "C:\\ProgramData\\uv\\uv.toml"]);
    expect(uvConfigFiles({ platform: "win32", env: {}, home: "C:\\Users\\me" })).toEqual([]);
    // UV_CONFIG_FILE by Windows' rules, on any machine: macOS and Linux took it for a name relative to their current directory.
    expect(uvConfigFiles({ platform: "win32", env: { UV_CONFIG_FILE: "D:/conf/../uv.toml" }, home: "C:\\Users\\me" })).toEqual(["D:\\uv.toml"]);
  });

  it("adds the files an environment's HOME, or USERPROFILE, SYSTEMDRIVE and PROGRAMDATA on Windows, point uv to", () => {
    // A client's environment with an entry's variables in it, as `run` gets it: uv reads its settings where they say.
    expect(uvConfigFiles({ platform: "linux", env: { HOME: "/srv/other" }, home: "/home/me" })).toEqual([
      "/srv/other/.config/uv/uv.toml",
      "/home/me/.config/uv/uv.toml",
      "/etc/xdg/uv/uv.toml",
      "/etc/uv/uv.toml",
    ]);
    const windows = { appData: "C:\\Users\\me\\AppData\\Roaming", programData: "C:\\ProgramData" };
    const env = { USERPROFILE: "D:\\profiles\\me", SystemDrive: "E:", PROGRAMDATA: "F:\\data" };
    expect(uvConfigFiles({ platform: "win32", env, home: "C:\\Users\\me", windows })).toEqual([
      "D:\\profiles\\me\\AppData\\Roaming\\uv\\uv.toml",
      "E:\\ProgramData\\uv\\uv.toml",
      "F:\\data\\uv\\uv.toml",
      "C:\\Users\\me\\AppData\\Roaming\\uv\\uv.toml",
      "C:\\ProgramData\\uv\\uv.toml",
    ]);
  });

  // Real files, so real paths of this machine: those of macOS and Linux here, Windows' in the next one.
  it.skipIf(process.platform === "win32")("on macOS and Linux, gives the first file that names an index, written from ~, and one that cannot be read as unknown", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-uv-settings-"));
    const home = join(top, "home");
    mkdirSync(join(home, ".config", "uv"), { recursive: true });
    const places = { platform: process.platform, env: { XDG_CONFIG_DIRS: join(top, "etc") }, home };
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

  it.runIf(process.platform === "win32")("on Windows, gives the first file that names an index, the user's written from ~, and one that cannot be read as unknown", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-uv-settings-"));
    const home = join(top, "home");
    // APPDATA inside the home directory, where Windows puts it; ProgramData outside it.
    const appData = join(home, "AppData", "Roaming");
    const programData = join(top, "programdata");
    mkdirSync(join(appData, "uv"), { recursive: true });
    // XDG_CONFIG_HOME is not where uv looks on Windows; the environment's APPDATA is, before Windows' own.
    const elsewhere = join(top, "elsewhere");
    mkdirSync(join(elsewhere, "uv"), { recursive: true });
    writeFileSync(join(elsewhere, "uv", "uv.toml"), "index-url = 'https://pypi.corp.example/simple'\n");
    const places = { platform: "win32" as const, env: { XDG_CONFIG_HOME: elsewhere }, home, windows: { appData, programData } };
    expect(uvSettingsReason(places)).toBeUndefined();
    expect(uvSettingsReason({ ...places, env: { APPDATA: elsewhere } })).toBe(`your uv settings (${join(elsewhere, "uv", "uv.toml")}) name a package index, and the cage builds from PyPI only`);
    writeFileSync(join(appData, "uv", "uv.toml"), "no-cache = true\n");
    expect(uvSettingsReason(places)).toBeUndefined();
    mkdirSync(join(programData, "uv"), { recursive: true });
    writeFileSync(join(programData, "uv", "uv.toml"), "[[index]]\nurl = 'https://pypi.corp.example/simple'\n");
    expect(uvSettingsReason(places)).toBe(`your uv settings (${join(programData, "uv", "uv.toml")}) name a package index, and the cage builds from PyPI only`);
    writeFileSync(join(appData, "uv", "uv.toml"), "index-url = 'https://pypi.corp.example/simple'\n");
    expect(uvSettingsReason(places)).toBe("your uv settings (~\\AppData\\Roaming\\uv\\uv.toml) name a package index, and the cage builds from PyPI only");
    // A uv.toml that is a directory, say: what it sets is unknown, and the cage is refused.
    const odd = { ...places, env: { UV_CONFIG_FILE: programData } };
    expect(uvSettingsReason(odd)).toBe(`your uv settings (${programData}) could not be read, so whether they name a package index is unknown, and the cage builds from PyPI only`);
  });
});

describe("the uv settings an entry's own variables point uvx to", () => {
  const index = "index-url = 'https://pypi.corp.example/simple'\n";
  const own = (variables: Record<string, string>) => ({ where: "your environment", variables, own: true });

  it.skipIf(process.platform === "win32")("on macOS and Linux: its HOME, XDG_CONFIG_HOME and XDG_CONFIG_DIRS, by the variable and the file; the user's own environment is left out", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-uv-entry-"));
    const elsewhere = join(top, "elsewhere");
    mkdirSync(join(elsewhere, "uv"), { recursive: true });
    mkdirSync(join(elsewhere, ".config", "uv"), { recursive: true });
    const env = (variables: Record<string, string>) => [own({ XDG_CONFIG_HOME: elsewhere }), { where: "its env", variables }];
    expect(entryUvSettingsReason(env({ XDG_CONFIG_HOME: elsewhere, HOME: elsewhere, XDG_CONFIG_DIRS: elsewhere }), process.platform, top)).toBeUndefined();
    writeFileSync(join(elsewhere, "uv", "uv.toml"), index);
    // The user's own XDG_CONFIG_HOME is theirs: uvSettingsReason looks at it.
    expect(entryUvSettingsReason([own({ XDG_CONFIG_HOME: elsewhere })], process.platform, top)).toBeUndefined();
    expect(entryUvSettingsReason(env({ XDG_CONFIG_HOME: elsewhere }), process.platform, top)).toBe(
      "its env sets XDG_CONFIG_HOME, so uvx reads the uv settings in ~/elsewhere/uv/uv.toml, which name a package index, and the cage builds from PyPI only",
    );
    expect(entryUvSettingsReason(env({ XDG_CONFIG_DIRS: `/nonexistent:${elsewhere}` }), process.platform, "/home/me")).toBe(
      `its env sets XDG_CONFIG_DIRS, so uvx reads the uv settings in ${join(elsewhere, "uv", "uv.toml")}, which name a package index, and the cage builds from PyPI only`,
    );
    // A relative XDG_CONFIG_HOME is ignored by uv, as the XDG specification says.
    expect(entryUvSettingsReason(env({ XDG_CONFIG_HOME: "elsewhere" }), process.platform, top)).toBeUndefined();
    expect(entryUvSettingsReason(env({ HOME: elsewhere }), process.platform, top)).toBeUndefined();
    writeFileSync(join(elsewhere, ".config", "uv", "uv.toml"), "[[index]]\nurl = 'https://pypi.corp.example/simple'\n");
    expect(entryUvSettingsReason([own({}), { where: "its envFile (.env)", variables: { HOME: elsewhere } }, { where: "its env", variables: {} }], process.platform, top)).toBe(
      "its envFile (.env) sets HOME, so uvx reads the uv settings in ~/elsewhere/.config/uv/uv.toml, which name a package index, and the cage builds from PyPI only",
    );
    // A file that is there and cannot be read leaves what it sets unknown.
    rmSync(join(elsewhere, ".config", "uv", "uv.toml"));
    mkdirSync(join(elsewhere, ".config", "uv", "uv.toml"));
    expect(entryUvSettingsReason(env({ HOME: elsewhere }), process.platform, "/home/me")).toBe(
      `its env sets HOME, so uvx reads the uv settings in ${join(elsewhere, ".config", "uv", "uv.toml")}, which could not be read: whether they name a package index is unknown, and the cage builds from PyPI only`,
    );
  });

  it.runIf(process.platform === "win32")("on Windows: its APPDATA, USERPROFILE, SYSTEMDRIVE and PROGRAMDATA, by the variable and the file", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-uv-entry-"));
    const elsewhere = join(top, "elsewhere");
    mkdirSync(join(elsewhere, "uv"), { recursive: true });
    const env = (variables: Record<string, string>) => [own({ APPDATA: elsewhere }), { where: "its env", variables }];
    expect(entryUvSettingsReason(env({ AppData: elsewhere }), "win32", top)).toBeUndefined();
    writeFileSync(join(elsewhere, "uv", "uv.toml"), index);
    expect(entryUvSettingsReason([own({ APPDATA: elsewhere })], "win32", top)).toBeUndefined();
    expect(entryUvSettingsReason(env({ AppData: elsewhere }), "win32", top)).toBe(
      "its env sets AppData, so uvx reads the uv settings in ~\\elsewhere\\uv\\uv.toml, which name a package index, and the cage builds from PyPI only",
    );
    expect(entryUvSettingsReason(env({ PROGRAMDATA: elsewhere }), "win32", top)).toMatch(/^its env sets PROGRAMDATA, so uvx reads the uv settings in /);
    mkdirSync(join(elsewhere, "AppData", "Roaming", "uv"), { recursive: true });
    writeFileSync(join(elsewhere, "AppData", "Roaming", "uv", "uv.toml"), index);
    expect(entryUvSettingsReason(env({ USERPROFILE: elsewhere }), "win32", top)).toMatch(/^its env sets USERPROFILE, so uvx reads the uv settings in ~\\elsewhere\\AppData\\Roaming\\uv\\uv\.toml, /);
  });
});
