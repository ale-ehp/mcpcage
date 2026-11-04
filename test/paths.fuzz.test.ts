import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cagePath, hostMount, NOT_ON_A_DRIVE, offDrive, runArgs, within } from "../src/sandbox.js";
import { check, TIMEOUT } from "./fuzz.js";

/*
 * On Windows the cage is a Linux container, and every folder given to a server has one place there
 * (cagePath): the same for every way of writing that folder, another for another folder, and none
 * for a path off any drive. An argument inside a mounted folder becomes a path inside its place.
 */

/** A file name Windows allows, without the final dot or space it would drop. */
const NAME = fc
  .array(fc.oneof({ weight: 6, arbitrary: fc.constantFrom(..."abcxyzABCXYZ019-_ $~.'#@+") }, { weight: 1, arbitrary: fc.constantFrom("\u00e9", "\u00c9", "\u00df", "\u0131", "\u0130", "\u03a3", "\u03c3", "\u03c2", "\u4e2d", "\u{1f600}") }), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(""))
  .filter((name) => !/[. ]$/.test(name) && name !== "." && name !== "..");

/** A folder on a drive: its letter and its names. */
const folder = fc.record({ drive: fc.constantFrom("C", "D", "z"), names: fc.array(NAME, { maxLength: 4 }) });
type Folder = { drive: string; names: string[] };
const written = ({ drive, names }: Folder) => `${drive}:\\${names.join("\\")}`;

/** Other ways of writing the same folder: either separator, repeated, a final one, `.` and `x\..` on the way, the drive in either case. */
const respelled = (place: Folder) =>
  fc
    .record({
      upper: fc.boolean(),
      separators: fc.array(fc.constantFrom("\\", "/", "\\\\", "/\\", "\\.\\", "/./"), { minLength: place.names.length + 1, maxLength: place.names.length + 1 }),
      detour: fc.option(fc.tuple(fc.nat({ max: place.names.length }), NAME), { nil: undefined }),
      trailing: fc.constantFrom("", "\\", "/", "\\."),
    })
    .map(({ upper, separators, detour, trailing }) => {
      const names = [...place.names];
      if (detour !== undefined) names.splice(detour[0], 0, detour[1], "..");
      const drive = upper ? place.drive.toUpperCase() : place.drive.toLowerCase();
      return `${drive}:${separators[0]}${names.map((name, index) => `${index === 0 ? "" : separators[index % separators.length]}${name}`).join("")}${names.length === 0 ? "" : trailing}`;
    });

/** Paths off any drive: shares, device paths, in any mix of separators. */
const offTheDrives = fc.tuple(fc.constantFrom("\\\\", "//", "\\/", "/\\"), fc.constantFrom("server\\share", "localhost\\C$\\Users", "?\\C:\\Users", ".\\C:\\x", "?\\UNC\\server\\share", "./pipe/docker_engine", "", ".", "?")).map(([start, rest]) => `${start}${rest}`);

