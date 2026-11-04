import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Every test that needs a scratch directory makes one with mkdtemp under the system's temporary
 * directory, and the CLI processes the tests start do the same. Nothing removed them: a full run
 * left about 9,000 directories behind (half a gigabyte), and repeated runs filled the disk of the
 * machine they ran on. The run gets one temporary directory of its own instead, which every test and
 * every process it starts uses through TMPDIR (TMP and TEMP on Windows), and which is removed whole
 * when the run ends.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "mcpcage-vitest-"));
  for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = root;
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
