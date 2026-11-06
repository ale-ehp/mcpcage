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

/** A package name as uv prints it in a lock, in any of the spellings PEP 503 makes the same. */
const packageName = fc
  .array(fc.constantFrom(..."abcxyz019"), { minLength: 1, maxLength: 6 })
  .chain((letters) => fc.array(fc.constantFrom("", "-", "_", "."), { minLength: letters.length - 1, maxLength: letters.length - 1 }).map((separators) => letters.map((letter, index) => `${index === 0 ? "" : separators[index - 1]}${letter}`).join("")));
const normal = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** A lock as uv writes it: each package pinned with ==, its hashes on the lines after it, comments and blank lines between pins. */
const validLock = fc
  .tuple(
    fc.uniqueArray(fc.tuple(packageName, version, fc.array(hash, { minLength: 1, maxLength: 3 })), { selector: ([name]) => normal(name), maxLength: 5 }).map((pins) => pins.filter(([name]) => normal(name) !== ROOT.name)),
    fc.constantFrom("mcp-server-time", "MCP_Server.Time", "mcp_server_time"),
    fc.array(hash, { minLength: 1, maxLength: 3 }),
    fc.nat(),
    fc.array(fc.constantFrom("", "# via mcp", "    # via anyio", "#"), { maxLength: 3 }),
  )
  .map(([others, rootName, rootHashes, at, loose]) => {
    const pins: Array<[string, string, string[]]> = [...others];
    pins.splice(at % (pins.length + 1), 0, [rootName, ROOT.version, rootHashes]);
    const blocks = pins.map(([name, pinned, hashes]) => [`${name}==${pinned} \\`, ...hashes.map((hex, index) => `    --hash=sha256:${hex}${index < hashes.length - 1 ? " \\" : ""}`)]);
    loose.forEach((line, index) => blocks.splice((index * 7) % (blocks.length + 1), 0, [line]));
    return { lock: `${blocks.flat().join("\n")}\n`, pins: new Map(pins.map(([name, pinned, hashes]) => [normal(name), { version: pinned, hashes }])) };
  });

type Pins = Map<string, { version: string; hashes: string[] }>;

/**
 * The pins of a lock as `uv pip sync` reads a requirements file: a line that ends with a backslash
 * joined with the next, but a comment line, which uv 0.13.7 ends there as pip does (`# via mc\`
 * before `idna==3.10 \` and its hash left idna required, in its pinned image); a comment from a #
 * at the start or after a space; then each requirement with its options. `name===version`, which
 * checkLock keeps too, is the same pin for uv 0.13.7 (`idna===3.10` and its hash: "you require
 * idna==3.10"). Undefined when a line is anything but a pinned name with sha256 hashes, or a package
 * comes twice.
 */
function pinsOf(lock: string): Pins | undefined {
  const pins: Pins = new Map();
  const lines: string[] = [];
  let joined = "";
  for (const line of lock.split("\n")) {
    if (line.endsWith("\\") && !/^\s*#/.test(line)) {
      joined += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push(`${joined}${line}`);
    joined = "";
  }
  if (joined !== "") lines.push(joined);
  for (const logical of lines) {
    const words = logical.replace(/(^|\s)#.*$/, "").trim().split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) continue;
    const [requirement, ...options] = words;
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]|[A-Za-z0-9])===?([A-Za-z0-9][A-Za-z0-9.!+_-]*)$/.exec(requirement!);
    if (pin === null || options.length === 0 || options.some((option) => !/^--hash=sha256:[0-9a-f]{64}$/.test(option))) return undefined;
    const name = normal(pin[1]!);
    if (pins.has(name)) return undefined;
    pins.set(name, { version: pin[2]!, hashes: options.map((option) => option.slice("--hash=sha256:".length)) });
  }
  return pins;
}

