import fc from "fast-check";

/*
 * Shared settings of the property-based tests (test/*.fuzz.test.ts). `npm test` runs each property a
 * few hundred times from a fixed seed, so a run takes seconds and fails the same way twice. A failure
 * prints the seed and the path of the smallest case fast-check found; MCPCAGE_FUZZ_SEED=<seed> runs
 * the same cases again. MCPCAGE_FUZZ_RUNS=<n> runs each property n times instead (the weekly fuzz
 * workflow), from the seed given or, without one, from a new seed each time, which the failure prints.
 */

const LONG = process.env.MCPCAGE_FUZZ_RUNS;
const runs = LONG === undefined ? undefined : Number(LONG);
if (runs !== undefined && !(Number.isInteger(runs) && runs > 0)) throw new Error(`MCPCAGE_FUZZ_RUNS must be a positive integer, not ${LONG}`);
const given = process.env.MCPCAGE_FUZZ_SEED;
if (given !== undefined && !/^-?\d+$/.test(given)) throw new Error(`MCPCAGE_FUZZ_SEED must be an integer, not ${given}`);

/** The seed of every property in this run: given, fixed for `npm test`, or a new one for a long run. */
export const SEED = given !== undefined ? Number(given) : runs === undefined ? 20261104 : (Date.now() ^ (Math.random() * 0x7fffffff)) | 0;

/** Whether this is a long run (MCPCAGE_FUZZ_RUNS). */
export const LONG_RUN = runs !== undefined;

/**
 * The parameters of one property: `normal` runs in `npm test`; in a long run MCPCAGE_FUZZ_RUNS divided
 * by `cost`, for a property whose single run starts processes or writes files.
 */
export function settings<T>(normal: number, cost = 1): fc.Parameters<T> {
  return { seed: SEED, numRuns: runs === undefined ? normal : Math.max(normal, Math.ceil(runs / cost)) };
}

/** How long one property may take: vitest's limit for `npm test`, none to speak of in a long run. */
export const TIMEOUT = LONG_RUN ? 6 * 60 * 60 * 1000 : 30_000;

/** Runs `property` with `settings`; fast-check's failure message gives the seed and the smallest case. */
export function check<T>(property: fc.IProperty<T>, normal: number, cost = 1): void {
  fc.assert(property, settings<T>(normal, cost));
}

export async function checkAsync<T>(property: fc.IAsyncProperty<T>, normal: number, cost = 1): Promise<void> {
  await fc.assert(property, settings<T>(normal, cost));
}

/** Keys that every object inherits, or that JSON.parse makes an own property of when a server writes them. */
export const PROTOTYPE_NAMES = ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__defineGetter__", "toLocaleString"];

/**
 * Strings of any UTF-16 code units, lone surrogates included, weighted towards the characters that
 * break text handling: controls, line and paragraph separators, invisible and bidi characters,
 * combining marks, astral characters and the characters of JSON and paths.
 */
export const anyText = (maxLength = 40) =>
  fc.string({
    maxLength,
    unit: fc.oneof(
      { weight: 4, arbitrary: fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }) },
      { weight: 2, arbitrary: fc.constantFrom("\n", "\r", "\t", "\u0000", "\u001b", "\u009b", "\u2028", "\u2029", "\u200b", "\u200d", "\u202e", "\ufeff", "\u0301", "\ud800", "\udc00", "\u{e0041}", "\u{1f600}", "\\", "/", '"', "{", "}", "[", "]", ",", ":", "%", "~", ".", " ") },
      { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }) },
    ),
  });

/**
 * Any JSON value, as JSON.parse can make it: objects whose keys include the prototype's names (an own
 * "__proto__" too, which only JSON.parse and Object.fromEntries make), numeric keys, empty and
 * unicode keys, and strings of anyText.
 */
export const jsonValue = (maxDepth = 4): fc.Arbitrary<unknown> =>
  fc.letrec<{ value: unknown }>((tie) => ({
    value: fc.oneof(
      { depthSize: "small", maxDepth },
      fc.constant(null),
      fc.boolean(),
      fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.constantFrom(0, -0, 1e21, 2 ** 53, 5e-324)),
      anyText(),
      fc.array(tie("value"), { maxLength: 5 }),
      fc
        .array(fc.tuple(fc.oneof(anyText(8), fc.constantFrom(...PROTOTYPE_NAMES, "", "0", "1", "10", "01", "-1", "1.5", "4294967294", "4294967295", "_meta", "name")), tie("value")), { maxLength: 5 })
        .map((entries) => Object.fromEntries(entries)),
    ),
  })).value;
