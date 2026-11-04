import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { root } from "./helpers.js";

// runtime/launcher.mjs is plain JavaScript, the entry point of every image: it is loaded by its path,
// as the image runs it, and imported here only for the choice of program, without starting anything.
const { pickBin } = (await import(pathToFileURL(join(root, "runtime", "launcher.mjs")).href)) as { pickBin: (name: string, bin: unknown) => string };

describe("the program the launcher starts, as npx would", () => {
  it("runs a bin given as a string", () => {
    expect(pickBin("@acme/server", "dist/cli.js")).toBe("dist/cli.js");
  });

  it("runs the bin named like the package without its scope", () => {
    expect(pickBin("@acme/server", { helper: "dist/helper.js", server: "dist/cli.js" })).toBe("dist/cli.js");
    expect(pickBin("server", { helper: "dist/helper.js", server: "dist/cli.js" })).toBe("dist/cli.js");
  });

  it("runs the one file that every bin points at", () => {
    expect(pickBin("@acme/server", { "acme-server": "./dist/cli.js", acme: "dist/cli.js" })).toBe("./dist/cli.js");
    expect(pickBin("@acme/server", { only: "dist/cli.js" })).toBe("dist/cli.js");
  });

  it("refuses several different programs none of which is named like the package, naming them", () => {
    expect(() => pickBin("@acme/server", { helper: "dist/helper.js", other: "dist/other.js" })).toThrow(
      '@acme/server declares several bins and none is named "server", so npx would not run any of them either: "helper", "other"',
    );
    // Inherited names do not count as bins: "constructor" is not an entry of this object.
    expect(() => pickBin("constructor", { helper: "dist/helper.js", other: "dist/other.js" })).toThrow('none is named "constructor"');
    for (const bin of [undefined, null, {}, { broken: 3 }]) expect(() => pickBin("@acme/server", bin)).toThrow("@acme/server declares no bin to run");
  });
});
