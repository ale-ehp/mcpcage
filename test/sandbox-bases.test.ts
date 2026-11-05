import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The base images of the cage are read from runtime/bases.Dockerfile when sandbox.ts loads, and must
 * be pinned by digest. Loaded here with that file replaced, to see what a broken one makes it do.
 */

const digest = (letter: string) => `@sha256:${letter.repeat(64)}`;

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

async function loadWith(dockerfile: string) {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const fs = await importOriginal<typeof import("node:fs")>();
    const readFileSync = ((file: unknown, ...rest: unknown[]) =>
      String(file).endsWith("bases.Dockerfile") ? dockerfile : (fs.readFileSync as (...args: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync;
    return { ...fs, readFileSync };
  });
  return import("../src/sandbox.js");
}

describe("the base images of the cage", () => {
  it("are the two stages of runtime/bases.Dockerfile, each pinned by digest", async () => {
    const sandbox = await loadWith(`# bases\nFROM node:22${digest("a")} AS install\nfrom gcr.io/distroless/nodejs22${digest("b")}   as   runtime  \n`);
    expect([sandbox.INSTALL_BASE, sandbox.RUNTIME_BASE]).toEqual([`node:22${digest("a")}`, `gcr.io/distroless/nodejs22${digest("b")}`]);
  });

  it("refuse to load without either stage, or with a stage not pinned by digest", async () => {
    await expect(loadWith(`FROM node:22${digest("a")} AS install\n`)).rejects.toThrow('runtime/bases.Dockerfile has no "AS runtime" stage');
    await expect(loadWith(`FROM node:22 AS install\nFROM distroless${digest("b")} AS runtime\n`)).rejects.toThrow("runtime/bases.Dockerfile: node:22 is not pinned by digest");
    await expect(loadWith(`FROM node:22${digest("a")}x AS install\nFROM distroless${digest("b")} AS runtime\n`)).rejects.toThrow(`runtime/bases.Dockerfile: node:22${digest("a")}x is not pinned by digest`);
  });
});
