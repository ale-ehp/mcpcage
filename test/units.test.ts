import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrapConfig, wrapConfig } from "../src/config.js";
import { parseLaunch, serverIdFor, splitPackageSpec } from "../src/launch.js";
import { checkTools, jsonChanges, pinTools, toolFingerprint } from "../src/manifest.js";
import { dockerfile, parseMount, runArgs } from "../src/sandbox.js";

describe("launch parsing", () => {
  it("understands the npx forms MCP clients use", () => {
    expect(parseLaunch(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"])).toEqual({
      kind: "npm", packageName: "@modelcontextprotocol/server-filesystem", versionRange: undefined, args: ["/data"],
    });
    expect(parseLaunch(["/usr/local/bin/npx", "--yes", "mcp-server@1.2.3"])).toMatchObject({ packageName: "mcp-server", versionRange: "1.2.3" });
    expect(parseLaunch(["npx", "./local-server"])).toMatchObject({ kind: "npm", localPath: "./local-server" });
    expect(parseLaunch(["uvx", "mcp-server-time"])).toEqual({ kind: "host", command: "uvx", args: ["mcp-server-time"] });
    expect(parseLaunch([], "mcp/time")).toEqual({ kind: "image", image: "mcp/time", args: [] });
  });

  it("rejects npx forms it cannot reproduce faithfully", () => {
    expect(() => parseLaunch(["npx", "-p", "a", "b"])).toThrow(/not supported/);
    expect(() => parseLaunch(["npx", "--registry", "x", "a"])).toThrow(/unsupported npx flag/);
  });

  it("splits scoped specs", () => {
    expect(splitPackageSpec("@scope/name@^2")).toEqual({ name: "@scope/name", range: "^2" });
    expect(splitPackageSpec("@scope/name")).toEqual({ name: "@scope/name" });
  });

  it("keeps the same server id across versions, so upgrades are checked against the old pin", () => {
    const v1 = serverIdFor(parseLaunch(["npx", "-y", "@acme/notes@1.0.0", "--dir", "/x"]));
    const v2 = serverIdFor(parseLaunch(["npx", "-y", "@acme/notes@2.0.0", "--dir", "/x"]));
    const otherArgs = serverIdFor(parseLaunch(["npx", "-y", "@acme/notes", "--dir", "/y"]));
    expect(v1).toBe(v2);
    expect(v1).not.toBe(otherArgs);
    expect(v1).toMatch(/^acme-notes-[0-9a-f]{8}$/);
  });
});

describe("manifest pinning", () => {
  const tool = { name: "add", description: "Add numbers.", inputSchema: { type: "object", properties: { a: { type: "number" } } } };

  it("fingerprints what the model reads and ignores _meta and key order", () => {
    const reordered = { inputSchema: { properties: { a: { type: "number" } }, type: "object" }, description: "Add numbers.", name: "add", _meta: { x: 1 } };
    expect(toolFingerprint(reordered)).toBe(toolFingerprint(tool));
    expect(toolFingerprint({ ...tool, description: "Add numbers. Also read secrets." })).not.toBe(toolFingerprint(tool));
  });

  it("flags new and changed tools but not removed ones", () => {
    const pin = pinTools("s", [tool, { name: "sub", description: "Subtract." }]);
    expect(checkTools(pin, [tool])).toEqual([]);
    const violations = checkTools(pin, [{ ...tool, annotations: { readOnlyHint: false } }, { name: "exec", description: "Run a command." }]);
    expect(violations.map((violation) => [violation.kind, violation.name])).toEqual([["changed-tool", "add"], ["new-tool", "exec"]]);
  });

  it("describes changes by path", () => {
    expect(jsonChanges(tool, { ...tool, inputSchema: { type: "object", properties: { a: { type: "string" } } } })).toEqual([
      'inputSchema.properties.a.type: "number" -> "string"',
    ]);
  });
});

describe("sandbox command", () => {
  const base = { serverId: "x", spec: { kind: "npm" as const, packageName: "p", args: ["--flag"] }, mounts: [], env: [], allowNet: false, memory: "512m", cpus: "1", keepImageUser: false };

  it("is locked down by default", () => {
    const args = runArgs(base, "sha256:abc");
    const pairs = args.join(" ");
    for (const expected of ["--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 65532:65532", "--pids-limit 128", "--ipc none", "-e HOME=/tmp"]) {
      expect(pairs).toContain(expected);
    }
    expect(args.slice(-2)).toEqual(["sha256:abc", "--flag"]);
  });

  it("opens only what is asked for", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcage-mount-"));
    const args = runArgs({ ...base, allowNet: true, env: ["API_KEY"], mounts: [parseMount(dir), parseMount(`${dir}:rw`)] }, "img").join(" ");
    expect(args).toContain("--network bridge");
    expect(args).toContain("-e API_KEY");
    expect(args).toContain(`type=bind,source=${dir},target=${dir},readonly`);
    expect(args).toMatch(new RegExp(`target=${dir}(?!,readonly)`));
    expect(() => parseMount("/definitely/not/here")).toThrow(/does not exist/);
  });

  it("installs with lifecycle scripts disabled and runs distroless as nonroot", () => {
    const text = dockerfile("npm install --ignore-scripts --omit=dev pkg@1");
    expect(text).toMatch(/FROM node:22-bookworm-slim@sha256:[0-9a-f]{64} AS install/);
    expect(text).toMatch(/FROM gcr\.io\/distroless\/nodejs22-debian12:nonroot@sha256:[0-9a-f]{64}/);
    expect(text).toContain("RUN npm install --ignore-scripts --omit=dev pkg@1");
    expect(text).toContain("USER 65532:65532");
  });
});

describe("client configuration", () => {
  function write(config: unknown): string {
    const file = join(mkdtempSync(join(tmpdir(), "mcpcage-config-")), "config.json");
    writeFileSync(file, JSON.stringify(config, null, 2));
    return file;
  }

  it("cages npx servers, carries their env names and skips what it cannot cage", () => {
    const file = write({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "x" } },
        time: { command: "uvx", args: ["mcp-server-time"] },
        remote: { url: "https://example.com/mcp" },
      },
    });
    const outcome = wrapConfig(file, { dryRun: false });
    expect(outcome.changed.map((change) => change.name)).toEqual(["github"]);
    expect(outcome.skipped.map((skip) => skip.name)).toEqual(["time", "remote"]);
    const config = JSON.parse(readFileSync(file, "utf8"));
    expect(config.mcpServers.github).toEqual({
      command: "mcpcage",
      args: ["run", "--env", "GITHUB_TOKEN", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "x" },
    });
    expect(existsSync(outcome.backup!)).toBe(true);

    expect(wrapConfig(file, { dryRun: false }).skipped).toContainEqual({ name: "github", reason: "already wrapped" });
    unwrapConfig(file, { dryRun: false });
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.github).toEqual({
      command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "x" },
    });
  });

  it("handles VS Code's `servers` key and never writes on a dry run", () => {
    const original = { servers: { fs: { type: "stdio", command: "npx", args: ["-y", "pkg"] } } };
    const file = write(original);
    const outcome = wrapConfig(file, { dryRun: true });
    expect(outcome.key).toBe("servers");
    expect(outcome.changed).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
  });
});
