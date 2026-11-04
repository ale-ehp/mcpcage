import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

const home = userInfo().homedir;

/** Where mcpcage looks for docker before the PATH, in this order, and all its programs' PATH holds (see trustedPlaces in sandbox.ts). */
export const STANDARD_PLACES = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  join(home, ".docker/bin"),
  join(home, ".orbstack/bin"),
  join(home, ".rd/bin"),
  "/Applications/Docker.app/Contents/Resources/bin",
  "/run/current-system/sw/bin",
  join(home, ".nix-profile/bin"),
];

/** The docker in a standard place, which mcpcage runs whatever the PATH says; undefined when none has one, and on Windows. */
export const standardDocker = process.platform === "win32" ? undefined : STANDARD_PLACES.map((dir) => join(dir, "docker")).find(isProgram);

export function isProgram(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * A directory, `path` with it first in the PATH, that holds a fake docker, docker-credential-desktop
 * (the credential helper Docker Desktop configures), npm and node, as a server entry's PATH could put
 * them before the real ones. Each fails, and writes its name and arguments to what `ran` returns.
 */
export function fakePrograms(): { dir: string; path: string; ran: () => string } {
  const top = mkdtempSync(join(tmpdir(), "mcpcage-fake-programs-"));
  const dir = join(top, "bin");
  const marker = join(top, "ran");
  mkdirSync(dir);
  for (const name of ["docker", "docker-credential-desktop", "npm", "node"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${marker}'\nexit 1\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, path: `${dir}${delimiter}${process.env.PATH ?? ""}`, ran: () => (existsSync(marker) ? readFileSync(marker, "utf8") : "") };
}

/**
 * Variables under which mcpcage reaches no Docker: no docker on the PATH, and for the docker it finds
 * in a standard place whatever the PATH says, a daemon socket that does not exist.
 */
export function noDocker(dir: string): { PATH: string; DOCKER_HOST: string } {
  const nowhere = join(dir, "no-docker-here");
  return { PATH: nowhere, DOCKER_HOST: `unix://${join(nowhere, "docker.sock")}` };
}

/** Runs `run` as mcpcage would on Windows, started by the node at `node`. */
export function onWindows<T>(run: () => T, node = process.execPath): T {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "execPath", { ...execPath, value: node });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "execPath", execPath);
  }
}
