import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { namesIndex, settingThatStops } from "../src/uv-settings.js";
import { check, TIMEOUT } from "./fuzz.js";

/*
 * The scan of a uv.toml (see scanFor in uv-settings.ts) reads lines, not TOML. Whatever surrounds a
 * key that uv reads and the cage refuses, quoted or escaped, dotted, as a table, after multi-line
 * strings, inline tables and comments, the scan must find it: a key it misses leaves a server caged
 * that uvx would install from elsewhere. The other way round is allowed: a string or a comment that
 * holds such a word may be taken for the key, which only leaves a server uncaged, with the reason.
 *
 * The documents are uv settings uv 0.13.7 reads: keys of its own with values of their types, so that a
 * sample could be given to uv itself (`uv tool run --show-settings --offline` in its pinned image, with
 * UV_CONFIG_FILE), which shows whether it reads a refused setting. Of 1,000 documents sampled so, half
 * with a refused key, uv parsed 971: the 29 others set default-index, which the scan counts and uv
 * 0.13.7 does not take in a uv.toml (it refuses the whole file). On those 971 the scan and uv agreed
 * 970 times; the other was a decoy in a multi-line string, taken for a key. uv read a refused setting
 * the scan missed in none, and in 31 before exclude-newer-package.idna and prerelease-package were found.
 */

/** The keys that name a package index, and those that change what uvx installs (INDEX_KEYS and INSTALL_KEYS in uv-settings.ts). */
const INDEX_KEYS = ["index", "index-url", "extra-index-url", "default-index", "find-links", "no-index", "index-strategy", "keyring-provider", "torch-backend"];
const INSTALL_KEYS = ["resolution", "prerelease", "prerelease-package", "exclude-newer", "exclude-newer-package", "dependency-metadata", "no-binary", "no-binary-package"];

/** A value of its type for each refused key, as uv 0.13.7 takes it. */
const REFUSED_VALUES: Readonly<Record<string, readonly string[]>> = {
  index: ['[{ name = "corp", url = "https://pypi.corp.example/simple" }]', '[\n  { name = "corp", url = "https://pypi.corp.example/simple" },\n]'],
  "index-url": ['"https://pypi.corp.example/simple"', "'https://pypi.corp.example/simple'"],
  "extra-index-url": ['["https://pypi.corp.example/simple"]', "[\n  'https://pypi.corp.example/simple', # a comment\n]"],
  "default-index": ['"https://pypi.corp.example/simple"'],
  "find-links": ['["/opt/wheels"]', '[\n  """/opt/wheels""",\n]'],
  "no-index": ["true", "false"],
  "index-strategy": ['"unsafe-best-match"'],
  "keyring-provider": ['"subprocess"'],
  "torch-backend": ['"cpu"'],
  resolution: ['"lowest"', '"highest"'],
  prerelease: ['"allow"'],
  "prerelease-package": ['{ httpx = "allow" }'],
  "exclude-newer": ['"2020-01-01T00:00:00Z"', "'2020-01-01'"],
  "exclude-newer-package": ['{ idna = "2020-01-01T00:00:00Z" }'],
  "dependency-metadata": ['[{ name = "idna", version = "3.10", requires-dist = ["six"] }]'],
  "no-binary": ["true"],
  "no-binary-package": ['["idna"]', '[\n  "idna",\n]'],
};

/** The refused keys uv also reads as a table of their own, with a body of their type. */
const REFUSED_TABLES: Readonly<Record<string, { array: boolean; body: readonly string[] }>> = {
  index: { array: true, body: ['url = "https://pypi.corp.example/simple"', 'name = "corp"'] },
  "dependency-metadata": { array: true, body: ['name = "idna"', 'version = "3.10"', 'requires-dist = ["six"]'] },
  "exclude-newer-package": { array: false, body: ['idna = "2020-01-01T00:00:00Z"'] },
};

/** The refused keys whose value is a table of packages, which uv also reads as dotted keys: `exclude-newer-package.idna = ...`. */
const DOTTED: Readonly<Record<string, { packages: readonly string[]; value: string }>> = {
  "exclude-newer-package": { packages: ["idna", '"idna"', "'six'"], value: '"2020-01-01T00:00:00Z"' },
  "prerelease-package": { packages: ["httpx", "'httpx'"], value: '"allow"' },
};

