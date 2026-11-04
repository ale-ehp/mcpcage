import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { envValues, hostPath, hostVariable, isWrapped, mcpcageArgs, moveHostEnv, relaunch, serverType, unwrapEntry, withoutEnvValues, wrapEntry, type ServerEntry } from "../src/config.js";
import { isJsonObject } from "../src/jsonc.js";
import { parseLaunch } from "../src/launch.js";
import { anyText, check, jsonValue, PROTOTYPE_NAMES, TIMEOUT } from "./fuzz.js";
import { onWindows } from "./fake-programs.js";
import { freshHome, stubHome } from "./helpers.js";

/*
 * Configuration files are written by anyone, and wrap and --fix rewrite them: for any npx entry,
 * unwrap must give back what wrap was given (but the variables wrap drops, HOME and the like, and with
 * the paths it mounts as it mounts them), every function that reads an entry must take any JSON
 * without throwing, and no spelling of a place that holds credentials may end up mounted.
 */

let home: string;
beforeAll(() => {
  home = realpathSync.native(freshHome());
  stubHome(home);
  vi.stubEnv("MCPCAGE_HOME", join(home, ".mcpcage"));
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const isObject = (value: unknown): value is Record<string, unknown> => isJsonObject(value);

/** JSON equality whatever the order of the keys. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  if (isObject(left) || isObject(right)) {
    if (!isObject(left) || !isObject(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return left === right;
}

/** Names of an entry's env: those that act on the host, those that do not, and odd ones. */
const ENV_NAMES = [
  "NODE_OPTIONS", "node_options", "NODE_ENV", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "OPENSSL_CONF", "OPENSSL_X", "GCONV_PATH", "BASH_ENV", "SHELLOPTS", "PS4", "ZDOTDIR",
  "BASH_FUNC_ls%%", "DOCKER_HOST", "DOCKER_CONFIG", "npm_config_registry", "NPM_CONFIG_X", "HOME", "USERPROFILE", "MCPCAGE_HOME", "PATH", "API_KEY", "GITHUB_TOKEN",
  "COPILOT_HOME", "", "A B", "x-y", "--", "--env", "--mount", "-y", "run", ...PROTOTYPE_NAMES,
];

/** Values: strings mostly, a local Docker socket, and values that are no string. */
const envValue = fc.oneof({ weight: 6, arbitrary: anyText(16) }, { weight: 1, arbitrary: fc.constantFrom("unix:///var/run/docker.sock", "tcp://evil:2375", "--", "a=b") }, { weight: 1, arbitrary: jsonValue(1) });

/** An argument a server is given: text, flags mcpcage and npx read, paths that exist and do not. */
const serverArg = fc.oneof(
  { weight: 4, arbitrary: anyText(16) },
  { weight: 2, arbitrary: fc.constantFrom("--", "run", "--env", "--env=X=1", "--mount", "--no-sandbox", "-y", "--yes", "~", "~/", "~/missing", "/missing/x", "x:rw", "notes:ro", "a=b", "") },
);

/** An npx entry as clients write them, with any env and other fields. */
const npxEntry = fc
  .record({
    command: fc.constantFrom("npx", "npx.cmd", "/usr/local/bin/npx"),
    flags: fc.array(fc.constantFrom("-y", "--yes", "-q", "--quiet"), { maxLength: 2 }),
    spec: fc.oneof(fc.constantFrom("@acme/notes-mcp", "@acme/notes-mcp@1.2.3", "left-pad@^1", "pkg@latest", "./local-server", "../x", "server.tgz"), fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/)),
    server: fc.array(serverArg, { maxLength: 5 }),
    env: fc.oneof(
      { weight: 4, arbitrary: fc.array(fc.tuple(fc.oneof(fc.constantFrom(...ENV_NAMES), anyText(6)), envValue), { maxLength: 6 }).map((pairs) => Object.fromEntries(pairs)) },
      { weight: 1, arbitrary: jsonValue(1) },
      { weight: 1, arbitrary: fc.constant(undefined) },
    ),
    extra: fc.array(fc.tuple(fc.constantFrom("type", "cwd", "disabled", "timeout", "__proto__", "envFile_"), jsonValue(1)), { maxLength: 2 }),
  })
  .map(({ command, flags, spec, server, env, extra }) => {
    const entry: ServerEntry = { ...Object.fromEntries(extra), command, args: [...flags, spec, ...server] };
    if (env !== undefined) entry.env = env as Record<string, string>;
    return entry;
  });

/** What unwrap should give back: the entry with its host-only variables dropped, and its paths as wrap mounts them. */
function expectedBack(entry: ServerEntry): ServerEntry {
  const expected: ServerEntry = { ...entry };
  if (isObject(entry.env)) expected.env = Object.fromEntries(Object.entries(entry.env).filter(([name, value]) => hostVariable(name, value)?.to !== "drop")) as Record<string, string>;
  const args = entry.args as string[];
  const server = parseLaunch([entry.command as string, ...args]).args.length;
  expected.args = args.map((arg, index) => (index >= args.length - server ? (hostPath(arg) ?? arg) : arg));
  return expected;
}

describe("configuration rewriting, fuzzed", () => {
  it(
    "gives back the entry wrap was given, whatever its arguments and env",
    () => {
      check(
        fc.property(npxEntry, fc.boolean(), fc.constantFrom<string | { node: string; script: string }>("mcpcage", "/opt/mcpcage/bin/mcpcage", { node: "/usr/bin/node", script: "/opt/mcpcage/dist/cli.js" }), (entry, writable, command) => {
          const wrapped = wrapEntry(entry, { command, writable });
          // Only an entry wrap rewrites says anything here; most do, and fast-check fails if too few did.
          fc.pre(!("skip" in wrapped));
          if ("skip" in wrapped) return;
          expect(isWrapped(wrapped.entry) || typeof command === "object").toBe(true);
          // The variables that act on the host have moved: nothing is left to move.
          if (typeof command === "string") expect(moveHostEnv(wrapped.entry)).toBeUndefined();
          const back = unwrapEntry(typeof command === "string" ? wrapped.entry : { ...wrapped.entry, command: "mcpcage", args: (wrapped.entry.args as string[]).slice(1) });
          expect("entry" in back).toBe(true);
          const restored = (back as { entry: ServerEntry }).entry;
          // The same JSON: the variables wrap moved into the arguments come back last in env.
          const expected = expectedBack(entry);
          expect(jsonEqual(restored, expected), `${JSON.stringify(restored)}\n  is not\n${JSON.stringify(expected)}`).toBe(true);
        }),
        1000,
      );
    },
    TIMEOUT,
  );

  it(
    "reads any JSON as an entry without throwing, on every system",
    () => {
      const field = fc.oneof(jsonValue(2), anyText(10), fc.constantFrom("mcpcage", "mcpcage.cmd", "MCPCAGE.CMD", "node.exe", "npx", "cmd", "C:\\Windows\\cmd.exe", "run", "--", "cli.js"));
      const entry = fc
        .record(
          {
            command: field,
            args: fc.oneof(fc.array(field, { maxLength: 6 }), field, fc.array(fc.constantFrom("run", "--", "--env", "NODE_OPTIONS=x", "--env=HOME=/", "/c", "npx", "cli.js"), { maxLength: 6 })),
            env: fc.oneof(field, fc.array(fc.tuple(fc.constantFrom(...ENV_NAMES), field), { maxLength: 4 }).map((pairs) => Object.fromEntries(pairs))),
            type: field,
            url: field,
          },
          { requiredKeys: [] },
        )
        .map((value) => value as ServerEntry);
      check(
        fc.property(entry, fc.constantFrom<NodeJS.Platform>("darwin", "linux", "win32"), (value, platform) => {
          const read = () => {
            serverType(value, platform);
            if (isWrapped(value, platform)) {
              mcpcageArgs(value);
              unwrapEntry(value);
              moveHostEnv(value);
              relaunch(value, "mcpcage");
            }
            if (Array.isArray(value.args)) {
              envValues(value.args);
              withoutEnvValues(value.args.filter((arg): arg is string => typeof arg === "string"));
            }
          };
          if (platform === "win32") onWindows(read);
          else read();
        }),
        1000,
      );
    },
    TIMEOUT,
  );
});

/**
 * A home directory with the places that hold credentials and run code, one ordinary project, and
 * links into both. Each place is created, so that every spelling of it exists and wrap considers it.
 */
const PLACES = [
  ".ssh", ".aws", ".gnupg", ".config/gcloud", ".config/gh", ".mcpcage", ".claude", ".cursor", ".vscode", ".npm", ".local/bin", "bin", ".docker", ".kube", ".colima",
  ...{
    darwin: ["Library/Keychains", "Library/Application Support/Claude", "Library/LaunchAgents"],
    win32: ["AppData/Roaming/Claude", "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"],
  }[process.platform as string] ?? [".config/autostart", ".config/Code"],
];
const FILES = [".npmrc", ".netrc", ".gitconfig", ".zshrc", ".bashrc", ".claude.json", ".ssh/id_ed25519"];
const ORDINARY = ["projects/notes", "Documents/plans"];

function makeHome(): void {
  for (const place of [...PLACES, ...ORDINARY]) mkdirSync(join(home, ...place.split("/")), { recursive: true });
  for (const file of FILES) writeFileSync(join(home, ...file.split("/")), "x");
  writeFileSync(join(home, "projects", "notes", "todo.txt"), "x");
  // A link is a junction on Windows, which needs no privilege.
  const link = (target: string, at: string) => symlinkSync(join(home, ...target.split("/")), join(home, ...at.split("/")), "junction");
  link(".ssh", "projects/keys");
  link(".aws", "Documents/cloud");
  link("projects/notes", "notes-link");
}

/** The place a path really is, without case where the system ignores it. */
function realKey(path: string): string {
  const real = realpathSync.native(path);
  return process.platform === "linux" ? real : real.toLowerCase();
}

/** Whether a mount of `path` would open a sensitive place: the home directory or what holds it, a place, inside one, or what holds one. */
function opensSensitive(path: string): string | undefined {
  const mounted = realKey(path);
  const places = [...PLACES.map((place) => join(home, ...place.split("/"))), ...FILES.map((file) => join(home, ...file.split("/")))].map(realKey);
  const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
  // The home directory counts whole, and so does what holds it; a folder inside it only when it is in one of the places.
  return inside(realKey(home), mounted) ? home : places.find((place) => inside(mounted, place) || inside(place, mounted));
}

/** Spellings of one path below the home directory, as a configuration could write it on this system. */
const spelling = (relative: string, file: boolean) => {
  const names = relative.split("/");
  const separator = process.platform === "win32" ? fc.constantFrom("\\", "/", "\\\\", "/\\") : fc.constantFrom("/", "//", "/./");
  return fc
    .record({
      tilde: fc.boolean(),
      cases: fc.array(fc.boolean(), { minLength: relative.length, maxLength: relative.length }),
      separators: fc.array(separator, { minLength: names.length, maxLength: names.length }),
      // Before the last name: `x.txt/.` names nothing either.
      detour: fc.option(fc.nat({ max: names.length - 1 }), { nil: undefined }),
      // A file has no final separator: `x.txt/` names nothing.
      trailing: file ? fc.constant("") : fc.constantFrom("", sep, "/", process.platform === "win32" ? "\\." : "/."),
    })
    .map(({ tilde, cases, separators, detour, trailing }) => {
      // Case changes only where the system ignores case: elsewhere they name another file, which does not exist.
      let flipped = [...relative].map((char, index) => (process.platform !== "linux" && cases[index] ? char.toUpperCase() : char)).join("");
      const parts = flipped.split("/");
      // A detour through a directory and back from the home directory (`projects/../`), or a `.` anywhere.
      if (detour === 0) parts.splice(0, 0, "projects", "..");
      else if (detour !== undefined) parts.splice(detour, 0, ".");
      flipped = parts.map((name, index) => `${index === 0 ? "" : separators[index % separators.length]}${name}`).join("");
      const start = tilde ? "~/" : `${home}${separators[0]}`;
      return `${start}${flipped}${trailing}`;
    });
};

describe("wrap and sensitive places, fuzzed", () => {
  beforeAll(makeHome);

  it(
    "never mounts a spelling of a place that holds credentials or runs code, and still mounts an ordinary folder",
    () => {
      const places = [...PLACES, ...FILES, "projects/keys", "projects/keys/id_ed25519", "Documents/cloud", "", "projects/.."];
      check(
        fc.property(fc.constantFrom(...places, ...ORDINARY, "notes-link", "projects/notes/todo.txt").chain((place) => fc.tuple(fc.constant(place), spelling(place, FILES.includes(place) || place.endsWith(".txt") || place.endsWith("id_ed25519")))), ([place, path]) => {
          const wrapped = wrapEntry({ command: "npx", args: ["-y", "@acme/files-mcp", path] }, { command: "mcpcage", writable: true });
          const mounts = "skip" in wrapped ? [] : (wrapped.entry.args as string[]).flatMap((arg, index, args) => (args[index - 1] === "--mount" ? [arg.replace(/:rw$/, "")] : []));
          for (const mount of mounts) expect(opensSensitive(mount), `${path} was mounted as ${mount}`).toBeUndefined();
          if (ORDINARY.includes(place) || place === "notes-link" || place === "projects/notes/todo.txt") expect(mounts, `${path} is an ordinary place`).toHaveLength(1);
        }),
        // Each run asks the disk where some 80 places really are, which takes a while on Windows.
        process.platform === "win32" ? 60 : 300,
        5,
      );
    },
    TIMEOUT,
  );
});
