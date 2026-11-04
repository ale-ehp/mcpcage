import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unwrapConfig, wrapConfig } from "../src/config.js";

// The last step of a rewrite, the rename over the configuration, fails on demand, as it can on a
// full disk or when mcpcage is killed: the client must still find its whole old file.
const rename = vi.hoisted(() => ({ fail: false }));
// One path whose question fails, in place of whatever else could trip up the rewrite of one entry.
const lookup = vi.hoisted(() => ({ failFor: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const renameSync = (from: PathLike, to: PathLike) => {
    if (rename.fail) throw Object.assign(new Error(`EIO: i/o error, rename '${String(from)}' -> '${String(to)}'`), { code: "EIO" });
    original.renameSync(from, to);
  };
  const existsSync = (path: PathLike) => {
    if (lookup.failFor !== undefined && path === lookup.failFor) throw Object.assign(new Error(`EIO: i/o error, access '${lookup.failFor}'`), { code: "EIO" });
    return original.existsSync(path);
  };
  return { ...original, renameSync, existsSync };
});

afterEach(() => {
  rename.fail = false;
  lookup.failFor = undefined;
});

const memory = { mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } } };

/** A configuration in a fresh directory, written with the given mode whatever the umask. */
function configFile(mode = 0o600): { dir: string; file: string; bytes: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "mcpcage-write-"));
  const file = join(dir, "claude_desktop_config.json");
  writeFileSync(file, `${JSON.stringify(memory, null, 2)}\n`);
  chmodSync(file, mode);
  return { dir, file, bytes: readFileSync(file) };
}

const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("wrap and unwrap replace the configuration atomically", () => {
  it("keep the file's mode and back up exactly the bytes they read", () => {
    const { dir, file, bytes } = configFile(0o640);
    const outcome = wrapConfig(file, { dryRun: false, command: "/opt/mcpcage" });
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.memory.command).toBe("/opt/mcpcage");
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(outcome.backup).toBe(`${file}.mcpcage.bak`);
    expect(readFileSync(outcome.backup!)).toEqual(bytes);
    expect(statSync(outcome.backup!).mode & 0o777).toBe(0o640);
    expect(leftovers(dir)).toEqual([]);
  });

  it("keep a symlinked configuration's link and change the file it points to", () => {
    // Dotfiles: the client reads a link in its own directory to a file kept in a repository.
    const top = mkdtempSync(join(tmpdir(), "mcpcage-write-"));
    const dotfiles = join(top, "dotfiles");
    const client = join(top, "client");
    for (const dir of [dotfiles, client]) mkdirSync(dir);
    const target = join(dotfiles, "claude.json");
    writeFileSync(target, `${JSON.stringify(memory, null, 2)}\n`);
    const before = readFileSync(target);
    const link = join(client, "claude_desktop_config.json");
    symlinkSync(target, link);

    const wrapped = wrapConfig(link, { dryRun: false, command: "/opt/mcpcage" });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(JSON.parse(readFileSync(target, "utf8")).mcpServers.memory.command).toBe("/opt/mcpcage");
    expect(readFileSync(wrapped.backup!)).toEqual(before);
    unwrapConfig(link, { dryRun: false });
    expect(readlinkSync(link)).toBe(target);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(memory);
    expect([...leftovers(dotfiles), ...leftovers(client)]).toEqual([]);
  });

  it("leave the file byte-identical when the final rename fails", () => {
    const { dir, file, bytes } = configFile(0o640);
    rename.fail = true;
    expect(() => wrapConfig(file, { dryRun: false, command: "/opt/mcpcage" })).toThrow("EIO: i/o error, rename");
    expect(readFileSync(file)).toEqual(bytes);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(leftovers(dir)).toEqual([]);

    // The same for unwrap, on a file that wrap did change.
    rename.fail = false;
    wrapConfig(file, { dryRun: false, command: "/opt/mcpcage" });
    const wrapped = readFileSync(file);
    rename.fail = true;
    expect(() => unwrapConfig(file, { dryRun: false })).toThrow("EIO: i/o error, rename");
    expect(readFileSync(file)).toEqual(wrapped);
    expect(leftovers(dir)).toEqual([]);
  });
});

describe("one entry whose rewrite fails", () => {
  it("is left as it is, with the reason, and the other entries of the file are rewritten", () => {
    // Before, the error left the command and every other server of the file as it was.
    const { file } = configFile();
    const stuck = { command: "npx", args: ["-y", "@acme/files-mcp", "/mcpcage-test/unreadable"] };
    writeFileSync(file, `${JSON.stringify({ mcpServers: { stuck, ...memory.mcpServers } }, null, 2)}\n`);
    lookup.failFor = "/mcpcage-test/unreadable";
    const outcome = wrapConfig(file, { dryRun: false, command: "/opt/mcpcage" });
    expect(outcome.skipped).toEqual([{ name: "stuck", reason: "could not rewrite it: EIO: i/o error, access '/mcpcage-test/unreadable'" }]);
    expect(outcome.changed.map((change) => change.name)).toEqual(["memory"]);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).toEqual({
      stuck,
      memory: { command: "/opt/mcpcage", args: ["run", "--", "npx", "-y", "@modelcontextprotocol/server-memory"] },
    });
  });
});
