// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { describe, expect, it } from "vitest";
import { type ProtectReport, type ScannedFile, type ServerReport, renderReport, uncheckedFiles } from "../src/protect.js";

// The report as a whole: files that are absent or unreadable, the detail lines under a server, and the summary.

function server(over: Partial<ServerReport>): ServerReport {
  return {
    client: "cursor",
    clientName: "Cursor",
    file: "/h/c.json",
    scope: "user",
    name: "demo",
    type: "npx",
    command: "npx -y demo",
    protectedByMcpcage: false,
    opened: [],
    secrets: [],
    broadAccess: [],
    hostEnv: [],
    movedPlaces: [],
    problems: [],
    ...over,
  } as ServerReport;
}

function file(over: Partial<ScannedFile>): ScannedFile {
  return { client: "cursor", clientName: "Cursor", scope: "user", file: "/h/c.json", key: "mcpServers", jsonc: false, exists: true, servers: 0, ...over } as ScannedFile;
}

const high = { rule: "r", severity: "high", field: "description", snippet: "x", message: "hidden" } as const;
const low = { rule: "r", severity: "low", field: "description", snippet: "x", message: "odd" } as const;

describe("renderReport", () => {
  it("counts absent files on one line and lists their clients once", () => {
    const out = renderReport({ files: [file({ exists: false, file: "/a" }), file({ exists: false, file: "/b" }), file({ exists: false, client: "vscode", clientName: "VS Code", file: "/c" })], servers: [] }, { home: "/h" });
    expect(out).toContain("Not found: 3 other configuration files");
    expect(out).toContain("Cursor, VS Code");
    const one = renderReport({ files: [file({ exists: false })], servers: [] }, { home: "/h" });
    expect(one).toContain("Not found: 1 other configuration file\n");
  });

  it("says a file could not be read, and counts it as unchecked", () => {
    const report: ProtectReport = { files: [file({ error: "not valid JSON" })], servers: [] };
    const out = renderReport(report, { home: "/h" });
    expect(out).toContain("could not read this file: not valid JSON");
    expect(out).toContain("1 configuration file could not be checked.");
    expect(uncheckedFiles(report)).toBe(1);
  });

  it("says a file without servers has none", () => {
    expect(renderReport({ files: [file({})], servers: [] }, { home: "/h" })).toContain("(no servers)");
  });

  it("prints the details under a server and sums them up", () => {
    const out = renderReport(
      {
        files: [file({ servers: 3 })],
        servers: [
          server({
            problems: ["an argument is not a string"],
            broadAccess: ["/"],
            secrets: ["API_KEY"],
            installScripts: { status: "found", scripts: ["postinstall"], detail: "prepare runs only for git installs" },
            pypiPackage: "mcp-server-time",
            cannotCage: "it names another index",
            error: "odd entry",
            envFile: { path: "/h/.env" },
            inspection: { tools: 2, findings: [high, low], skipped: [{ path: "/h/.ssh", reason: "credentials" }] },
          }),
          server({
            name: "second",
            secrets: ["A", "B"],
            installScripts: { status: "unknown", scripts: [], detail: "offline, not in cache" },
            envFile: { path: "/h/.env", network: true },
            inspection: { tools: 0, findings: [], error: "timed out" },
          }),
          server({ name: "third", type: "uvx", command: "uvx demo", inspection: { tools: 0, findings: [], noWheel: "demo" } }),
        ],
      },
      { home: "/h" },
    );
    for (const part of [
      "an argument is not a string",
      "access: /",
      "secret in clear text: API_KEY",
      "secrets in clear text: A, B",
      "install scripts: postinstall",
      "install scripts: unknown (offline, not in cache)",
      "asks PyPI for: mcp-server-time",
      "cannot be caged: it names another index",
      "could not describe this entry: odd entry",
      "inspected without ~/.ssh",
      "could not inspect: timed out",
      "builds from source: demo ships no wheel",
      "tools: 2,",
      "3 runs on your machine".replace("3 runs", "3 run"),
      "1 uses a package that ships no wheel",
      "1 server could not be inspected.",
      "have tools with high-severity signs".replace("have", "has"),
    ]) {
      expect(out).toContain(part);
    }
  });

  it("sums up the caged servers, the ones that cannot start and the missing mcpcage", () => {
    const caged = (over: Partial<ServerReport>) => server({ type: "mcpcage", protectedByMcpcage: true, mcpcage: "installed", command: "mcpcage run x", ...over });
    const out = renderReport(
      {
        files: [file({ servers: 6 })],
        servers: [
          caged({ name: "a" }),
          caged({ name: "b", opened: ["--network"] }),
          caged({ name: "c", batch: ".cmd" }),
          caged({ name: "d", mcpcage: "not found" }),
          caged({ name: "e", offDrive: "/net/host/x" }),
          caged({ name: "f", runRefuses: "bad" }),
          server({ name: "g", type: "remote", command: "https://x" }),
        ],
      },
      { home: "/h" },
    );
    expect(out).toContain("1 already runs through mcpcage.");
    expect(out).toContain("1 runs through mcpcage with the cage opened by its options.");
    expect(out).toContain("1 starts mcpcage through a .cmd or .bat file");
    expect(out).toContain("1 starts an mcpcage that could not be found.");
    expect(out).toContain("1 cannot start: it mounts a network path.");
    expect(out).toContain("1 cannot start: mcpcage run refuses its command line");
    expect(out).toContain("1 is remote, already containerized");
  });
});
