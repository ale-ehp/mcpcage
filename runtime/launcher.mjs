// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
// Entry point of every image mcpcage builds for an npm package. It starts the package's bin the
// way `npx <package>` would, but from the copy installed (with install scripts disabled) at build
// time, so nothing is downloaded or executed from the registry when the server runs.
import { readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The bin `npx <name>` would run, as a path inside the package. Like npx: a string bin; else the bin
 * named like the package without its scope; else the one file that every bin points at. npx refuses a
 * package with several different programs, none named like it ("could not determine executable to
 * run"); running the first of them instead started a program the original command never would.
 */
export function pickBin(name, bin) {
  if (typeof bin === "string") return bin;
  const bins = bin !== null && typeof bin === "object" ? Object.entries(bin).filter(([, file]) => typeof file === "string") : [];
  if (bins.length === 0) throw new Error(`${name} declares no bin to run`);
  const unscoped = name.split("/").pop();
  const named = bins.find(([command]) => command === unscoped);
  if (named) return named[1];
  if (new Set(bins.map(([, file]) => posix.normalize(file))).size === 1) return bins[0][1];
  const commands = bins.map(([command]) => JSON.stringify(command)).join(", ");
  throw new Error(`${name} declares several bins and none is named "${unscoped}", so npx would not run any of them either: ${commands}`);
}

async function launch() {
  const app = "/app";
  const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  const [name] = Object.keys(manifest.dependencies ?? {});
  if (!name) {
    console.error("mcpcage launcher: no package is installed in this image");
    process.exit(1);
  }

  const packageDir = join(app, "node_modules", name);
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  let bin;
  try {
    bin = pickBin(name, pkg.bin);
  } catch (error) {
    console.error(`mcpcage launcher: ${error.message}`);
    process.exit(1);
  }

  const script = join(packageDir, bin);
  // The server should see the same argv as under npx: [node, script, ...args].
  process.argv.splice(1, 1, script);
  await import(pathToFileURL(script).href);
}

/** Whether node was started on this file, as the image does, rather than a test importing pickBin. */
function startedAsEntrypoint() {
  try {
    // Node gives the main module the URL of its real path, the one compared here.
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (startedAsEntrypoint()) await launch();
