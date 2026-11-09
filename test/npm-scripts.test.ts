// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/canonical.js";
import { installScripts, type NpmRunner } from "../src/npm-scripts.js";
import { npmProgram, prepareSandbox } from "../src/sandbox.js";
import { onWindows } from "./fake-programs.js";

// What mcpcage starts is looked at here, never run: spawnSync answers as a running Docker would to
// `docker version`, and as npm would for a package with a postinstall script.
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; options: { shell?: unknown; env?: NodeJS.ProcessEnv } }>);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const spawnSync = ((file: string, args: string[], options: { shell?: unknown; env?: NodeJS.ProcessEnv }) => {
    spawned.push({ file, args, options });
    const stdout = args[0] === "version" ? "28.5.1\n" : '{"postinstall": "node install.js"}';
    return { pid: 0, output: [], status: 0, signal: null, stdout, stderr: "" };
  }) as unknown as typeof original.spawnSync;
  return { ...original, spawnSync };
});

beforeEach(() => {
  spawned.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * What was started besides the reg.exe that mcpcage asks, once, for Windows' places (see windowsEnv):
 * Windows' own, by its full path, with no environment and no shell.
 */
function started(): typeof spawned {
  const registry = spawned.filter((call) => call.file.endsWith("\\System32\\reg.exe") && call.args[0] === "query");
  for (const call of registry) expect({ env: call.options.env, shell: call.options.shell ?? false }).toEqual({ env: {}, shell: false });
  return spawned.filter((call) => !registry.includes(call));
}

const lookup = (spec: string) => installScripts(spec, { offline: false, cacheDir: mkdtempSync(join(tmpdir(), "mcpcage-npm-")) });

/** A node installed as Node's installer does it on Windows, npm's own script next to it; or without one. */
function nodeInstall(withNpm: boolean): { node: string; script: string } {
  const dir = join(mkdtempSync(join(tmpdir(), "mcpcage-nodejs-")), "nodejs");
  const script = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(dirname(script), { recursive: true });
  if (withNpm) writeFileSync(script, "");
  return { node: join(dir, "node.exe"), script };
}

describe("the npm the install scripts lookup starts", () => {
  it("on Windows is the node running mcpcage with npm's own script, never a shell", () => {
    const { node, script } = nodeInstall(true);
    const spec = "@modelcontextprotocol/server-filesystem";
    expect(onWindows(() => lookup(spec), node)).toEqual({ status: "found", scripts: ["postinstall"], detail: "" });
    expect(started()).toHaveLength(1);
    const [npm] = started();
    expect({ file: npm!.file, args: npm!.args.slice(0, 5), shell: npm!.options.shell ?? false }).toEqual({
      file: node, args: [script, "view", spec, "scripts", "--json"], shell: false,
    });
    // npm runs with the PATH npm pack runs with: the node's own directory.
    expect(npm!.options.env?.PATH).toBe(dirname(node));

    // What cmd.exe would read as commands or variables reaches npm as it is, one argument.
    const odd = 'x@1 & calc "%PATH%" ^& !PATH!|\r\nwhoami';
    expect(onWindows(() => lookup(odd), node)).toMatchObject({ status: "found" });
    expect(started()[1]!.args.slice(1, 3)).toEqual(["view", odd]);
  });

  it("on Windows without npm's script next to node, says npm is not installed and starts nothing", () => {
    const { node } = nodeInstall(false);
    // Started by name, npm would be looked for in the current directory first, where a project can keep an npm.exe.
    expect(onWindows(() => lookup("pkg@1"), node)).toEqual({ status: "unknown", scripts: [], detail: "npm is not installed" });
    expect(started()).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("on macOS and Linux is the npm that packs a local package, with its PATH", () => {
    expect(lookup("pkg@1")).toMatchObject({ status: "found" });
    const npm = npmProgram()!;
    expect(spawned[0]!.file).toBe(npm.file);
    expect(spawned[0]!.args.slice(0, npm.args.length + 2)).toEqual([...npm.args, "view", "pkg@1"]);
    expect(spawned[0]!.options.env?.PATH).toBe(npm.env.PATH);
  });
});

describe("the npm that packs a local package", () => {
  it("on Windows without npm's script next to node, is not found, and nothing but docker starts", () => {
    const { node } = nodeInstall(false);
    const top = mkdtempSync(join(tmpdir(), "mcpcage-pack-"));
    const bin = join(top, "bin");
    const pkg = join(top, "local-server");
    mkdirSync(bin);
    mkdirSync(pkg);
    writeFileSync(join(bin, "docker.exe"), "");
    writeFileSync(join(pkg, "package.json"), '{"name": "local-server", "version": "1.0.0"}');
    vi.stubEnv("MCPCAGE_HOME", join(top, "cage"));
    vi.stubEnv("PATH", bin);
    const options = {
      serverId: "local", spec: { kind: "npm" as const, packageName: "", localPath: pkg, args: [] }, mounts: [], env: [],
      allowNet: false, memory: "512m", cpus: "1", keepImageUser: false, rebuild: false, log: () => {},
    };
    expect(() => onWindows(() => prepareSandbox(options), node)).toThrow(`npm pack ${pkg} failed: npm not found next to ${node}`);
    // Started by name, npm would be looked for in the current directory first, where a project can keep an npm.exe.
    expect(started().map((call) => [call.file, call.args[0]])).toEqual([[join(bin, "docker.exe"), "version"]]);
  });
});

describe("the answer npm view gives, read through the runner option", () => {
  /** installScripts with npm replaced by `runner`, on a fresh cache directory. */
  const ask = (runner: NpmRunner, spec = "pkg@1", offline = false) =>
    installScripts(spec, { offline, cacheDir: mkdtempSync(join(tmpdir(), "mcpcage-npm-")), runner });
  const answer = (stdout: string, status: number | null = 0, stderr = "") => () => ({ status, stdout, stderr });

  it("says unknown when npm prints something that is not JSON", () => {
    expect(ask(answer("not json {"))).toEqual({ status: "unknown", scripts: [], detail: "npm view printed something that is not JSON" });
  });

  it("says unknown with the first line of stderr when npm exits non-zero", () => {
    expect(ask(answer("", 1, "boom\nsecond line"))).toEqual({ status: "unknown", scripts: [], detail: "boom" });
    expect(ask(answer("", 2))).toEqual({ status: "unknown", scripts: [], detail: "npm view failed (exit code 2)" });
    expect(ask(answer("", null, "npm is not installed"))).toEqual({ status: "unknown", scripts: [], detail: "npm is not installed" });
  });

  it("says none when npm prints nothing: the package declares no scripts", () => {
    expect(ask(answer(""))).toEqual({ status: "none", scripts: [], detail: "" });
    expect(ask(answer("  \n "))).toEqual({ status: "none", scripts: [], detail: "" });
  });

  it("names the install-time scripts of every version a range matches", () => {
    const range = JSON.stringify([{ preinstall: "a" }, { postinstall: "b", prepare: "c" }]);
    expect(ask(answer(range))).toEqual({ status: "found", scripts: ["preinstall", "postinstall"], detail: "prepare runs only for git installs" });
    expect(ask(answer(JSON.stringify({ install: "x" })))).toEqual({ status: "found", scripts: ["install"], detail: "" });
    expect(ask(answer(JSON.stringify({ dev: "x" })))).toEqual({ status: "none", scripts: [], detail: "" });
  });

  it("says unknown when the answer is not an object: a string, a number, null", () => {
    for (const stdout of ['"a string"', "42", "null"]) {
      expect(ask(answer(stdout))).toEqual({ status: "unknown", scripts: [], detail: "npm view gave an answer of an unexpected shape" });
    }
    expect(ask(answer(JSON.stringify([{ postinstall: "x" }, "not an object"])))).toEqual({
      status: "unknown", scripts: [], detail: "npm view gave an answer of an unexpected shape",
    });
  });

  it("turns npm's error object into a few words, whatever its code", () => {
    const error = (body: unknown, status = 1) => ask(answer(JSON.stringify({ error: body }), status));
    expect(error({ code: "E404" })).toEqual({ status: "unknown", scripts: [], detail: "not found on the npm registry" });
    expect(error({ code: "ENOTCACHED" })).toEqual({ status: "unknown", scripts: [], detail: "not in the npm cache" });
    expect(error({ code: "EACCES", summary: "denied\nmore" })).toEqual({ status: "unknown", scripts: [], detail: "npm view failed: EACCES denied" });
    // A code or summary that is not a string is left out, never converted.
    expect(error({ code: 42, summary: "sum" })).toEqual({ status: "unknown", scripts: [], detail: "npm view failed: sum" });
    expect(error({ code: "E500", summary: 7 })).toEqual({ status: "unknown", scripts: [], detail: "npm view failed: E500" });
    expect(error({})).toEqual({ status: "unknown", scripts: [], detail: "npm view failed with an error of an unexpected shape" });
  });

  it("offline without a cached answer says so, whatever npm answered", () => {
    expect(ask(answer("", 1, "offline boom"), "pkg@1", true)).toEqual({ status: "unknown", scripts: [], detail: "offline, not in cache" });
  });
});

describe("the cache of npm's answers", () => {
  const spec = "cached-pkg@2";
  const cacheFile = (cacheDir: string) => join(cacheDir, "npm-view", `${sha256(spec)}.json`);
  const ask = (cacheDir: string, runner: NpmRunner, offline = false) => installScripts(spec, { offline, cacheDir, runner });

  it("answers from a valid cache without asking npm", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "mcpcage-npm-"));
    mkdirSync(dirname(cacheFile(cacheDir)), { recursive: true });
    writeFileSync(cacheFile(cacheDir), JSON.stringify({ spec, fetchedAt: new Date().toISOString(), scripts: { postinstall: "x" } }));
    const runner = () => { throw new Error("npm must not be asked"); };
    expect(ask(cacheDir, runner)).toEqual({ status: "found", scripts: ["postinstall"], detail: "" });
    // Offline too, and even when the answer is a week old.
    expect(ask(cacheDir, runner, true)).toEqual({ status: "found", scripts: ["postinstall"], detail: "" });
    const old = mkdtempSync(join(tmpdir(), "mcpcage-npm-"));
    mkdirSync(dirname(cacheFile(old)), { recursive: true });
    writeFileSync(cacheFile(old), JSON.stringify({ spec, fetchedAt: new Date(0).toISOString(), scripts: null }));
    expect(ask(old, runner, true)).toEqual({ status: "none", scripts: [], detail: "" });
  });

  it("asks npm again when the cache file is damaged or malformed", () => {
    for (const content of ["not json {", JSON.stringify({ spec, fetchedAt: 42, scripts: null }), JSON.stringify({ spec, fetchedAt: "now", scripts: "not an object" }), JSON.stringify([1, 2])]) {
      const cacheDir = mkdtempSync(join(tmpdir(), "mcpcage-npm-"));
      mkdirSync(dirname(cacheFile(cacheDir)), { recursive: true });
      writeFileSync(cacheFile(cacheDir), content);
      let asked = 0;
      const result = ask(cacheDir, () => { asked++; return { status: 0, stdout: JSON.stringify({ install: "x" }), stderr: "" }; });
      expect(asked).toBe(1);
      expect(result).toEqual({ status: "found", scripts: ["install"], detail: "" });
    }
  });

  it("asks npm again when a fresh cache entry is too old and not offline", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "mcpcage-npm-"));
    mkdirSync(dirname(cacheFile(cacheDir)), { recursive: true });
    writeFileSync(cacheFile(cacheDir), JSON.stringify({ spec, fetchedAt: new Date(0).toISOString(), scripts: null }));
    let asked = 0;
    const result = ask(cacheDir, () => { asked++; return { status: 0, stdout: "", stderr: "" }; });
    expect(asked).toBe(1);
    expect(result).toEqual({ status: "none", scripts: [], detail: "" });
  });
});