/** The words of the refused keys, and the characters of TOML, which a string or a comment may hold when it is a decoy. */
const DECOY_WORDS = [...INDEX_KEYS, ...INSTALL_KEYS, "[[index]]", "[exclude-newer-package]", "index-url = ", "=", "{", "}", ".", ",", "[", "]"];

/** Words no refused key can be made of, and characters that matter to a line scan. */
const PLAIN_WORDS = ["uv", "cache", "tmp", "C:", "/opt/x", "a b", "x=y", "#", "[", "]", "{", "}", ",", ".", "=", " ", "\t", "é", "\u{1f600}", "　"];

type Mode = "plain" | "decoy";

/** Text of `words`, for strings and comments: in decoy mode also the words of refused keys. */
const words = (mode: Mode, extra: readonly string[] = []) =>
  fc.array(fc.constantFrom(...PLAIN_WORDS, ...extra, ...(mode === "decoy" ? DECOY_WORDS : [])), { maxLength: 8 }).map((parts) => parts.join(""));

/**
 * A TOML string of any of its four kinds, its content written as TOML allows it there: escapes and
 * quotes of the other kind in a basic string, backslashes in a literal one, newlines, quotes and
 * line-ending backslashes in the multi-line ones. A safe character ends each, so that no quote
 * before the closing ones is read as part of them.
 */
const tomlString = (mode: Mode): fc.Arbitrary<string> =>
  fc.oneof(
    words(mode, ['\\"', "\\\\", "\\t", "\\n", "\\u00e9", "\\U0001F600", "'", "#"]).map((text) => `"${text}x"`),
    words(mode, ["\\", '"', "\\n", '\\"', "#"]).map((text) => `'${text}x'`),
    words(mode, ['"', '""', "\n", "\\\n", '\\"', "'", "#", "\\\\"])
      .filter((text) => !text.replace(/\\./gs, "").includes('"""'))
      .map((text) => `"""${text}x"""`),
    words(mode, ["'", "''", "\n", "\\", '"', '"""', "#"])
      .filter((text) => !text.includes("'''"))
      .map((text) => `'''${text}x'''`),
  );

/** A comment: anything but a line break and the other controls TOML refuses there. */
const comment = (mode: Mode) => words(mode, ['"', "'", '"""', "\\", "#"]).map((text) => `#${text}`);

/** Space and tab, the whitespace of TOML. */
const space = fc.constantFrom("", " ", "\t", "  ");

const bool = fc.constantFrom("true", "false");
const packages = fc.subarray(['"idna"', '"six"', "'anyio'", '"httpx"']);
const packageArray = fc.tuple(packages, fc.boolean()).map(([names, multiline]) => (multiline ? `[\n  ${names.map((name) => `${name},`).join("\n  ")}\n]` : `[${names.join(", ")}]`));

/** Keys of uv's own that choose nothing the cage refuses, with values of their types. */
const fillerRoot = (mode: Mode): Array<[string, fc.Arbitrary<string>]> => [
  ["cache-dir", tomlString(mode)],
  ["no-cache", bool],
  ["offline", bool],
  ["preview", bool],
  ["compile-bytecode", bool],
  ["no-build", bool],
  ["upgrade", bool],
  ["concurrent-downloads", fc.integer({ min: 1, max: 64 }).map(String)],
  ["link-mode", fc.constantFrom('"copy"', "'clone'", '"hardlink"', '"symlink"')],
  ["python-preference", fc.constantFrom('"managed"', '"system"', '"only-managed"')],
  ["python-downloads", fc.constantFrom('"automatic"', '"manual"', '"never"')],
  ["upgrade-package", packageArray],
  ["no-build-package", packageArray],
  ["reinstall-package", packageArray],
];

/** A line of a document: a key and its value (one or more lines), a comment, or a blank line. */
const fillerLine = (mode: Mode, key: string, value: fc.Arbitrary<string>) =>
  fc
    .tuple(space, fc.constantFrom(key, `"${key}"`, `'${key}'`), space, space, value, fc.option(fc.tuple(space, comment(mode)), { nil: undefined }))
    .map(([indent, name, before, after, text, trailing]) => `${indent}${name}${before}=${after}${text}${trailing === undefined ? "" : ` ${trailing[1]}`}`);

