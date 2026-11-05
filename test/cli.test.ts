import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit.js";
import { serverIdFor } from "../src/launch.js";
import { pinTools } from "../src/manifest.js";
import { auditDir, checkServerId, serverDir } from "../src/paths.js";
import { noDocker } from "./fake-programs.js";
import { connectFake, fakeUserEnv, freshHome, mcpcage, mcpcageWithEnv, native, root, written } from "./helpers.js";

/** A control, C1 or format character, raw: what a terminal acts on or hides instead of showing. */
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
/** An escape sequence that clears the screen, a carriage return, a one-byte CSI, a right-to-left override and a zero-width space. */
const HOSTILE = "\u001b[2J\r\u009b\u202e\u200b";
/** HOSTILE as mcpcage prints it on its own. */
const SPELLED = "[U+001B][2J\\r[U+009B][U+202E][U+200B]";
/** HOSTILE as mcpcage prints it inside JSON, which escapes ESC and CR itself. */
const SPELLED_IN_JSON = "\\u001b[2J\\r[U+009B][U+202E][U+200B]";
/** macOS and Windows compare names without case, so a writable mount there cannot hold a file setting (see withSettingsReadOnly). */
const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";
/** A mounted path as mcpcage names it: on Windows as the system spells it on disk, long names for 8.3 short ones (C:\Users\RUNNER~1). */
const onDisk = (path: string) => (process.platform === "win32" ? realpathSync.native(path) : path);
/** Why Windows refuses a writable mount that holds a setting (see withSettingsReadOnly). */
const ON_WINDOWS = "on Windows, Docker Desktop lets a server in a writable folder reach a read-only one inside it under another case of its name";

