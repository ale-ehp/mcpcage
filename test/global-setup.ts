import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Every test that needs a scratch directory makes one with mkdtemp under the system's temporary
 * directory, and the CLI processes the tests start do the same. Nothing removed them: a full run
 * left about 9,000 directories behind (half a gigabyte), and repeated runs filled the disk of the
 * machine they ran on. The run gets one temporary directory of its own instead, which every test and
 * every process it starts uses through TMPDIR (TMP and TEMP on Windows), and which is removed whole
 * when the run ends.
 *
 * Its name holds the pid of the process that made it, mcpcage-vitest-<pid>-XXXXXX, so that a root
 * whose run never ended can be told from one whose run goes on. The teardown that removes a root runs
 * only when vitest ends normally, and Stryker (npm run mutation) ends its test processes by killing
 * them: when a mutant times out, and when the run is over. Five hours of mutation runs left about 330
 * roots of some 67 MB each, and the disk filled until the tests failed with ENOSPC, which Stryker
 * counted as mutants killed. So each run first removes the roots of processes that are gone; never
 * one of a process that is alive, which another run on the machine may be using now.
 */
export default function setup(): () => void {
  removeStaleRoots(tmpdir());
  const root = mkdtempSync(join(tmpdir(), `mcpcage-vitest-${process.pid}-`));
  for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = root;
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Removes the roots in `dir` (mcpcage-vitest-<pid>-XXXXXX) whose process is no longer alive. A root
 * of the older form, without a pid, names no process and is left, as is anything else.
 */
export function removeStaleRoots(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const owner = /^mcpcage-vitest-([0-9]+)-[^-]+$/.exec(name);
    if (owner === null || alive(Number(owner[1]))) continue;
    rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Whether a process runs under `pid`. Signal 0 tests it without sending anything, on Windows too:
 * ESRCH says there is none; EPERM that there is one, of another user, which is alive.
 */
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