const looseLine = (mode: Mode) => fc.oneof(comment(mode), fc.constantFrom("", "  ", "\t"));

/** The root of a document: distinct keys of uvFiller in any order, dotted config-settings keys, comments and blank lines. */
const rootLines = (mode: Mode) =>
  fc
    .tuple(
      fc.shuffledSubarray(fillerRoot(mode), { maxLength: 6 }).chain((chosen) => fc.tuple(...chosen.map(([key, value]) => fillerLine(mode, key, value)))),
      fc.uniqueArray(fc.constantFrom("a", "b-c", "d_e", "f1"), { maxLength: 2 }).chain((keys) =>
        fc.tuple(...keys.map((key) => fc.tuple(space, tomlString(mode)).map(([gap, value]) => `config-settings${gap}.${gap}${key} = ${value}`))),
      ),
      fc.array(looseLine(mode), { maxLength: 3 }),
    )
    .chain(([keys, dotted, loose]) => fc.shuffledSubarray([...keys, ...dotted, ...loose], { minLength: keys.length + dotted.length + loose.length }));

/** The tables after the root: [pip], [[cache-keys]] and [extra-build-dependencies], each with its keys, comments and blank lines. */
const tables = (mode: Mode): fc.Arbitrary<string[][]> =>
  fc
    .tuple(
      fc.option(
        fc
          .tuple(
            fc.constantFrom("[pip]", "[ pip ]", '["pip"]', "[ 'pip' ]\t"),
            fc.shuffledSubarray(
              [
                ["generate-hashes", bool],
                ["no-deps", bool],
                ["strict", bool],
                ["custom-compile-command", tomlString(mode)],
                ["python-version", fc.constantFrom('"3.12"', "'3.13'")],
              ] as Array<[string, fc.Arbitrary<string>]>,
              { maxLength: 4 },
            ).chain((chosen) => fc.tuple(...chosen.map(([key, value]) => fillerLine(mode, key, value)))),
            fc.array(looseLine(mode), { maxLength: 2 }),
          )
          .map(([header, keys, loose]) => [header, ...keys, ...loose]),
        { nil: undefined },
      ),
      fc.array(fc.tuple(fc.constantFrom("[[cache-keys]]", "[[ cache-keys ]]", '[["cache-keys"]]'), tomlString(mode), fc.option(comment(mode), { nil: undefined })).map(([header, file, note]) => [header, `file = ${file}`, ...(note === undefined ? [] : [note])]), { maxLength: 2 }),
      fc.option(fc.tuple(fc.constantFrom("[extra-build-dependencies]", '[ "extra-build-dependencies" ]'), packageArray).map(([header, deps]) => [header, `idna = ${deps}`]), { nil: undefined }),
    )
    .chain(([pip, cacheKeys, extra]) => fc.shuffledSubarray([...(pip === undefined ? [] : [pip]), ...cacheKeys, ...(extra === undefined ? [] : [extra])], { minLength: (pip === undefined ? 0 : 1) + cacheKeys.length + (extra === undefined ? 0 : 1) }));

/** How a key is written in a document: bare, as a literal string, or as a basic string with any of its characters escaped as TOML 1.1 allows. */
const spelling = (name: string): fc.Arbitrary<string> => {
  const escapes = (character: string) => {
    const code = character.codePointAt(0)!;
    const hex = (digits: number) => code.toString(16).padStart(digits, "0");
    return fc.constantFrom(character, character, `\\u${hex(4)}`, `\\u${hex(4).toUpperCase()}`, `\\U${hex(8)}`, `\\x${hex(2).toUpperCase()}`, `\\x${hex(2)}`);
  };
  return fc.oneof(fc.constant(name), fc.constant(`'${name}'`), fc.tuple(...[...name].map(escapes)).map((characters) => `"${characters.join("")}"`));
};

/** A refused key where uv reads it: a root key, a dotted root key, or a table of its own; with what it is and where it goes. */
type Insertion = { key: string; root: boolean; lines: string[] };

