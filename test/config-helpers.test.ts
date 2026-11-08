// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { describe, expect, it } from "vitest";
import { createBackup, envReason, hostPath } from "../src/config.js";

// Small helpers of config.ts: the reasons given for an env that cannot be moved, the host path of an
// argument, and the backup names.

const none = { hostEnv: [], movedPlaces: [] };

describe("envReason", () => {
  it("names a host variable that an envFile sets, with the file", () => {
    const reason = envReason(none as never, { path: "/p/.env", effects: { hostEnv: [{ name: "LD_PRELOAD" }], movedPlaces: [] } as never });
    expect(reason).toContain("its envFile sets LD_PRELOAD");
    expect(reason).toContain("/p/.env");
  });

  it("says an envFile that is not a string is unknown", () => {
    expect(envReason(none as never, {})).toContain("its envFile is not a string");
  });

  it("says an envFile that could not be read is unknown", () => {
    expect(envReason(none as never, { path: "/p/.env" })).toContain("could not be read");
  });

  it("names variables that are set to another value than the user's, from env or envFile", () => {
    expect(envReason({ hostEnv: [], movedPlaces: ["HOME"] } as never, undefined)).toContain('its env sets HOME');
    const fromFile = envReason(none as never, { path: "/p/.env", effects: { hostEnv: [], movedPlaces: ["HOME", "TMPDIR"] } as never });
    expect(fromFile).toContain("its envFile sets HOME and TMPDIR");
  });

  it("has nothing to say when nothing is wrong", () => {
    expect(envReason(none as never, undefined)).toBeUndefined();
  });
});

describe("hostPath", () => {
  it("is undefined for an argument that is not a string", () => {
    expect(hostPath(42)).toBeUndefined();
    expect(hostPath(undefined)).toBeUndefined();
  });

  it("is undefined for a path that does not exist", () => {
    expect(hostPath("/definitely/not/here/mcpcage")).toBeUndefined();
  });

  it("gives back an absolute path that exists", () => {
    expect(hostPath("/")).toBe("/");
  });
});

describe("createBackup", () => {
  it("passes on an error that is not EEXIST", () => {
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() => createBackup("/x/f.json", () => { throw failure; })).toThrow("denied");
  });

  it("moves on to another name when one exists", () => {
    const tried: string[] = [];
    const backup = createBackup("/x/f.json", (name) => {
      tried.push(name);
      if (tried.length < 3) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    expect(tried).toHaveLength(3);
    expect(backup).toBe(tried[2]);
    expect(tried[0]).toBe("/x/f.json.mcpcage.bak");
  });
});
