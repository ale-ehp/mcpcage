// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import { describe, expect, it, vi } from "vitest";
import { listTools } from "../src/inspect.js";
import { fakeServer } from "./helpers.js";

// A mistake while reading a server's answer, standing for any exception a server could set off in
// the line handler: here the check of the listing throws, as appending 200,000 tools once did.
vi.mock("../src/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/manifest.js")>()),
  isToolList: () => {
    throw new RangeError("Maximum call stack size exceeded");
  },
}));

describe("a mistake while reading a server", () => {
  it("fails that inspection instead of ending the process", async () => {
    await expect(listTools(process.execPath, [fakeServer], { ...process.env, FAKE_VARIANT: "v1" }, 15_000)).rejects.toThrow(
      "reading the server's answer failed: Maximum call stack size exceeded",
    );
  });
});
