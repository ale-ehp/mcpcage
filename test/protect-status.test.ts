// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { describe, expect, it } from "vitest";
import { type ProtectReport, type ServerReport, renderReport } from "../src/protect.js";

// The one line the report gives each server: what it says for each way an entry can go wrong.

function server(over: Partial<ServerReport>): ServerReport {
  return {
    client: "claude-desktop",
    clientName: "Claude Desktop",
    file: "/h/c.json",
    scope: "user",
    name: "demo",
    type: "mcpcage",
    command: "mcpcage run demo",
    protectedByMcpcage: true,
    opened: [],
    secrets: [],
    broadAccess: [],
    hostEnv: [],
    movedPlaces: [],
    problems: [],
    ...over,
  } as ServerReport;
}

function render(s: ServerReport): string {
  const report: ProtectReport = {
    files: [{ client: s.client, clientName: s.clientName, scope: s.scope, file: s.file, key: "mcpServers", jsonc: false, exists: true, servers: 1 } as never],
    servers: [s],
  };
  return renderReport(report, { home: "/h" });
}

const effects = (over: object) => ({ hostEnv: [], movedPlaces: [], ...over }) as never;

describe("the status line of a server", () => {
  it.each([
    ["an entry that could not be described", { type: "other", error: "boom" }, "could not be described"],
    ["a remote server", { type: "remote" }, "remote, nothing to cage"],
    ["a docker server", { type: "docker" }, "docker, already containerized"],
    ["an entry with no command", { type: "other", command: "(none)" }, "other"],
    ["an npx server", { type: "npx", protectedByMcpcage: false }, "NOT CAGED"],
    ["a server run with --no-sandbox", { protectedByMcpcage: false }, "pinning and audit only, no isolation"],
    ["a cage that was opened", { opened: ["--network"] }, "caged, with the cage opened"],
    ["a plain cage", {}, "caged"],
    ["a mount run cannot start", { offDrive: "\\\\srv\\share" }, "cannot start: --mount"],
    ["a command line run refuses", { runRefuses: "bad option" }, "cannot start: bad option"],
    ["another program with the name", { mcpcage: "other program" }, "which is not the mcpcage on your PATH"],
    ["a program that was not found", { mcpcage: "not found", command: "gone run demo" }, "is not on your PATH"],
    ["a path that was not found", { mcpcage: "not found", command: "/x/gone run demo" }, "was not found"],
    ["a script run by another program", { mcpcage: "other program", script: "/x/cli.js" }, "which are not mcpcage's cli.js and your node"],
    ["a script not found", { mcpcage: "not found", script: "/x/cli.js" }, "one of which was not found"],
    ["an env that acts on the host", { hostEnv: [{ name: "LD_PRELOAD", what: "loads code" }] }, "caged, but its env runs on your machine"],
    ["an envFile that is unknown", { envFile: { path: "/h/.env" } }, "what its envFile sets is unknown"],
    ["a variable set twice", { twice: [["Path", "PATH"]] }, "sets one variable twice"],
    ["a foreign PATH", { foreignPath: { dirs: ["/evil"], notString: false } }, "its PATH picks other programs"],
    ["moved places", { movedPlaces: ["HOME"] }, "moves what run refuses to mount"],
    ["a batch file", { batch: ".cmd" }, "some clients cannot start a .cmd"],
    ["a cmd.exe re-read", { cmdInjection: "&" }, "re-reads its arguments through cmd.exe"],
  ])("says so for %s", (_name, over, expected) => {
    expect(render(server(over as Partial<ServerReport>))).toContain(expected);
  });
});

describe("what an env or envFile does, line by line", () => {
  it("lists host variables, twice-set names and moved places from the env and the envFile", () => {
    const out = render(
      server({
        hostEnv: [{ name: "NODE_OPTIONS", what: "runs code" }],
        twice: [["Path", "PATH"]],
        movedPlaces: ["HOME"],
        envFile: { path: "/h/.env", effects: effects({ hostEnv: [{ name: "BASH_ENV", what: "runs a script" }], twice: [["Temp", "TEMP"]], movedPlaces: ["XDG_CONFIG_HOME"] }) },
      }),
    );
    expect(out).toContain("env NODE_OPTIONS: runs code");
    expect(out).toContain("envFile BASH_ENV: runs a script");
    expect(out).toContain("env Path, PATH: one variable for Windows");
    expect(out).toContain("envFile Temp, TEMP: one variable for Windows");
    expect(out).toContain("env HOME: differs from yours");
    expect(out).toContain("envFile XDG_CONFIG_HOME: differs from yours");
  });

  it("names a few directories of a foreign PATH and counts the rest", () => {
    const out = render(server({ foreignPath: { dirs: ["/a", "/b", "/c", "/d", "/e"], notString: false } }));
    expect(out).toContain("env PATH: /a is not on your PATH");
    expect(out).toContain("env PATH: and 2 more directories that are not on your PATH");
    const one = render(server({ foreignPath: { dirs: ["/a", "/b", "/c", "/d"], notString: false } }));
    expect(one).toContain("and 1 more directory that is not on your PATH");
  });

  it("says when the value of PATH is not a string", () => {
    expect(render(server({ foreignPath: { dirs: [], notString: true } }))).toContain("env PATH: its value is not a string");
  });
});
