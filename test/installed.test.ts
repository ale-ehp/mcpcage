import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { foreignPath } from "../src/installed.js";

// What an entry's own env decides on the host for the mcpcage it starts. The report's lines and
// --fix's plan for them are in protect.test.ts.

describe("the PATH an entry sets", () => {
  it("compares directories as they resolve, and never takes a relative one of the user's PATH for theirs", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-path-"));
    const real = join(top, "real");
    mkdirSync(real);
    symlinkSync(real, join(top, "link"));
    const missing = join(top, "missing");
    vi.stubEnv("PATH", [join(top, "link"), "relative", missing].join(delimiter));
    try {
      expect(foreignPath({ PATH: real })).toBeUndefined();
      // Not there: compared as written, `..` and a final separator resolved.
      expect(foreignPath({ PATH: `${join(missing, "..", "missing")}${sep}` })).toBeUndefined();
      expect(foreignPath({ PATH: `relative${delimiter}${real}${delimiter}${delimiter}relative` })).toEqual({ dirs: ["relative", ""] });
      expect(foreignPath({ PATH: join(top, "other") })).toEqual({ dirs: [join(top, "other")] });
      expect(foreignPath({ PATH: ["x"] })).toEqual({ dirs: [], notString: true });
      expect([foreignPath({}), foreignPath(undefined), foreignPath({ Path: join(top, "other") })]).toEqual([undefined, undefined, process.platform === "win32" ? { dirs: [join(top, "other")] } : undefined]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
