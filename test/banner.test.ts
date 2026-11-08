// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { banner } from "../src/banner.js";
import { noDocker } from "./fake-programs.js";
import { cli, fakeUserEnv, root } from "./helpers.js";

const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
/** A terminal as mcpcage sees its stdout: a TTY or not, and how many columns wide. */
const terminal = (columns?: number) => ({ isTTY: true, columns });

describe("the banner", () => {
  it("starts the commands a person reads at a terminal, and nothing else", () => {
    expect(banner(undefined, terminal(80), "1.2.3")).toBe(
      [
      "███╗   ███╗ ██████╗██████╗  ██████╗ █████╗  ██████╗ ███████╗",
      "████╗ ████║██╔════╝██╔══██╗██╔════╝██╔══██╗██╔════╝ ██╔════╝",
      "██╔████╔██║██║     ██████╔╝██║     ███████║██║  ███╗█████╗",
      "██║╚██╔╝██║██║     ██╔═══╝ ██║     ██╔══██║██║   ██║██╔══╝",
      "██║ ╚═╝ ██║╚██████╗██║     ╚██████╗██║  ██║╚██████╔╝███████╗",
      "╚═╝     ╚═╝ ╚═════╝╚═╝      ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
        " mcpcage 1.2.3  ·  MCP servers in a cage",
      ].join("\n"),
    );
    for (const command of [undefined, "help", "--help", "-h", "doctor", "protect"]) expect(banner(command, terminal(80), "1.2.3")).toMatch(/^███╗/);
    // Read by a program, or the MCP channel itself (run's stdout): never.
    for (const command of ["run", "prepare", "inspect", "audit", "diff", "approve", "list", "wrap", "unwrap", "--version", "-v", "unknown"]) {
      expect(banner(command, terminal(80), "1.2.3")).toBeUndefined();
    }
  });

  it("needs a TTY, and in a terminal narrower than the banner gives only the version line", () => {
    for (const stdout of [{ isTTY: false, columns: 80 }, { columns: 80 }, { isTTY: undefined }]) expect(banner("protect", stdout, "1.2.3")).toBeUndefined();
    expect(banner("protect", terminal(61), "1.2.3")).toBe(" mcpcage 1.2.3  ·  MCP servers in a cage");
    expect(banner("protect", terminal(62), "1.2.3")?.split("\n")).toHaveLength(7);
    // A TTY whose width is not known gets the whole banner.
    expect(banner("protect", terminal(), "1.2.3")?.split("\n")).toHaveLength(7);
  });

  it("is never printed when stdout is a pipe", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-banner-"));
    const home = join(top, "home");
    mkdirSync(home);
    const env = fakeUserEnv(home, join(top, "cage"), noDocker(top));
    const help = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: home, env, encoding: "utf8" });
    for (const args of [[], ["help"], ["--help"], ["doctor"], ["protect", "--project", home, "--offline"]]) {
      const result = help(args);
      expect(result.stdout, args.join(" ")).not.toContain("█");
      expect(result.stdout, args.join(" ")).not.toContain("MCP servers in a cage");
    }
    expect(help([]).stdout.startsWith(`mcpcage ${version}: run any MCP server in a cage.\n`)).toBe(true);
  });
});