const insertion: fc.Arbitrary<Insertion> = fc.constantFrom(...INDEX_KEYS, ...INSTALL_KEYS).chain((key) => {
  const forms: Array<fc.Arbitrary<Insertion>> = [
    fc
      .tuple(space, spelling(key), space, space, fc.constantFrom(...REFUSED_VALUES[key]!), fc.option(comment("decoy"), { nil: undefined }))
      .map(([indent, name, before, after, value, note]) => ({ key, root: true, lines: [`${indent}${name}${before}=${after}${value}${note === undefined ? "" : ` ${note}`}`] })),
  ];
  const dotted = DOTTED[key];
  if (dotted !== undefined) {
    forms.push(
      fc.tuple(spelling(key), space, fc.constantFrom(...dotted.packages), space).map(([name, gap, inner, after]) => ({ key, root: true, lines: [`${name}${gap}.${gap}${inner}${after}=${after}${dotted.value}`] })),
    );
  }
  const table = REFUSED_TABLES[key];
  if (table !== undefined) {
    forms.push(
      fc.tuple(space, spelling(key), space, fc.option(comment("decoy"), { nil: undefined })).map(([gap, name, after, note]) => {
        const [open, close] = table.array ? ["[[", "]]"] : ["[", "]"];
        return { key, root: false, lines: [`${open}${gap}${name}${after}${close}${note === undefined ? "" : ` ${note}`}`, ...table.body] };
      }),
    );
  }
  return fc.oneof(...forms);
});

/** The document: root lines, then tables, the insertion where it goes (among the root lines, or among the tables), its line breaks LF or CRLF. */
function documentOf(root: string[], blocks: string[][], eol: string, inserted?: Insertion, at = 0): string {
  const lines = [...root];
  const after = blocks.map((block) => [...block]);
  if (inserted !== undefined) {
    if (inserted.root) lines.splice(at % (lines.length + 1), 0, ...inserted.lines);
    else after.splice(at % (after.length + 1), 0, inserted.lines);
  }
  return [...lines, ...after.flat()].join("\n").replace(/\n/g, eol);
}

/** The reason settingThatStops gives for `key` (see settingThatStops). */
function stopsFor(reason: string | undefined, key: string): boolean {
  return INDEX_KEYS.includes(key) ? reason === "name a package index, and the cage builds from PyPI only" : reason?.startsWith(`set ${key}: `) === true;
}

const mode = fc.constantFrom<Mode>("plain", "decoy");
const eol = fc.constantFrom("\n", "\r\n");

/** Documents of uv settings, with a refused key where uv reads it, or without one; for the property and for a cross-check with uv. */
const withRefused = mode.chain((chosen) =>
  fc.record({ mode: fc.constant(chosen), root: rootLines(chosen), tables: tables(chosen), eol, inserted: insertion, at: fc.nat() }).map((parts) => ({ ...parts, text: documentOf(parts.root, parts.tables, parts.eol, parts.inserted, parts.at) })),
);
const withoutRefused = mode.chain((chosen) => fc.record({ mode: fc.constant(chosen), root: rootLines(chosen), tables: tables(chosen), eol }).map((parts) => ({ ...parts, text: documentOf(parts.root, parts.tables, parts.eol) })));

describe("the scan of uv settings, fuzzed", () => {
  it(
    "finds a refused key wherever uv reads it, however the document around it is written",
    () => {
      check(
        fc.property(withRefused, ({ mode: chosen, text, inserted }) => {
          const reason = settingThatStops(text);
          expect(reason, text).toBeDefined();
          if (INDEX_KEYS.includes(inserted.key)) expect(namesIndex(text), text).toBe(true);
          // Without decoys the first key the scan finds is the one inserted, and the reason names it.
          if (chosen === "plain") expect(stopsFor(reason, inserted.key), `${reason}\n${text}`).toBe(true);
        }),
        500,
      );
    },
    TIMEOUT,
  );

  it(
    "reads a document without one to its end, and finds nothing in one whose strings and comments hold no such word",
    () => {
      check(
        fc.property(withoutRefused, ({ mode: chosen, text }) => {
          const reason = settingThatStops(text);
          const index = namesIndex(text);
          if (chosen === "plain") {
            expect(reason, text).toBeUndefined();
            expect(index, text).toBe(false);
          } else {
            // A decoy may be taken for a key: the safe side. Then the reason is one of the scan's.
            if (reason !== undefined) expect([...INDEX_KEYS, ...INSTALL_KEYS].some((key) => stopsFor(reason, key)), reason).toBe(true);
            if (index) expect(reason).toBeDefined();
          }
        }),
        500,
      );
    },
    TIMEOUT,
  );
});