describe("cli", () => {
  it("prints help and version", () => {
    const home = freshHome();
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(mcpcage(home, "--help").stdout).toContain("mcpcage run [options] -- npx -y <package>");
    expect(mcpcage(home, "--help").stdout).toContain("\n  --allow-sensitive-mount\n");
    expect(mcpcage(home, "--help").stdout).toContain("\n  --allow-server-requests\n");
    expect(mcpcage(home, "--version").stdout.trim()).toBe(version);
    expect(mcpcage(home, "nonsense").code).toBe(2);
  });

  it("lists servers with their pinned tools and pending changes", async () => {
    const home = freshHome();
    expect(mcpcage(home, "list").stdout).toContain("No servers yet");
    const first = await connectFake(home, "v1");
    await first.client.listTools();
    await first.close();
    expect(mcpcage(home, "list").stdout).toMatch(/notes .*tools: 2 .*approved/);

    const changed = await connectFake(home, "poisoned");
    await changed.client.listTools().catch(() => undefined);
    await changed.close();
    expect(mcpcage(home, "list").stdout).toContain("PENDING CHANGES");
  });

  it("refuses to show or approve a pending definition nested too deep, and pins nothing", () => {
    const home = freshHome();
    // Older versions saved listings like this under --strict, as deep as their stack allowed; at
    // 10,000 levels any walk of the definition crashes diff and approve. The file is written as text,
    // because JSON.stringify recurses and Node 22 runs out of stack before 10,000 levels.
    const nested = `{"name":"nested","inputSchema":${'{"type":"array","items":'.repeat(9_999)}{"type":"string"}${"}".repeat(9_999)}}`;
    const dir = join(home, "servers", "deep");
    mkdirSync(dir, { recursive: true });
    const violations = `[{"kind":"new-tool","name":"nested","after":${nested}}]`;
    writeFileSync(join(dir, "pending.json"), `{"serverId":"deep","seenAt":"2026-11-03T00:00:00.000Z","tools":[${nested}],"violations":${violations}}`);
    for (const result of [mcpcage(home, "diff", "deep"), mcpcage(home, "approve", "deep", "--yes")]) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('mcpcage: the pending definition of "nested" is nested more than 256 levels deep, so it is neither shown nor approved.');
    }
    expect(existsSync(join(dir, "pin.json"))).toBe(false);
  });

  it("spells out control and format characters in diff and approve, and shows every field of a new tool", () => {
    const home = freshHome();
    const before = { name: `evil${HOSTILE}`, title: "Evil", description: "Reads a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
    const after = {
      ...before,
      title: `Evil${HOSTILE}`,
      description: `Reads a file.${HOSTILE}HIDDEN`,
      inputSchema: { type: "object", properties: { path: { type: "string" }, [`key${HOSTILE}`]: { type: `value${HOSTILE}` } } },
    };
    const added = { ...after, name: `new${HOSTILE}`, outputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { note: "never pinned" } };
    const dir = join(home, "servers", "evil");
    mkdirSync(dir, { recursive: true });
    const violations = [
      { kind: "changed-tool", name: before.name, before, after },
      { kind: "new-tool", name: added.name, after: added },
    ];
    writeFileSync(join(dir, "pending.json"), JSON.stringify({ serverId: "evil", seenAt: "2026-11-04T00:00:00.000Z", tools: [after, added], violations }));

    const diff = mcpcage(home, "diff", "evil");
    const approve = mcpcage(home, "approve", "evil", "--yes");
    expect(approve.code).toBe(0);
    for (const output of [diff.stdout, approve.stdout]) {
      expect(output).not.toMatch(RAW_CONTROL);
      const lines = output.split("\n");
      expect(lines).toEqual(
        expect.arrayContaining([
          `~ tool "evil${SPELLED}" changed since it was approved`,
          `    description: "Reads a file." -> "Reads a file.${SPELLED_IN_JSON}HIDDEN"`,
          `    inputSchema.properties.key${SPELLED}: (absent) -> {"type":"value${SPELLED_IN_JSON}"}`,
          `    title: "Evil" -> "Evil${SPELLED_IN_JSON}"`,
          `+ new tool "new${SPELLED}" was not in the approved manifest`,
          `    title: Evil${SPELLED}`,
          `    description: Reads a file.${SPELLED}HIDDEN`,
          `    inputSchema: {"properties":{"key${SPELLED_IN_JSON}":{"type":"value${SPELLED_IN_JSON}"},"path":{"type":"string"}},"type":"object"}`,
          '    outputSchema: {"type":"object"}',
          '    annotations: {"readOnlyHint":true}',
        ]),
      );
      // The new tool shows its fields in that order, and nothing of _meta, which is not pinned.
      const added = lines.indexOf(`+ new tool "new${SPELLED}" was not in the approved manifest`);
      expect(lines.slice(added + 1, added + 6).map((line) => line.trim().split(":")[0])).toEqual(["title", "description", "inputSchema", "outputSchema", "annotations"]);
      expect(output).not.toContain("never pinned");
    }
  });

  it("spells out control and format characters in audit entries and package names", () => {
    const home = freshHome();
    vi.stubEnv("MCPCAGE_HOME", home);
    try {
      const audit = new AuditLog("evil", "session");
      audit.write("unsolicited-response", { id: "forged\u009b2J\u202e" });
      audit.write("server-request-blocked", { id: "hostile-1", method: "evil\u001b[2K\u2066\u200b" });
    } finally {
      vi.unstubAllEnvs();
    }
    const dir = join(home, "servers", "evil");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server.json"), JSON.stringify({ packageName: `evil${HOSTILE}pkg`, version: "1.0.0\u009b", image: "mcpcage/evil" }));

    const shown = mcpcage(home, "audit", "show", "evil").stdout;
    expect(shown).not.toMatch(RAW_CONTROL);
    expect(shown).toMatch(/unsolicited-response +\{"id":"forged\[U\+009B\]2J\[U\+202E\]"\}/);
    expect(shown).toContain('"method":"evil\\u001b[2K[U+2066][U+200B]"');
    const listed = mcpcage(home, "list").stdout;
    expect(listed).not.toMatch(RAW_CONTROL);
    expect(listed).toContain(`evil  evil${SPELLED}pkg@1.0.0[U+009B]  tools: 0  not approved`);
  });

  it("shows the audit trail without arguments or results", async () => {
    const home = freshHome();
    const session = await connectFake(home, "v1");
    await session.client.listTools();
    await session.client.callTool({ name: "add_note", arguments: { text: "my secret note" } });
    await session.close();
    const shown = mcpcage(home, "audit", "show", "notes").stdout;
    expect(shown).toMatch(/call +\{.*"tool":"add_note".*"argKeys":\["text"\]/);
    expect(shown).not.toContain("my secret note");
  });

  it("refuses to approve without a terminal unless --yes is given", async () => {
    const home = freshHome();
    const first = await connectFake(home, "v1");
    await first.client.listTools();
    await first.close();
    const changed = await connectFake(home, "extra");
    await changed.client.listTools().catch(() => undefined);
    await changed.close();
    const refused = mcpcage(home, "approve", "notes");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("pass --yes");
  });

  it("wraps a client config in a dry run without touching it", () => {
    const home = freshHome();
    const file = join(mkdtempSync(join(tmpdir(), "mcpcage-cli-")), "claude_desktop_config.json");
    const original = { mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } } };
    writeFileSync(file, JSON.stringify(original));
    const result = mcpcage(home, "wrap", file, "--dry-run");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`caged memory: ${written().line} run -- npx -y @modelcontextprotocol/server-memory`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
  });

  it("refuses to mount a directory with credentials unless --allow-sensitive-mount is given", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const home = join(top, "home");
    const cage = join(top, "cage");
    const keys = join(home, ".ssh");
    mkdirSync(keys, { recursive: true });
    // No Docker to reach: a run that got past the check would stop there, never before it.
    const env = fakeUserEnv(home, cage, noDocker(top));
    const server = ["--", "npx", "-y", "something"];

    const refused = mcpcageWithEnv(env, "run", "--mount", keys, ...server);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`mcpcage: --mount ${keys}: your SSH keys in ${native("~/.ssh")}. Pass --allow-sensitive-mount if you really want this.\n`);
    expect(existsSync(cage)).toBe(false); // refused before anything else, the audit log included
    expect(mcpcageWithEnv(env, "prepare", "--mount", `${keys}:rw`, ...server).stderr).toContain("Pass --allow-sensitive-mount");

    const allowed = mcpcageWithEnv(env, "run", "--allow-sensitive-mount", "--mount", keys, ...server);
    expect(allowed.stderr).not.toContain("Pass --allow-sensitive-mount");
    expect(allowed.stderr).toContain("Docker is required"); // past the check, stopped where Docker is needed
  });

  it("refuses a memory or CPU limit that is not positive, which Docker reads as no limit", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const cage = join(top, "cage");
    // No Docker to reach: a run that got past the check would stop there, never before it.
    const env = fakeUserEnv(join(top, "home"), cage, noDocker(top));
    const server = ["--", "npx", "-y", "something"];
    const memory = (value: string) => `mcpcage: --memory ${value}: give a positive size, such as 512m or 2g (Docker reads 0 as no limit)\n`;
    const cpus = (value: string) => `mcpcage: --cpus ${value}: give a positive number of CPUs, such as 1 or 0.5 (Docker reads 0 as no limit)\n`;
    for (const value of ["0", "0g", "0.0", "-1", "lots"]) {
      const refused = mcpcageWithEnv(env, "run", `--memory=${value}`, ...server);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(memory(value));
    }
    for (const value of ["0", "0.0", "-0.5", "one"]) {
      const refused = mcpcageWithEnv(env, "run", `--cpus=${value}`, ...server);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(cpus(value));
    }
    expect(mcpcageWithEnv(env, "prepare", "--memory", "0", ...server).stderr).toBe(memory("0"));
    expect(mcpcageWithEnv(env, "run", "--image", "mcp/time", "--cpus", "0").stderr).toBe(cpus("0"));
    expect(existsSync(cage)).toBe(false); // refused before anything else, the audit log included
    expect(mcpcageWithEnv(env, "run", "--memory", "1.5g", "--cpus", ".5", ...server).stderr).toContain("Docker is required");
  });

  it("refuses a writable mount of a shell startup file unless --allow-sensitive-mount is given", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const home = join(top, "home");
    const cage = join(top, "cage");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".zshrc"), "# runs at every new terminal\n");
    const env = fakeUserEnv(home, cage, noDocker(top));

    const refused = mcpcageWithEnv(env, "run", "--mount", "~/.zshrc:rw", "--", "npx", "-y", "something");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`mcpcage: --mount ${join(home, ".zshrc")}: the commands your shell runs in ${native("~/.zshrc")}. Pass --allow-sensitive-mount if you really want this.\n`);
    expect(existsSync(cage)).toBe(false);
  });

  it("looks for git's and the editors' settings in a writable mount at every run, and refuses a symlinked one", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const project = join(top, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    // No Docker to reach: a run that got past the settings would stop there.
    const env = fakeUserEnv(join(top, "home"), join(top, "cage"), noDocker(top));
    const server = ["--", "npx", "-y", "something"];
    const first = mcpcageWithEnv(env, "run", "--mount", `${project}:rw`, ...server).stderr;
    if (process.platform === "win32") {
      // There no read-only mount inside a writable one holds: the repository refuses the start.
      expect(first).toContain(`${join(onDisk(project), ".git")} cannot be kept read-only: ${ON_WINDOWS}`);
      rmSync(join(project, ".git"), { recursive: true });
    } else {
      expect(first).toContain("Docker is required");
    }

    mkdirSync(join(top, "elsewhere"));
    symlinkSync(join(top, "elsewhere"), join(project, ".vscode"));
    const refused = mcpcageWithEnv(env, "run", "--mount", `${project}:rw`, ...server);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`mcpcage: --mount ${onDisk(project)}:rw: ${join(onDisk(project), ".vscode")} is a symlink`);
    // Read-only, the same directory needs nothing on top of it.
    expect(mcpcageWithEnv(env, "run", "--mount", project, ...server).stderr).toContain("Docker is required");
  });

  it.skipIf(FOLDS_CASE)("follows a .git file to its repository at every run, and refuses to start when it cannot keep that read-only", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const project = join(top, "project");
    const file = join(project, "app", ".git");
    mkdirSync(join(project, "app"), { recursive: true });
    writeFileSync(file, "gitdir: ../meta\n");
    // No Docker to reach: a run that got past the settings would stop there.
    const env = fakeUserEnv(join(top, "home"), join(top, "cage"), noDocker(top));
    const server = ["--", "npx", "-y", "something"];
    const refused = mcpcageWithEnv(env, "run", "--mount", `${project}:rw`, ...server);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      `mcpcage: --mount ${project}:rw: ${file} names ../meta, which does not exist: the server could make it a repository of its own there, ` +
        `and mcpcage keeps the repository a .git file leads to read-only in a writable mount. Point ${file} at its repository, or remove it, or mount ${project} read-only by dropping :rw.\n`,
    );
    // Once the repository is there, it is kept read-only and the run goes on.
    mkdirSync(join(project, "meta"));
    expect(mcpcageWithEnv(env, "run", "--mount", `${project}:rw`, ...server).stderr).toContain("Docker is required");
  });

  it.runIf(FOLDS_CASE)("refuses a writable mount that holds a .git file or .mcp.json on macOS and Windows, and starts with it read-only", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const project = join(top, "project");
    mkdirSync(join(project, "app"), { recursive: true });
    writeFileSync(join(project, ".mcp.json"), "{}\n");
    // No Docker to reach: a run that got past the settings would stop there.
    const env = fakeUserEnv(join(top, "home"), join(top, "cage"), noDocker(top));
    const server = ["--", "npx", "-y", "something"];
    const system = process.platform === "win32" ? "Windows" : "macOS";
    const refused = mcpcageWithEnv(env, "run", "--mount", `${project}:rw`, ...server);
    expect(refused.code).toBe(1);
    const shown = onDisk(project);
    expect(refused.stderr).toBe(
      process.platform === "win32"
        ? `mcpcage: --mount ${shown}:rw: ${join(shown, ".mcp.json")} cannot be kept read-only: ${ON_WINDOWS}, here ${join(shown, ".MCP.JSON")}. ` +
            `Mount a narrower folder that holds no git or editor settings, or mount ${shown} read-only by dropping :rw.\n`
        : `mcpcage: --mount ${shown}:rw: ${join(shown, ".mcp.json")} is a file, and on ${system} the server could change it as ${join(shown, ".MCP.JSON")}, ` +
            `the same file under another case of its name, which a read-only mount does not cover. Mount a narrower directory, or mount ${shown} read-only by dropping :rw.\n`,
    );
    expect(mcpcageWithEnv(env, "run", "--mount", project, ...server).stderr).toContain("Docker is required");
    // Looked for at every run: a .git file that appeared since is refused the same way.
    expect(mcpcageWithEnv(env, "run", "--mount", `${join(project, "app")}:rw`, ...server).stderr).toContain("Docker is required");
    writeFileSync(join(project, "app", ".git"), "gitdir: ../meta\n");
    expect(mcpcageWithEnv(env, "run", "--mount", `${join(project, "app")}:rw`, ...server).stderr).toContain(
      process.platform === "win32" ? `${join(shown, "app", ".git")} cannot be kept read-only: ${ON_WINDOWS}` : `${join(shown, "app", ".git")} is a file, and on ${system}`,
    );
  });

  it("refuses a mount of the account's own ~/.ssh when HOME names another directory", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const decoy = join(top, "decoy-home");
    const cage = join(top, "cage");
    mkdirSync(decoy);
    // A client sets HOME from the server entry's env; the account's home stays where the keys are.
    const keys = join(userInfo().homedir, ".ssh");
    const env = fakeUserEnv(decoy, cage, noDocker(top));

    const refused = mcpcageWithEnv(env, "run", "--mount", `${keys}:rw`, "--", "npx", "-y", "something");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`mcpcage: --mount ${keys}: your SSH keys in ${keys}. Pass --allow-sensitive-mount if you really want this.\n`);
    expect(existsSync(cage)).toBe(false); // refused before anything else: nothing was mounted, nothing written
  });

  it("wrap prints the values it moved from the env into the arguments as ***", () => {
    const home = freshHome();
    const file = join(mkdtempSync(join(tmpdir(), "mcpcage-cli-")), "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { tuned: { command: "npx", args: ["-y", "pkg"], env: { NODE_OPTIONS: "--max-old-space-size=4096", API_KEY: "x" } } } }));
    const result = mcpcage(home, "wrap", file, "--dry-run");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`caged tuned: ${written().line} run --env NODE_OPTIONS=*** --env API_KEY -- npx -y pkg\n`);
    expect(result.stdout).not.toContain("4096");
  });

  it("refuses host commands unless --no-sandbox is explicit", () => {
    const home = freshHome();
    const result = mcpcage(home, "run", "--", "python3", "server.py");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not an npx command");
  });

  it("reads a uvx command line but does not build it yet: run and prepare refuse it, saying so", () => {
    const home = freshHome();
    const NOT_BUILT = "uvx servers are not built yet: this version of mcpcage cages npx servers and --image containers only";
    for (const server of [["uvx", "mcp-server-time"], ["uv", "tool", "run", "--from", "mcp-server-time@2026.1.26", "mcp-server-time"]]) {
      const run = mcpcage(home, "run", "--", ...server);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(`mcpcage: ${NOT_BUILT}. Pass --no-sandbox to start it on the host, with pinning and audit but no isolation.\n`);
      const prepare = mcpcage(home, "prepare", "--", ...server);
      expect(prepare.code).toBe(1);
      expect(prepare.stderr).toBe(`mcpcage: ${NOT_BUILT}; nothing to prepare\n`);
    }
    // A line the cage would refuse says why, never with the value of the flag.
    const refused = mcpcage(home, "run", "--", "uvx", "--index-url=https://user:s3cret@pypi.example/simple", "mcp-server-time");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe("mcpcage: uvx --index-url: installs from another index than PyPI, and the cage builds from PyPI only\n");
  });

  it.runIf(process.platform !== "win32")("starts a uvx line with --no-sandbox as the host command it was, under the id it had", () => {
    const home = freshHome();
    const dir = mkdtempSync(join(tmpdir(), "mcpcage-uvx-"));
    const uvx = join(dir, "uvx");
    writeFileSync(uvx, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Refused in the cage, started on the host as before: --no-sandbox never needed the cage's reading of it.
    for (const args of [["mcp-server-time"], ["--index-url=https://pypi.example/simple", "mcp-server-time"]]) {
      const id = serverIdFor({ kind: "host", command: uvx, args });
      const result = mcpcage(home, "run", "--no-sandbox", "--", uvx, ...args);
      expect(result.stderr).toContain(`mcpcage: WARNING ${id} runs on the host without isolation (--no-sandbox).`);
      expect(existsSync(join(home, "audit", id))).toBe(true);
    }
  });
});

