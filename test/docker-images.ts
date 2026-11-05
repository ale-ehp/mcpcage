import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerProgram } from "../src/sandbox.js";

/*
 * The Docker tests (npm run test:docker) build eight images per run and removed none of them. On a
 * Mac with Colima's Docker, whose CLI has no buildx and builds with the classic builder, each run left
 * 72 more images in `docker images --all` and 0.84 GB more in `docker system df`: the image tagged
 * mcpcage/<server>:<hash> of each build, the images of each step of its two stages, and, untagged,
 * the image of the install stage and every image whose tag a later build took (probe, abuse... are
 * the same names every run).
 * After a few runs that Mac held 38 images named mcpcage/notes-server-<hex>, mcpcage/probe... and a
 * Windows PC 21 more.
 *
 * A developer's own images are named the same way, mcpcage/<server>, so nothing is removed by name.
 * Each file removes, when it ends, the images that its own mcpcage commands built, by id: those that
 * `docker build` named in what it printed, and those the servers of its mcpcage homes record in
 * server.json. An image that was there when the file started is left alone, whatever it is called.
 */

/** What one Docker test file built; remove() removes it. */
export interface BuiltImages {
  /** Notes what the mcpcage command that returned `result` built with `home` as MCPCAGE_HOME, and returns `result`. */
  track<Result extends { stderr: string }>(result: Result, home: string): Result;
  /**
   * Removes the images noted, the containers of a build step that failed and any container still
   * running from them. Docker gone, or anything it refuses, is a warning: it never fails the run.
   */
  remove(): void;
}

/** To be called before the file builds anything: what Docker has then is never removed. */
export function builtImages(): BuiltImages {
  const before = imagesNow();
  const images = new Set<string>();
  const containers = new Set<string>();
  const homes = new Set<string>();
  return {
    track(result, home) {
      homes.add(home);
      fromBuildOutput(result.stderr, images, containers);
      // A later build of the same server takes the tag and server.json: what this one built is noted now.
      fromServers(home, images);
      return result;
    },
    remove() {
      if (before === undefined || homes.size === 0) return;
      if (imagesNow() === undefined) {
        console.warn("mcpcage tests: Docker did not answer, so the images this file built were not removed");
        return;
      }
      try {
        // A session can build too, when it finds no image: what the servers record at the end.
        for (const home of homes) fromServers(home, images);
        const built = existingImages([...images]).filter((image) => !before.has(image.id));
        const ids = built.map((image) => image.id);
        // `docker run --rm` removes a cage when it stops, and the cage of a session that a failed test
        // left open stops only when vitest ends: the images could not go while it ran.
        const left = [...existingContainers([...containers]), ...containersOf(ids)];
        if (left.length > 0) docker(["rm", "--force", ...new Set(left)]);
        // Removing an image removes its parents that have no tag and no other child, the steps of its
        // build: only the last image of each chain is named, then whatever is still there.
        const parents = new Set(built.map((image) => image.parent));
        removeImages(ids.filter((id) => !parents.has(id)));
        removeImages(existingImages(ids).map((image) => image.id));
        const kept = existingImages(ids);
        if (kept.length > 0) console.warn(`mcpcage tests: Docker kept ${kept.length} of the images this file built: ${kept.map((image) => image.id).join(" ")}`);
      } catch (error) {
        console.warn(`mcpcage tests: the images this file built were not removed: ${(error as Error).message}`);
      }
    },
  };
}

/**
 * The images and containers named in what the classic builder printed: the image each step made
 * (" ---> 1b92eabc631f") and the container each step ran in (" ---> Running in 67f68e295470"), which
 * stays when the step fails. The image a FROM step prints is the base image, which is not the build's.
 * BuildKit prints neither and keeps no image but the one it tags, which server.json records.
 */
function fromBuildOutput(output: string, images: Set<string>, containers: Set<string>): void {
  let base = false;
  for (const line of output.split(/\r?\n/)) {
    const step = /^Step \d+\/\d+ : (\w+)/.exec(line);
    if (step) {
      base = step[1]!.toUpperCase() === "FROM";
      continue;
    }
    const container = /^ ---> Running in ([0-9a-f]{12,64})$/.exec(line);
    if (container) containers.add(container[1]!);
    const image = /^ ---> ([0-9a-f]{12,64})$/.exec(line);
    if (image && !base) images.add(image[1]!);
  }
}

/** The images that the servers in `home` were built into, as their server.json says. */
function fromServers(home: string, images: Set<string>): void {
  let servers: string[];
  try {
    servers = readdirSync(join(home, "servers"));
  } catch {
    return;
  }
  for (const server of servers) {
    try {
      const record = JSON.parse(readFileSync(join(home, "servers", server, "server.json"), "utf8")) as { spec?: { kind?: string }; imageId?: string };
      // An image given with --image was pulled or was there, not built.
      if (record.spec?.kind === "npm" && record.imageId) images.add(record.imageId);
    } catch {
      // no image built for this server
    }
  }
}

/** The ids of every image, intermediate ones included; undefined when Docker cannot say, and then nothing is removed. */
function imagesNow(): Set<string> | undefined {
  try {
    const listed = docker(["images", "--all", "--quiet", "--no-trunc"]);
    return listed.status === 0 ? new Set(lines(listed.stdout)) : undefined;
  } catch {
    return undefined;
  }
}

/** Those of `references` that are images now, by their full id, with their parent's. */
function existingImages(references: string[]): Array<{ id: string; parent: string }> {
  if (references.length === 0) return [];
  // Each one gone is an error that stops nothing: the others are still printed.
  const inspected = docker(["image", "inspect", "--format", "{{.Id}} {{.Parent}}", ...references]);
  const images = new Map<string, string>();
  for (const line of lines(inspected.stdout)) {
    const [id, parent = ""] = line.split(" ");
    if (id) images.set(id, parent);
  }
  return [...images].map(([id, parent]) => ({ id, parent }));
}

function existingContainers(references: string[]): string[] {
  if (references.length === 0) return [];
  return lines(docker(["container", "inspect", "--format", "{{.Id}}", ...references]).stdout);
}

/** The containers, running or not, of `images` and the images made from them. */
function containersOf(images: string[]): string[] {
  if (images.length === 0) return [];
  return lines(docker(["ps", "--all", "--quiet", "--no-trunc", ...images.flatMap((id) => ["--filter", `ancestor=${id}`])]).stdout);
}

function removeImages(ids: string[]): void {
  if (ids.length > 0) docker(["rmi", ...ids]);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean);
}

/** Runs docker as mcpcage finds it (see dockerProgram), with a time limit: a daemon that hangs must not hold the run. */
function docker(args: string[]): { status: number | null; stdout: string } {
  const program = dockerProgram();
  if (program === undefined) throw new Error("docker is not installed");
  const result = spawnSync(program.file, [...program.args, ...args], { encoding: "utf8", env: program.env, timeout: 60_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout };
}
