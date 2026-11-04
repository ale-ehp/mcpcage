import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installScripts } from "../src/npm-scripts.js";
import { npmProgram } from "../src/sandbox.js";

// What the lookup starts is looked at here, never run: spawnSync answers as npm would for a package
// with a postinstall script.
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; options: { shell?: unknown; env?: NodeJS.ProcessEnv } }>);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const spawnSync = ((file: string, args: string[], options: { shell?: unknown; env?: NodeJS.ProcessEnv }) => {
    spawned.push({ file, args, options });
    return { pid: 0, output: [], status: 0, signal: null, stdout: '{"postinstall": "node install.js"}', stderr: "" };
  }) as unknown as typeof original.spawnSync;
  return { ...original, spawnSync };
});

beforeEach(() => {
  spawned.length = 0;
});

const lookup = (spec: string) => installScripts(spec, { offline: false, cacheDir: mkdtempSync(join(tmpdir(), "mcpcage-npm-")) });

/** Runs `run` as mcpcage would on Windows, started by the node at `node`. */
function onWindows<T>(node: string, run: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "execPath", { ...execPath, value: node });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "execPath", execPath);
  }
}

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
    expect(onWindows(node, () => lookup(spec))).toEqual({ status: "found", scripts: ["postinstall"], detail: "" });
    expect(spawned).toHaveLength(1);
    const [started] = spawned;
    expect({ file: started!.file, args: started!.args.slice(0, 5), shell: started!.options.shell ?? false }).toEqual({
      file: node, args: [script, "view", spec, "scripts", "--json"], shell: false,
    });
    // npm runs with the PATH npm pack runs with: the node's own directory.
    expect(started!.options.env?.PATH).toBe(dirname(node));

    // What cmd.exe would read as commands or variables reaches npm as it is, one argument.
    const odd = 'x@1 & calc "%PATH%" ^& !PATH!|\r\nwhoami';
    expect(onWindows(node, () => lookup(odd))).toMatchObject({ status: "found" });
    expect(spawned[1]!.args.slice(1, 3)).toEqual(["view", odd]);
  });

  it("on Windows without npm's script next to node, says npm is not installed and starts nothing", () => {
    const { node } = nodeInstall(false);
    // Started by name, npm would be looked for in the current directory first, where a project can keep an npm.exe.
    expect(onWindows(node, () => lookup("pkg@1"))).toEqual({ status: "unknown", scripts: [], detail: "npm is not installed" });
    expect(spawned).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("on macOS and Linux is the npm that packs a local package, with its PATH", () => {
    expect(lookup("pkg@1")).toMatchObject({ status: "found" });
    const npm = npmProgram();
    expect(spawned[0]!.file).toBe(npm.file);
    expect(spawned[0]!.args.slice(0, npm.args.length + 2)).toEqual([...npm.args, "view", "pkg@1"]);
    expect(spawned[0]!.options.env?.PATH).toBe(npm.env.PATH);
  });
});