describe("approving past the pin limit", () => {
  it("refuses before asking when the pending tools would take the pin past 10,000, and keeps them pending", () => {
    const home = freshHome();
    const dir = join(home, "servers", "limit");
    mkdirSync(dir, { recursive: true });
    const pinFile = join(dir, "pin.json");
    const pendingFile = join(dir, "pending.json");
    writeFileSync(pinFile, JSON.stringify(pinTools("limit", Array.from({ length: 10_000 }, (_, n) => ({ name: `tool_${n}` })))));
    // Saved as an older version saved it, which counted the pending tools alone.
    const oneMore = { name: "one_more", description: "One tool more." };
    const pending = JSON.stringify({ serverId: "limit", seenAt: "2026-11-03T00:00:00.000Z", tools: [oneMore], violations: [{ kind: "new-tool", name: "one_more", after: oneMore }] });
    writeFileSync(pendingFile, pending);
    const refusal = `mcpcage: approving the pending tools of limit would pin 10,001 tools, more than the 10,000 one server may have, so nothing was approved. Delete ${pendingFile} to discard them.\n`;
    // Before, approve --yes made a pin of 10,001. Without --yes, the refusal comes before the question.
    for (const args of [["--yes"], []]) {
      const result = mcpcage(home, "approve", "limit", ...args);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(refusal);
      expect(result.stdout).toBe("");
    }
    expect(Object.keys((JSON.parse(readFileSync(pinFile, "utf8")) as { tools: object }).tools)).toHaveLength(10_000);
    expect(readFileSync(pendingFile, "utf8")).toBe(pending);
    expect(existsSync(join(home, "audit", "limit"))).toBe(false);
  });
});

