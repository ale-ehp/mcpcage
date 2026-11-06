import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseLaunch, pypiRequirement, type PypiLaunch } from "../src/launch.js";
import { checkLock, comparePypiVersions, resolvePypi, type DockerRunner } from "../src/pypi.js";
import { UNPRINTABLE } from "../src/terminal.js";
import { anyText, check, TIMEOUT } from "./fuzz.js";

/*
 * What mcpcage keeps of uv's answers when it resolves a PyPI server: uv reads metadata that anyone
 * can publish on PyPI, and the lock decides what the build installs. A lock is kept only when every
 * line is a pin with its hashes, a comment or blank; a refusal is one plain line that quotes nothing
 * of the lock.
 */

const hash = fc.stringMatching(/^[0-9a-f]{64}$/);
const ROOT = { name: "mcp-server-time", version: "2026.11.4" };

/** Lines of a lock: well formed ones, near misses, and anything. */
const lockLine = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("mcp-server-time==2026.11.4 \\", "anyio==4.16.0 \\", "Tz_Data.x==1!2.0rc1.post3.dev4 \\", "anyio==4.16.0", "mcp-server-time==0.1 \\") },
  { weight: 4, arbitrary: hash.map((hex) => `    --hash=sha256:${hex} \\`) },
  { weight: 4, arbitrary: hash.map((hex) => `    --hash=sha256:${hex}`) },
  { weight: 2, arbitrary: fc.constantFrom("", "# comment", "    # via mcp", "  ") },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "--index-url https://u:p@example.com/simple", "-e ./x", "./x.whl \\", "x @ https://example.com/x.whl \\", "x>=1 \\", "x==1.* \\", "x[extra]==1 \\",
      "x==1 ; python_version > '3' \\", "    --hash=md5:00", "  --hash=sha256:00 \\", "-r other.txt", "--find-links /tmp", "x==1\\", "x == 1 \\", "x==1 \\\r",
    ),
  },
  { weight: 1, arbitrary: anyText(30) },
);

function pypi(...argv: string[]): PypiLaunch {
  const spec = parseLaunch(argv, undefined, "linux");
  if (spec.kind !== "pypi") throw new Error("not a pypi spec");
  return spec;
}

describe("the lock uv writes, fuzzed", () => {
  it(
    "is kept only when it holds pins with their hashes, comments and blank lines, and pins the server",
    () => {
      check(
        fc.property(fc.array(lockLine, { maxLength: 12 }), (lines) => {
          const lock = lines.join("\n");
          let kept = true;
          try {
            checkLock(lock, ROOT);
          } catch (error) {
            kept = false;
            const message = (error as Error).message;
            expect(message).toMatch(/^the lock uv wrote for mcp-server-time /);
            // Nothing of the lock, only where the problem is.
            expect(message).not.toMatch(UNPRINTABLE);
            expect(message.replace(/mcp-server-time|2026\.11\.4/g, "")).not.toMatch(/https?:|--hash|sha256|\.whl|index/);
          }
          if (!kept) return;
          let open = false;
          let root = false;
          for (const line of lock.split("\n")) {
            if (open) {
              expect(line).toMatch(/^ {4}--hash=sha256:[0-9a-f]{64}( \\)?$/);
              open = line.endsWith("\\");
              continue;
            }
            if (line.trim() === "" || line.trim().startsWith("#")) continue;
            const pin = /^(\S+)==(\S+) \\$/.exec(line);
            expect(pin, line).not.toBeNull();
            expect(pypiRequirement(`${pin![1]}==${pin![2]}`)?.specifiers).toHaveLength(1);
            expect(pin![2]).not.toContain("*");
            if (pin![1]!.toLowerCase().replace(/[-_.]+/g, "-") === ROOT.name) root = pin![2] === ROOT.version;
            open = true;
          }
          expect(open).toBe(false);
          expect(root).toBe(true);
        }),
        500,
      );
    },
    TIMEOUT,
  );
});

describe("uv's reasons, fuzzed", () => {
  it(
    "become one plain line when uv finds no solution, whatever uv printed",
    () => {
      check(
        fc.property(fc.array(anyText(40), { maxLength: 6 }), (reason) => {
          const runner: DockerRunner = (args) => {
            if (args[0] === "version") return { status: 0, stdout: "arm64\n", stderr: "" };
            // Docker has the resolve image (see pullResolveImage).
            if (args[0] === "image") return { status: 0, stdout: "sha256:resolve\n", stderr: "" };
            return { status: 1, stdout: "", stderr: `error: No solution found when resolving dependencies\n${reason.join("\n")}` };
          };
          expect(() => resolvePypi(pypi("uvx", "--python", "3.12", "mcp-server-time"), { log: () => {}, runner })).toThrow(
            /^mcp-server-time cannot be installed from PyPI wheels on Python 3\.12 for Linux on ARM \(linux\/arm64\), and the cage never builds a package from source: /,
          );
          try {
            resolvePypi(pypi("uvx", "--python", "3.12", "mcp-server-time"), { log: () => {}, runner });
          } catch (error) {
            const message = (error as Error).message;
            expect(message).not.toMatch(UNPRINTABLE);
            expect(message.length).toBeLessThan(2000 * 12 + 200);
          }
        }),
        300,
      );
    },
    TIMEOUT,
  );
});

/** Versions as PEP 440 writes them, separators and spellings included. */
const version = fc
  .tuple(
    fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
    fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 4 }),
    fc.option(fc.tuple(fc.constantFrom("a", "alpha", "b", "beta", "rc", "c", "pre", "preview"), fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined })), { nil: undefined }),
    fc.option(fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }), { nil: undefined }),
    fc.option(fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }), { nil: undefined }),
    fc.constantFrom("", ".", "-", "_"),
  )
  .map(([epoch, release, pre, post, dev, separator]) =>
    [
      epoch === undefined ? "" : `${epoch}!`,
      release.join("."),
      pre === undefined ? "" : `${separator}${pre[0]}${pre[1] ?? ""}`,
      post === undefined ? "" : `${separator === "" ? "." : separator}post${post ?? ""}`,
      dev === undefined ? "" : `${separator === "" ? "." : separator}dev${dev ?? ""}`,
    ].join(""),
  );

describe("comparePypiVersions, fuzzed", () => {
  it(
    "is an order: the same for a version and itself, reversed when the two are swapped, transitive",
    () => {
      check(
        fc.property(version, version, version, (a, b, c) => {
          expect(comparePypiVersions(a, a)).toBe(0);
          expect(Math.sign(comparePypiVersions(a, b))).toBe(-Math.sign(comparePypiVersions(b, a)) || 0);
          if (comparePypiVersions(a, b) <= 0 && comparePypiVersions(b, c) <= 0) expect(comparePypiVersions(a, c)).toBeLessThanOrEqual(0);
        }),
        1000,
      );
    },
    TIMEOUT,
  );
});
