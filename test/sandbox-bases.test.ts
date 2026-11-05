import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "./helpers.js";

/*
 * The base images of the cage are read from runtime/bases.Dockerfile when sandbox.ts loads, and must
 * be pinned by digest. Loaded here with that file replaced, to see what a broken one makes it do.
 */

const digest = (letter: string) => `@sha256:${letter.repeat(64)}`;

/** Every stage sandbox.ts reads, each pinned, with `stage` written as `line` instead (left out when empty). */
function bases(stage?: string, line?: string): string {
  const stages: Array<[string, string]> = [
    ["install", `FROM node:22${digest("a")} AS install`],
    ["runtime", `from gcr.io/distroless/nodejs22${digest("b")}   as   runtime  `],
    ["pypi-resolve", `FROM ghcr.io/astral-sh/uv:0.13.7-python3.13-trixie-slim${digest("c")} AS pypi-resolve`],
    ["pypi-uv", `FROM ghcr.io/astral-sh/uv:0.13.7${digest("d")} AS pypi-uv`],
    ["pypi-install", `FROM gcr.io/distroless/cc-debian13:latest${digest("e")} AS pypi-install`],
    ["pypi-runtime", `FROM gcr.io/distroless/cc-debian13:nonroot${digest("f")} AS pypi-runtime`],
  ];
  return `# bases\n${stages.map(([name, text]) => (name === stage ? (line ?? "") : text)).join("\n")}\n`;
}

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
  it("are the stages of runtime/bases.Dockerfile, each pinned by digest", async () => {
    const sandbox = await loadWith(bases());
    expect([sandbox.INSTALL_BASE, sandbox.RUNTIME_BASE]).toEqual([`node:22${digest("a")}`, `gcr.io/distroless/nodejs22${digest("b")}`]);
    expect([sandbox.PYPI_RESOLVE_BASE, sandbox.UV_BASE, sandbox.PYPI_INSTALL_BASE, sandbox.PYPI_RUNTIME_BASE]).toEqual([
      `ghcr.io/astral-sh/uv:0.13.7-python3.13-trixie-slim${digest("c")}`,
      `ghcr.io/astral-sh/uv:0.13.7${digest("d")}`,
      `gcr.io/distroless/cc-debian13:latest${digest("e")}`,
      `gcr.io/distroless/cc-debian13:nonroot${digest("f")}`,
    ]);
  });

  it("refuse to load without either stage, or with a stage not pinned by digest", async () => {
    await expect(loadWith(`FROM node:22${digest("a")} AS install\n`)).rejects.toThrow('runtime/bases.Dockerfile has no "AS runtime" stage');
    await expect(loadWith(bases("install", "FROM node:22 AS install"))).rejects.toThrow("runtime/bases.Dockerfile: node:22 is not pinned by digest");
    await expect(loadWith(bases("install", `FROM node:22${digest("a")}x AS install`))).rejects.toThrow(`runtime/bases.Dockerfile: node:22${digest("a")}x is not pinned by digest`);
  });

  // The images that resolve and build PyPI servers are held to the same rule: a tag alone can be
  // moved to other bytes, and the build would follow it.
  it.each(["pypi-resolve", "pypi-uv", "pypi-install", "pypi-runtime"])("refuse to load without the %s stage, or with it not pinned by digest", async (stage) => {
    await expect(loadWith(bases(stage))).rejects.toThrow(`runtime/bases.Dockerfile has no "AS ${stage}" stage`);
    await expect(loadWith(bases(stage, `FROM ghcr.io/astral-sh/uv:0.13.7 AS ${stage}`))).rejects.toThrow("runtime/bases.Dockerfile: ghcr.io/astral-sh/uv:0.13.7 is not pinned by digest");
  });

  // The lock is written by the uv of the resolve image and installed by the uv binary copied into the
  // install stage: one release for both, so they read the same lock the same way. The install stage
  // is the runtime's own base, as root, so the interpreter and the wheels are put together against
  // the C library they run on.
  it("resolve and install PyPI servers with one uv release, on the runtime's own distroless base", () => {
    const text = readFileSync(join(root, "runtime", "bases.Dockerfile"), "utf8");
    const image = (stage: string) => new RegExp(`^FROM\\s+(\\S+)\\s+AS\\s+${stage}\\s*$`, "im").exec(text)?.[1] ?? "";
    const resolve = /^ghcr\.io\/astral-sh\/uv:(\d+\.\d+\.\d+)-python3\.13-trixie-slim@sha256:[0-9a-f]{64}$/.exec(image("pypi-resolve"));
    const uv = /^ghcr\.io\/astral-sh\/uv:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/.exec(image("pypi-uv"));
    expect(resolve?.[1]).toBeDefined();
    expect(uv?.[1]).toBe(resolve?.[1]);
    expect(image("pypi-install")).toMatch(/^gcr\.io\/distroless\/cc-debian13:latest@sha256:[0-9a-f]{64}$/);
    expect(image("pypi-runtime")).toMatch(/^gcr\.io\/distroless\/cc-debian13:nonroot@sha256:[0-9a-f]{64}$/);
  });
});
