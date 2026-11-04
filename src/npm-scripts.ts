import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { sha256 } from "./canonical.js";
import { isJsonObject } from "./jsonc.js";
import { readJson, writeJson } from "./pinstore.js";
import { npmProgram } from "./sandbox.js";

/** Whether installing a package runs code of its own first: the hook that worms like Shai-Hulud use. */
export interface InstallScripts {
  status: "none" | "found" | "unknown";
  /** The install-time scripts the package declares, among preinstall, install and postinstall. */
  scripts: string[];
  /** Why the answer is unknown, or a note about `prepare`. */
  detail: string;
}

export type NpmRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

const INSTALL_TIME = ["preinstall", "install", "postinstall"];
const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedAnswer {
  spec: string;
  fetchedAt: string;
  /** null when the package declares no scripts at all. */
  scripts: Record<string, unknown> | null;
}

/**
 * Asks npm which scripts a package declares (`npm view <spec> scripts --json`), and keeps the answer
 * for a week under mcpcage's own cache. npm gets its cache there too and writes no log files, so a
 * lookup never writes anywhere else on the machine.
 */
export function installScripts(spec: string, options: { offline: boolean; cacheDir: string; runner?: NpmRunner }): InstallScripts {
  const file = join(options.cacheDir, "npm-view", `${sha256(spec)}.json`);
  const cached = readCache(file);
  // Offline, an answer older than a week is still better than none.
  if (cached && (options.offline || Date.now() - Date.parse(cached.fetchedAt) < VALID_FOR_MS)) return summarize(cached.scripts);

  const args = [
    "view", spec, "scripts", "--json",
    ...(options.offline ? ["--offline"] : []),
    `--cache=${join(options.cacheDir, "npm")}`, "--logs-max=0", "--no-update-notifier",
  ];
  const answer = interpret((options.runner ?? runNpm)(args));
  if ("scripts" in answer) {
    const entry: CachedAnswer = { spec, fetchedAt: new Date().toISOString(), scripts: answer.scripts };
    try {
      writeJson(file, entry);
    } catch {
      // A cache that cannot be written only means npm is asked again next time: the answer stands.
    }
    return summarize(answer.scripts);
  }
  return { status: "unknown", scripts: [], detail: options.offline ? "offline, not in cache" : answer.error };
}

function summarize(scripts: Record<string, unknown> | null): InstallScripts {
  const declared = Object.keys(scripts ?? {});
  const found = INSTALL_TIME.filter((name) => declared.includes(name));
  // npm runs prepare when it installs from git or a folder, never for a package from the registry.
  const detail = declared.includes("prepare") ? "prepare runs only for git installs" : "";
  return found.length > 0 ? { status: "found", scripts: found, detail } : { status: "none", scripts: [], detail };
}

function interpret(result: ReturnType<NpmRunner>): { scripts: Record<string, unknown> | null } | { error: string } {
  const output = result.stdout.trim();
  let value: unknown;
  try {
    value = output === "" ? undefined : JSON.parse(output);
  } catch {
    return { error: "npm view printed something that is not JSON" };
  }
  if (isJsonObject(value) && isJsonObject(value.error)) return { error: npmError(value.error) };
  if (result.status !== 0) return { error: result.stderr.trim().split("\n")[0]?.slice(0, 160) || `npm view failed (exit code ${result.status})` };
  // No output at all: the package has no "scripts" field.
  if (value === undefined) return { scripts: null };
  // A range that matches several versions gives one object per version; any of them may be installed.
  // Anything else (a string, a number, null) is not an answer to the question: "none" would claim
  // that the package runs nothing at install time, which nobody has checked.
  const versions = Array.isArray(value) ? value : [value];
  if (!versions.every(isJsonObject)) return { error: "npm view gave an answer of an unexpected shape" };
  const scripts: Record<string, unknown> = {};
  for (const version of versions) Object.assign(scripts, version);
  return { scripts };
}

/** npm's error in a few words; a code or summary that is not a string is left out, never converted. */
function npmError(error: Record<string, unknown>): string {
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "E404") return "not found on the npm registry";
  if (code === "ENOTCACHED") return "not in the npm cache";
  const summary = typeof error.summary === "string" ? (error.summary.split("\n")[0] ?? "").slice(0, 160) : "";
  const words = [code, summary].filter(Boolean).join(" ");
  return words === "" ? "npm view failed with an error of an unexpected shape" : `npm view failed: ${words}`;
}

function readCache(file: string): CachedAnswer | undefined {
  try {
    const cached = readJson<CachedAnswer>(file);
    return cached && typeof cached.fetchedAt === "string" && (cached.scripts === null || isJsonObject(cached.scripts)) ? cached : undefined;
  } catch {
    return undefined; // a damaged cache file is looked up again
  }
}

/**
 * Runs the npm that packs a local package (npmProgram), never through a shell: the package spec comes
 * from a client's configuration, and on Windows npm.cmd starts only through cmd.exe, which reads its
 * command line for commands and variables. There it is the node running mcpcage with npm's own script.
 */
function runNpm(args: string[]): ReturnType<NpmRunner> {
  const npm = npmProgram();
  // Found nowhere on Windows, npm is not started by its bare name (see foundNowhere in sandbox.ts).
  if (npm === undefined) return { status: null, stdout: "", stderr: "npm is not installed" };
  const result = spawnSync(npm.file, [...npm.args, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: npm.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason = code === "ETIMEDOUT" ? "npm view did not answer within 20 s" : code === "ENOENT" ? "npm is not installed" : result.error.message;
    return { status: null, stdout: "", stderr: reason };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