describe("names of a million characters in diff and approve", () => {
  it("shows an excerpt of each tool name, key and path, with its full length", () => {
    const home = freshHome();
    const dir = join(home, "servers", "long");
    mkdirSync(dir, { recursive: true });
    const huge = "\u009b".repeat(1_000_000);
    const changed = `c${"\u009b".repeat(999_999)}`;
    // A new tool with a field of that name, and a changed tool that adds a property of that name.
    const added = { name: huge, description: "Adds.", [huge]: "x" };
    const before = { name: changed, description: "Old.", inputSchema: { type: "object", properties: {} } };
    const after = { name: changed, description: "Old.", inputSchema: { type: "object", properties: { [huge]: { type: "string" } } } };
    const violations = [
      { kind: "new-tool", name: huge, after: added },
      { kind: "changed-tool", name: changed, before, after },
    ];
    writeFileSync(join(dir, "pending.json"), JSON.stringify({ serverId: "long", seenAt: "2026-11-04T00:00:00.000Z", tools: [added, after], violations }));
    const spelled = (count: number) => "[U+009B]".repeat(count);
    const path = `inputSchema.properties.${huge}`;
    const pathShown = `inputSchema.properties.${spelled(22)}... (${path.length} chars)`;
    // Before, each name, key and path was spelled out whole: 8 MB apiece.
    for (const result of [mcpcage(home, "diff", "long"), mcpcage(home, "approve", "long", "--yes")]) {
      expect(result.stdout.length).toBeLessThan(4_000);
      const lines = result.stdout.split("\n");
      expect(lines).toContain(`+ new tool "${spelled(25)}... (1000000 chars)" was not in the approved manifest`);
      expect(lines).toContain(`    ${spelled(25)}... (1000000 chars): x`);
      expect(lines).toContain(`~ tool "c${spelled(24)}... (1000000 chars)" changed since it was approved`);
      expect(lines).toContain(`    ${pathShown}: (absent) -> {"type":"string"}`);
    }
  });
});

