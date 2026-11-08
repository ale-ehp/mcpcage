// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/canonical.js";
import { installScripts } from "../src/npm-scripts.js";

// How installScripts treats answers from npm that are not what it expects, with npm replaced by a stub.

const dir = () => mkdtempSync(join(tmpdir(), "mcpcage-npm-answers-"));
const answering = (stdout: string, status = 0, stderr = "") => () => ({ status, stdout, stderr });

describe("installScripts with odd answers from npm", () => {
  it("does not claim 'none' when npm prints something that is not JSON", () => {
    const result = installScripts("left-pad@1.3.0", { offline: false, cacheDir: dir(), runner: answering("<html>proxy error</html>") });
    expect(result).toEqual({ status: "unknown", scripts: [], detail: "npm view printed something that is not JSON" });
  });

  it("looks the answer up again when the cache file is damaged", () => {
    const cacheDir = dir();
    mkdirSync(join(cacheDir, "npm-view"), { recursive: true });
    writeFileSync(join(cacheDir, "npm-view", `${sha256("left-pad@1.3.0")}.json`), "{not json");
    const result = installScripts("left-pad@1.3.0", { offline: false, cacheDir, runner: answering('{"postinstall":"node x.js"}') });
    expect(result.status).toBe("found");
    expect(result.scripts).toEqual(["postinstall"]);
  });
});
