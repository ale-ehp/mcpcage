// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installScripts } from "../src/npm-scripts.js";
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