describe("what wrap and unwrap print", () => {
  it("spells out the control and format characters of server names, commands and skip reasons", () => {
    const home = freshHome();
    const file = join(home, "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { [`notes${HOSTILE}`]: { command: "npx", args: ["-y", "pkg-a", `x${HOSTILE}`] }, [`time${HOSTILE}`]: { command: `uvx${HOSTILE}` } } }));
    const wrapped = mcpcage(home, "wrap", file, "--dry-run");
    expect(wrapped.code).toBe(0);
    expect(wrapped.stdout).not.toMatch(RAW_CONTROL);
    expect(wrapped.stdout).toContain(`  caged notes${SPELLED}: ${written().line} run -- npx -y pkg-a x${SPELLED}\n`);
    expect(wrapped.stdout).toContain(`  skipped time${SPELLED}: uvx${SPELLED}: only npx servers can be caged in this version\n`);

    writeFileSync(file, JSON.stringify({ mcpServers: { [`back${HOSTILE}`]: { command: "mcpcage", args: ["run", "--", "npx", "-y", `pkg${HOSTILE}`] }, [`odd${HOSTILE}`]: { command: "mcpcage", args: ["run"] } } }));
    const unwrapped = mcpcage(home, "unwrap", file, "--dry-run");
    expect(unwrapped.code).toBe(0);
    expect(unwrapped.stdout).not.toMatch(RAW_CONTROL);
    expect(unwrapped.stdout).toContain(`  restored back${SPELLED}: npx -y pkg${SPELLED}\n  skipped odd${SPELLED}: unexpected mcpcage arguments\n`);
  });

  it("spells them out in the lines about building the images", () => {
    const home = freshHome();
    const file = join(home, "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { [`notes${HOSTILE}`]: { command: "npx", args: ["-y", "pkg-a"] } } }));
    // No Docker to reach: the build fails, and says so with the server's name.
    const result = mcpcageWithEnv({ ...process.env, MCPCAGE_HOME: home, ...noDocker(home) }, "wrap", file);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`  caged notes${SPELLED}: ${written().line} run -- npx -y pkg-a\n`);
    expect(result.stderr).not.toMatch(RAW_CONTROL);
    expect(result.stderr).toContain(`  could not build notes${SPELLED}: Docker is required to cage a server`);
  });
});

describe("what run prints from an entry's arguments", () => {
  // A client starts `mcpcage run` with an entry's arguments, and shows or logs what it writes to stderr.
  it("spells out control and format characters in error messages and unknown commands", () => {
    const home = freshHome();
    const refused = mcpcage(home, "run", "--", `server${HOSTILE}`);
    expect(refused.code).toBe(1);
    expect(refused.stderr).not.toMatch(RAW_CONTROL);
    expect(refused.stderr).toContain(`mcpcage: "server${SPELLED}" is not an npx command.`);
    const unknown = mcpcage(home, `wrap${HOSTILE}`);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).not.toMatch(RAW_CONTROL);
    expect(unknown.stderr).toContain(`mcpcage: unknown command "wrap${SPELLED}"\n`);
  });

  it("spells them out in the warning about a sensitive mount", () => {
    const home = freshHome();
    const fakeHome = join(home, "home");
    // Windows allows no C0 control character in a file name: there the name keeps the others.
    const windows = process.platform === "win32";
    const hostile = windows ? "[2J\u009b\u202e\u200b" : HOSTILE;
    const spelled = windows ? "[2J[U+009B][U+202E][U+200B]" : SPELLED;
    const key = join(fakeHome, ".ssh", `key${hostile}`);
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(key, "");
    // The warning comes before Docker is needed: run gets as far as it with no Docker to reach.
    const env = fakeUserEnv(fakeHome, join(home, "cage"), noDocker(home));
    const result = mcpcageWithEnv(env, "run", "--image", "example/server", "--allow-sensitive-mount", "--mount", key, "--", "serve");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Docker is required");
    expect(result.stderr).not.toMatch(RAW_CONTROL);
    expect(result.stderr).toContain(`mcpcage: WARNING --mount ${key.replace(hostile, spelled)} gives example-server-`);
  });
});

