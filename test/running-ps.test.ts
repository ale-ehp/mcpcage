// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { beforeEach, describe, expect, it, vi } from "vitest";

// The process listing on macOS and Linux, with `ps` replaced: what claudeCodeIsRunning reads from it.

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync }));

import { claudeCodeIsRunning } from "../src/running.js";

describe("claudeCodeIsRunning with ps", () => {
  beforeEach(() => spawnSync.mockReset());

  it("is true when a process named claude is listed, by its path or by its bare name", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "/sbin/launchd\n  /usr/local/bin/claude \n" });
    expect(claudeCodeIsRunning("darwin", {})).toBe(true);
    spawnSync.mockReturnValue({ status: 0, stdout: "bash\nclaude\n" });
    expect(claudeCodeIsRunning("linux", {})).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("ps", ["-axo", "comm="], { encoding: "utf8" });
  });

  it("is false when no listed process is named exactly claude", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "/usr/bin/claude-helper\nnode\nclaudette\n" });
    expect(claudeCodeIsRunning("linux", {})).toBe(false);
  });

  it("is false when ps fails", () => {
    spawnSync.mockReturnValue({ status: 1, stdout: "claude\n" });
    expect(claudeCodeIsRunning("linux", {})).toBe(false);
  });

  it("is false on a platform it cannot list, without running anything", () => {
    expect(claudeCodeIsRunning("freebsd", {})).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("is true inside Claude Code itself, without running anything", () => {
    expect(claudeCodeIsRunning("linux", { CLAUDECODE: "1" })).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