describe("Windows paths in the cage, fuzzed", () => {
  it(
    "give every spelling of a folder the same place, and another folder another place",
    () => {
      check(
        fc.property(folder.chain((place) => fc.tuple(fc.constant(place), respelled(place))), folder, ([place, spelling], other) => {
          const where = cagePath(written(place), "win32");
          expect(cagePath(spelling, "win32"), spelling).toBe(where);
          expect(where).toBe(`/${place.drive.toLowerCase()}${place.names.map((name) => `/${name}`).join("")}`);
          // Another folder has another place; the same names in another case are the same folder, which hostMount spells as the disk does.
          const same = written(other).toLowerCase() === written(place).toLowerCase();
          expect(cagePath(written(other), "win32").toLowerCase() === where.toLowerCase()).toBe(same);
        }),
        2000,
      );
    },
    TIMEOUT,
  );

  it(
    "refuse every path off a drive, and give every other absolute path a place on one",
    () => {
      check(
        fc.property(fc.oneof(offTheDrives, folder.chain(respelled)), (path) => {
          if (offDrive(path, "win32")) {
            expect(() => cagePath(path, "win32")).toThrow(NOT_ON_A_DRIVE);
            if (process.platform === "win32") expect(() => hostMount(path, true)).toThrow(NOT_ON_A_DRIVE);
          } else {
            expect(cagePath(path, "win32")).toMatch(/^\/[a-z](\/|$)/);
          }
          expect(offDrive(path, "darwin")).toBe(false);
        }),
        2000,
      );
    },
    TIMEOUT,
  );

  it(
    "map an argument inside a mounted folder inside its place, and leave every other argument as it is",
    () => {
      check(
        fc.property(fc.array(folder, { minLength: 1, maxLength: 3 }), folder.chain((place) => fc.tuple(fc.constant(place), respelled(place))), fc.array(NAME, { maxLength: 2 }), (mounted, [argument, spelling], below) => {
          const mounts = mounted.map((place) => ({ source: written(place), target: written(place), readOnly: true }));
          const arg = below.length === 0 ? spelling : `${spelling}${/[\\/]$/.test(spelling) ? "" : "\\"}${below.join("\\")}`;
          const args = runArgs(
            { serverId: "x", spec: { kind: "npm", packageName: "x", args: [arg] }, mounts, env: [], allowNet: false, memory: "512m", cpus: "1", keepImageUser: false },
            "image",
            "win32",
          );
          const given = args.at(-1)!;
          const names = [...argument.names, ...below];
          // The deepest mounted folder that holds the argument, without case.
          const holder = mounted
            .filter((place) => place.drive.toLowerCase() === argument.drive.toLowerCase() && place.names.length <= names.length && place.names.every((name, index) => name.toLowerCase() === names[index]!.toLowerCase()))
            .sort((left, right) => right.names.length - left.names.length)[0];
          if (holder === undefined) {
            expect(given).toBe(arg);
          } else {
            const inside = names.slice(holder.names.length);
            expect(given).toBe([cagePath(written(holder), "win32"), ...inside].join("/"));
          }
        }),
        1000,
      );
    },
    TIMEOUT,
  );

  it(
    "tell a path inside a folder from one beside it, without case when asked",
    () => {
      const path = fc.array(fc.constantFrom("a", "A", "ab", "b", "x.y", "\u00e9"), { maxLength: 4 }).map((names) => `${sep === "\\" ? "C:\\" : "/"}${names.join(sep)}`);
      check(
        fc.property(path, path, fc.boolean(), (inner, outer, fold) => {
          const names = (text: string) => text.split(sep).filter(Boolean).map((name) => (fold ? name.toLowerCase() : name));
          const [a, b] = [names(inner), names(outer)];
          expect(within(inner, outer, fold)).toBe(b.length <= a.length && b.every((name, index) => name === a[index]));
        }),
        2000,
      );
    },
    TIMEOUT,
  );

  it.runIf(process.platform === "win32")(
    "on Windows, mount every spelling of a folder on disk as the one folder it is",
    () => {
      const top = realpathSync.native(mkdtempSync(join(tmpdir(), "mcpcage-paths-")));
      const tree = ["Notes", "My Projects\\App", "dati\u00e9", "a.b\\c"];
      for (const dir of tree) mkdirSync(join(top, dir), { recursive: true });
      const [drive, ...rest] = top.split("\\");
      const base = { drive: drive![0]!, names: rest };
      // Each name in either case: the same folder. A final dot or space is not dropped from a name here:
      // node hands Windows its paths as \\?\ paths, which keep them, so "Notes." names nothing.
      const spelled = fc.tuple(fc.constantFrom(...tree), fc.array(fc.boolean(), { minLength: 40, maxLength: 40 })).chain(([dir, cases]) => {
        const place = { drive: base.drive, names: [...base.names, ...dir.split("\\")] };
        const flipped = { drive: place.drive, names: place.names.map((name, index) => (cases[index % cases.length] ? name.toUpperCase() : name.toLowerCase())) };
        return fc.tuple(fc.constant(place), respelled(flipped));
      });
      check(
        fc.property(spelled, ([place, spelling]) => {
          const expected = hostMount(written(place), true);
          const mount = hostMount(spelling, true);
          expect(mount.target, spelling).toBe(expected.target);
          expect(cagePath(mount.target)).toBe(cagePath(expected.target));
        }),
        300,
      );
      // Off any drive, refused before the disk is asked.
      for (const path of [`\\\\?\\${top}`, `\\\\localhost\\${drive![0]}$\\${rest.join("\\")}`, `//?/${top}`]) expect(() => hostMount(path, true)).toThrow(NOT_ON_A_DRIVE);
    },
    TIMEOUT,
  );
});