describe("server ids", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A fresh machine: mcpcage's store two levels down, and the commands run with no Docker to reach. */
  function machine() {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-ids-"));
    const home = join(top, "home");
    mkdirSync(home);
    const cage = join(top, "cage", "store");
    // No Docker to reach: a run that got past the check would stop there, after the audit log.
    const env = fakeUserEnv(home, cage, noDocker(top));
    return { top, cage, env };
  }

  it("refuses an id that is not one plain name before anything is written, in every command that takes one", () => {
    const { top, cage, env } = machine();
    const server = ["--", "npx", "-y", "something"];
    const refused: Array<[string[], string]> = [
      [["run", "--id", "../../x", ...server], '--id: "../../x"'],
      [["run", "--id", "a/b", ...server], '--id: "a/b"'],
      [["prepare", "--id", "../x", ...server], '--id: "../x"'],
      [["diff", "../x"], '"../x"'],
      [["approve", "../x", "--yes"], '"../x"'],
      [["audit", "show", ".."], '".."'],
      [["audit", "verify", "../x"], '"../x"'],
    ];
    for (const [args, shown] of refused) {
      const result = mcpcageWithEnv(env, ...args);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(`mcpcage: ${shown} is not a valid server id: use letters, digits, dots, dashes and underscores\n`);
    }
    // Nothing appeared, in the store or next to it: run --id ../../x wrote its audit log in top/cage/x.
    expect(readdirSync(top).sort()).toEqual(["home"]);
    expect(readdirSync(join(top, "home"))).toEqual([]);
    expect(existsSync(cage)).toBe(false);
  });

  it("accepts letters, digits, dots, dashes and underscores", () => {
    const { cage, env } = machine();
    for (const id of ["notes", "my.server_1-2"]) {
      const result = mcpcageWithEnv(env, "run", "--id", id, "--", "npx", "-y", "something");
      expect(result.stderr).not.toContain("is not a valid server id");
      expect(result.stderr).toContain("Docker is required"); // past the check, stopped where Docker is needed
      expect(existsSync(join(cage, "audit", id))).toBe(true);
    }
    for (const id of ["0", "a".repeat(100), "A.b-C_9"]) expect(checkServerId(id)).toBe(id);
    for (const id of ["", ".", "..", ".hidden", "-x", "_x", "a".repeat(101), "a b", "a\\b", "a\nb", "notes\n", "é"]) {
      expect(() => checkServerId(id)).toThrow("is not a valid server id");
    }
  });

  it("never gives a directory outside the store, whatever id reaches it", () => {
    const store = join(mkdtempSync(join(tmpdir(), "mcpcage-ids-")), "store");
    vi.stubEnv("MCPCAGE_HOME", store);
    expect(serverDir("notes")).toBe(join(store, "servers", "notes"));
    expect(auditDir("notes")).toBe(join(store, "audit", "notes"));
    for (const id of ["../../escaped", "..", "", ".", "notes/../../x"]) {
      expect(() => serverDir(id)).toThrow("leads outside mcpcage's store");
      expect(() => auditDir(id)).toThrow("leads outside mcpcage's store");
    }
    // Each area is a store of its own: pins never land among the audit logs, nor logs among the pins.
    expect(() => serverDir("../audit/notes")).toThrow("leads outside mcpcage's store");
    expect(() => auditDir("../servers/notes")).toThrow("leads outside mcpcage's store");
  });
});