/** Lines that change where the build takes its code from, or what it trusts, wherever one is put in a lock. */
const MEANING = [
  "--index-url https://pypi.corp.example/simple", "-i https://pypi.corp.example/simple", "--extra-index-url https://pypi.corp.example/simple",
  "--find-links /tmp/wheels", "-f ./wheels", "--no-index", "--trusted-host pypi.corp.example", "-e ./server", "-r other.txt", "-c constraints.txt",
  "--no-binary :all:", "--pre", "x @ https://example.com/x-1.0-py3-none-any.whl \\", "https://example.com/x-1.0-py3-none-any.whl \\", "./x-1.0-py3-none-any.whl \\",
  "git+https://example.com/x \\", "file:///tmp/x \\", "extra==1.0", "extra==1.0 \\", "mcp-server-time==9.9 \\", "anyio>=4 \\", "anyio==4.* \\", "anyio[trio]==4.0 \\",
  "anyio==4.0 ; python_version > '3' \\", "anyio==4.0\t\\", "anyio==4.0 \\\r", "anyio==4.0 \u0007\\",
];

/** One change of a lock: a line inserted, a line removed, or one character replaced, inserted or removed. */
const mutation = fc.oneof(
  fc.record({ kind: fc.constant("insert" as const), line: fc.constantFrom(...MEANING), at: fc.nat() }),
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("character" as const),
    at: fc.nat(),
    remove: fc.nat({ max: 1 }),
    put: fc.constantFrom("", " ", "\t", "\\", "=", "#", "-", "_", ".", "@", ";", "/", ":", "*", "+", "!", "[", "<", "~", "\n", "\r", "\u0000", "\u0007", "\u001b", "\u007f", "a", "Z", "0", "9", "f", "é", "​"),
  }),
);

describe("the lock uv writes, changed by one line or character", () => {
  it(
    "keeps a lock uv writes, with the pins it holds",
    () => {
      check(
        fc.property(validLock, ({ lock, pins }) => {
          expect(() => checkLock(lock, ROOT), lock).not.toThrow();
          expect(pinsOf(lock)).toEqual(pins);
        }),
        500,
      );
    },
    TIMEOUT,
  );

  it(
    "refuses a line that changes where the code comes from, or keeps only what holds the same pins: every package with its hashes, the server at its version",
    () => {
      check(
        fc.property(validLock, mutation, ({ lock, pins }, change) => {
          const lines = lock.split("\n");
          let changed: string;
          if (change.kind === "insert") {
            lines.splice(change.at % (lines.length + 1), 0, change.line);
            changed = lines.join("\n");
          } else if (change.kind === "delete") {
            lines.splice(change.at % lines.length, 1);
            changed = lines.join("\n");
          } else {
            const at = change.at % (lock.length + 1);
            changed = `${lock.slice(0, at)}${change.put}${lock.slice(at + change.remove)}`;
          }
          let kept = true;
          try {
            checkLock(changed, ROOT);
          } catch {
            kept = false;
          }
          // A line of MEANING, a control character other than a line break: never kept.
          if (change.kind === "insert" || (change.kind === "character" && /[\u0000-\u0009\u000b-\u001f\u007f]/.test(change.put))) expect(kept, JSON.stringify(changed)).toBe(false);
          if (!kept) return;
          const read = pinsOf(changed);
          expect(read, JSON.stringify(changed)).toBeDefined();
          expect(read!.get(ROOT.name)?.version, JSON.stringify(changed)).toBe(ROOT.version);
          // The same packages at the same versions, but for the one name or version the change made another.
          const pinned = (all: Pins) => new Set([...all].map(([name, { version: pinnedVersion }]) => `${name}==${pinnedVersion}`));
          const before = pinned(pins);
          const after = pinned(read!);
          const gone = [...before].filter((pin) => !after.has(pin));
          const come = [...after].filter((pin) => !before.has(pin));
          expect(gone.length <= 1 && come.length <= 1 && gone.length === come.length, `${JSON.stringify(changed)}: ${gone} -> ${come}`).toBe(true);
          if (change.kind === "delete") expect(come).toEqual([]);
          for (const [name, { hashes }] of read!) {
            if (!pins.has(name)) continue;
            // A line removed takes a hash, never the last one; a character changed may make one another.
            if (change.kind === "delete") for (const hex of hashes) expect(pins.get(name)!.hashes).toContain(hex);
            expect(hashes.length).toBeGreaterThan(0);
          }
        }),
        2000,
      );
    },
    TIMEOUT,
  );
});
