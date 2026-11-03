import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectFake, fakeUserEnv, freshHome, mcpcage, mcpcageWithEnv, root } from "./helpers.js";

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
    let schema: object = { type: "string" };
    for (let level = 1; level < 10_000; level++) schema = { type: "array", items: schema };
    const nested = { name: "nested", inputSchema: schema };
    // Older versions saved listings like this under --strict, as deep as their stack allowed; at
    // 10,000 levels any walk of the definition crashes diff and approve.
    const dir = join(home, "servers", "deep");
    mkdirSync(dir, { recursive: true });
    const pending = { serverId: "deep", seenAt: "2026-11-03T00:00:00.000Z", tools: [nested], violations: [{ kind: "new-tool", name: "nested", after: nested }] };
    writeFileSync(join(dir, "pending.json"), JSON.stringify(pending));
    for (const result of [mcpcage(home, "diff", "deep"), mcpcage(home, "approve", "deep", "--yes")]) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('mcpcage: the pending definition of "nested" is nested more than 256 levels deep, so it is neither shown nor approved.');
    }
    expect(existsSync(join(dir, "pin.json"))).toBe(false);
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
    expect(result.stdout).toContain("caged memory: mcpcage run -- npx -y @modelcontextprotocol/server-memory");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
  });

  it("refuses to mount a directory with credentials unless --allow-sensitive-mount is given", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-cli-"));
    const home = join(top, "home");
    const cage = join(top, "cage");
    const keys = join(home, ".ssh");
    mkdirSync(keys, { recursive: true });
    // No docker on the PATH: a run that got past the check would stop there, never before it.
    const env = fakeUserEnv(home, cage, { PATH: join(top, "no-docker-here") });
    const server = ["--", "npx", "-y", "something"];

    const refused = mcpcageWithEnv(env, "run", "--mount", keys, ...server);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`mcpcage: --mount ${keys}: your SSH keys in ~/.ssh. Pass --allow-sensitive-mount if you really want this.\n`);
    expect(existsSync(cage)).toBe(false); // refused before anything else, the audit log included
    expect(mcpcageWithEnv(env, "prepare", "--mount", `${keys}:rw`, ...server).stderr).toContain("Pass --allow-sensitive-mount");

    const allowed = mcpcageWithEnv(env, "run", "--allow-sensitive-mount", "--mount", keys, ...server);
    expect(allowed.stderr).not.toContain("Pass --allow-sensitive-mount");
    expect(allowed.stderr).toContain("Docker is required"); // past the check, stopped where Docker is needed
  });

  it("refuses host commands unless --no-sandbox is explicit", () => {
    const home = freshHome();
    const result = mcpcage(home, "run", "--", "python3", "server.py");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not an npx command");
  });
});
