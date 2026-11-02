// Entry point of every image mcpcage builds for an npm package. It starts the package's bin the
// way `npx <package>` would, but from the copy installed (with install scripts disabled) at build
// time, so nothing is downloaded or executed from the registry when the server runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const app = "/app";
const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const [name] = Object.keys(manifest.dependencies ?? {});
if (!name) {
  console.error("mcpcage launcher: no package is installed in this image");
  process.exit(1);
}

const packageDir = join(app, "node_modules", name);
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
let bin = pkg.bin;
if (bin !== null && typeof bin === "object") {
  // npx runs the bin named like the package (without its scope), or the only bin there is.
  const unscoped = name.split("/").pop();
  bin = bin[unscoped] ?? Object.values(bin)[0];
}
if (typeof bin !== "string") {
  console.error(`mcpcage launcher: ${name} declares no bin to run`);
  process.exit(1);
}

const script = join(packageDir, bin);
// The server should see the same argv as under npx: [node, script, ...args].
process.argv.splice(1, 1, script);
await import(pathToFileURL(script).href);
