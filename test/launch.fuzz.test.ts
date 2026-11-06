import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serverType } from "../src/config.js";
import { cmdRunner, isNpx, isUvx, npxArgv, parseLaunch, pypiRequirement, serverIdFor, splitPackageSpec, toolRunArgs, type PypiLaunch } from "../src/launch.js";
import { resolvePypi, type DockerRunner } from "../src/pypi.js";
import { anyText, check, TIMEOUT } from "./fuzz.js";

/*
 * What a server's command line is, decided from text a configuration holds: npx and its package, or
 * on Windows `cmd /c npx ...`, which cmd.exe reads before npx does. A line taken for plain npx is run
 * without cmd, so it must hold nothing cmd would have read differently.
 */

/** Words of uv's command lines: uvx and uv, their flags and values, requirements of every kind. */
const UV_WORDS = [
  "uvx", "UVX.EXE", "uvx.exe", "C:\\Users\\me\\.local\\bin\\uvx.exe", "/usr/local/bin/uvx", "uv", "uv.exe", "tool", "run",
  "--from", "--from=x", "--with", "-w", "--with=a,b>=1,<2", "-wx", "-p", "--python", "--python=3.13", "-p3.12", "3.12", "3.12.4", "3.9", "312",
  "--prerelease", "allow", "--exclude-newer", "P3D", "2026-01-01", "3 days", "--color", "never", "--offline", "-q", "-qq", "-qwx", "-n", "--refresh",
  "--index-url", "--index-url=https://u:p@x/simple", "-i", "-ihttps://x", "--directory", "--constraints", "--no-binary", "--upgrade", "-U",
  "mcp-server-time", "Mcp_Server.Time", "mcp-server-time@latest", "mcp-server-time@2026.1.26", "pkg@v1.2", "pkg[x]", "pkg[a,b]@1.0", "pkg==1.0", "pkg>=1,<2",
  "pkg ~= 1.2", "pkg===1.0", "pkg==1.*", "pkg@>=1", "pkg@LATEST", "pkg@", "@1.2", "pkg; python_version>'3'", "pkg @ https://x/y.whl", "git+https://x/y",
  "git+ssh://git@github.com/x/y", "https://x/y-1.0-py3-none-any.whl", "./x", "../x", "/abs/x.whl", "x.tar.gz", "foo.zip", "x.exe", "server.cmd", "python", ".", "..",
];

/** Words of a command line: npx's flags, package specs, cmd's switches, and the characters cmd reads. */
const word = fc.oneof(
  { weight: 3, arbitrary: anyText(12) },
  { weight: 3, arbitrary: fc.constantFrom("npx", "NPX", "npx.cmd", "C:\\nodejs\\npx.cmd", "-y", "--yes", "-q", "-p", "--package=x", "-c", "--", "@acme/notes-mcp", "@acme/notes-mcp@1.2.3", "@scope", "pkg@", "./x", ".\\x", "C:\\x", "x.tgz", "~/x") },
  { weight: 3, arbitrary: fc.constantFrom(...UV_WORDS) },
  { weight: 2, arbitrary: fc.constantFrom("/c", "/C", "/d", "/s", "/D", "/q", "/k", "/c npx", "npx&calc", "a b", "a\tb", "", "%PATH%", "!x!", "^", "(", ")", '"', "<", ">", "|", "&", "\u00a0", "\u3000", ",", ";", "=") },
);

/**
 * What every PyPI spec must hold, whatever line it was read from: a requirement and --with values of
 * the PyPI subset, never a path, a URL or a flag; a project that is the requirement's name in normal
 * form; a command that is a plain file name; a Python the cage has; the server's own arguments at the
 * end of the line uv's `tool run` reads.
 */
function expectPypi(spec: PypiLaunch, argv: string[], platform: NodeJS.Platform): void {
  const line = toolRunArgs(argv, platform)!;
  expect(line).toBeDefined();
  expect(line.slice(line.length - spec.args.length)).toEqual(spec.args);
  const parsed = pypiRequirement(spec.requirement);
  expect(parsed, spec.requirement).toBeDefined();
  expect(spec.project).toBe(parsed!.name.toLowerCase().replace(/[-_.]+/g, "-"));
  for (const requirement of [spec.requirement, ...spec.with]) {
    expect(pypiRequirement(requirement), requirement).toBeDefined();
    expect(requirement, requirement).not.toMatch(/^[\s]*-|[/\\@;]|:\/\/|\.(?:whl|zip|tgz|tar)$/i);
  }
  expect(spec.command).not.toBe("");
  expect(spec.command).not.toMatch(/^-|[/\\\u0000-\u001f\u007f]|^\.\.?$/);
  // A command after --from, written for Windows, is never one of its own programs or scripts. Without
  // --from the command is the package's name as written, which uvx reads as a name even with .exe.
  if (platform === "win32" && spec.command !== parsed!.name) expect(spec.command).not.toMatch(/\.(?:exe|cmd|bat|ps1)$/i);
  if (spec.python !== undefined) expect(spec.python).toMatch(/^3\.1[0-5](?:\.[0-9]+)?$/);
  if (spec.resolution.prerelease !== undefined) expect(["disallow", "allow", "if-necessary", "explicit", "if-necessary-or-explicit"]).toContain(spec.resolution.prerelease);
  // Nothing a terminal or uv's stdin would read as more than one line or as a control: and the resolve,
  // which checks the requirements again before it writes them on uv's stdin, takes the spec.
  for (const text of [spec.requirement, ...spec.with, spec.command]) expect(text, JSON.stringify(text)).not.toMatch(/[\u0000-\u001f\u007f]/);
  for (const line of resolvedInput(spec)) expect(line, JSON.stringify(line)).not.toMatch(/[\u0000-\u001f\u007f]/);
}

/**
 * The lines the resolve of `spec` writes on uv's stdin, with a runner that answers as uv does: its
 * version 1.0, then a lock that pins it. resolvePypi throws when it refuses a requirement of the spec.
 */
function resolvedInput(spec: PypiLaunch): string[] {
  const input: string[] = [];
  const runner: DockerRunner = (args, options) => {
    if (args[0] === "image") return { status: 0, stdout: "sha256:resolve\n", stderr: "" };
    input.push(...(options?.input ?? "").split("\n").filter((line) => line !== ""));
    const lock = args.includes("--generate-hashes") ? ` \\\n    --hash=sha256:${"0".repeat(64)}` : "";
    return { status: 0, stdout: `${spec.project}==1.0${lock}\n`, stderr: "" };
  };
  resolvePypi(spec, { log: () => {}, runner, platform: "aarch64-manylinux_2_28" });
  return input;
}

/** The words after /c: half of them start with npx or uvx, which any word may follow. */
const cmdLine = fc.oneof(
  fc.array(word, { minLength: 0, maxLength: 5 }),
  fc
    .tuple(fc.constantFrom("npx", "NPX", "npx.cmd", "C:\\nodejs\\npx.cmd", "uvx", "UVX.EXE", "uvx.exe", "C:\\Users\\me\\.local\\bin\\uvx.exe"), fc.array(word, { minLength: 0, maxLength: 4 }))
    .map(([runner, rest]) => [runner, ...rest]),
);

const CMD = fc.constantFrom("cmd", "cmd.exe", "CMD.EXE", "C:\\Windows\\System32\\cmd.exe", "c:/windows/system32/cmd.exe", ".\\cmd.exe", "cmd.com", "xcmd");

/** What cmd reads itself in the line after /c (see CMD_READS in launch.ts), and what ends its line. */
const CMD_SPECIAL = /[&|<>^%!"()\u0000-\u001f\u007f]/;

/** `word` in any mix of ASCII upper and lower case. */
const anyCase = (word: string) => fc.tuple(...[...word].map((character) => fc.constantFrom(character.toLowerCase(), character.toUpperCase()))).map((characters) => characters.join(""));

/** What uvx says of a word it reads as a Python interpreter to start (see INTERPRETER in launch.ts). */
const INTERPRETER = "uvx reads it as a Python interpreter to start (python, python3.13, python@3.12, cpython, pypy, graalpy, pyodide), not as a PyPI package, and the cage starts PyPI packages only";

/**
 * What uv 0.13.7 reads after an interpreter's name as a version request (see pythonVersionRequest in
 * launch.ts): nothing, @ and anything, a version of one to three parts of 0 to 255 (a pre-release
 * with two parts at least), a variant right after its last digit, or version specifiers. A variant
 * after a letter is not one: uv 0.13.7 looked for the package python3-13at for python3.13at, and
 * started an interpreter for python3.13rc2t.
 */
const versionRequest = fc.oneof(
  fc.constant(""),
  anyText(8).map((text) => `@${text}`),
  fc
    .tuple(
      fc.constantFrom("", "v"),
      fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 3 }),
      fc.constantFrom("", "a1", "b0", "rc2", "c3", "alpha3", "beta1", "pre1", "preview2", "a", "beta", "rc", "c"),
      fc.constantFrom("", "t", "+debug", "d", "td", "freethreaded", "+freethreaded", "gil", "gil+debug", "freethreaded+debug"),
    )
    .map(([v, parts, pre, variant]) => {
      const release = `${v}${parts.join(".")}${parts.length >= 2 ? pre : ""}`;
      return /[0-9]$/.test(release) ? `${release}${variant}` : release;
    }),
  fc
    .array(fc.tuple(fc.constantFrom("", " "), fc.constantFrom(">=", "<=", "==", "!=", "~=", ">", "<"), fc.constantFrom("3.12", "3.13", "3.10.4", "3")), { minLength: 1, maxLength: 3 })
    .map((specifiers) => specifiers.map(([gap, operator, version]) => `${gap}${operator}${operator === "~=" && version === "3" ? "3.1" : version}`).join(",")),
);

describe("command lines, fuzzed", () => {
  it(
    "are read as npx, a container image or a host command, or refused with a plain error",
    () => {
      check(
        fc.property(fc.array(word, { minLength: 0, maxLength: 6 }), fc.constantFrom<NodeJS.Platform>("darwin", "linux", "win32"), (argv, platform) => {
          let spec;
          try {
            spec = parseLaunch(argv, undefined, platform);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).constructor).toBe(Error);
            return;
          }
          if (spec.kind === "npm") {
            const line = npxArgv(argv, platform)!;
            expect(line).toBeDefined();
            // The server's own arguments end the npx line, and its package is named or local.
            expect(line.slice(line.length - spec.args.length)).toEqual(spec.args);
            expect(spec.packageName !== "" || spec.localPath !== undefined).toBe(true);
            if (spec.packageName !== "") expect(splitPackageSpec(spec.packageName).name).toBe(spec.packageName);
          } else if (spec.kind === "pypi") {
            expectPypi(spec, argv, platform);
          } else {
            expect(spec).toEqual({ kind: "host", command: argv[0], args: argv.slice(1) });
            expect(toolRunArgs(argv, platform)).toBeUndefined();
          }
          expect(serverIdFor(spec)).toMatch(/^[a-z0-9-]{1,40}-[0-9a-f]{8}$/);
        }),
        2000,
      );
    },
    TIMEOUT,
  );

  it(
    "read a uvx or uv tool run line into a PyPI spec the cage can build, or refuse it with a plain error",
    () => {
      let read = 0;
      check(
        fc.property(
          fc.constantFrom(["uvx"], ["UVX.EXE"], ["C:\\Users\\me\\.local\\bin\\uvx.exe"], ["/usr/local/bin/uvx"], ["uv", "tool", "run"], ["uv.exe", "tool", "run"]),
          fc.array(fc.oneof({ weight: 1, arbitrary: anyText(10) }, { weight: 4, arbitrary: fc.constantFrom(...UV_WORDS) }), { maxLength: 7 }),
          fc.constantFrom<NodeJS.Platform>("darwin", "linux", "win32"),
          (start, words, platform) => {
            const argv = [...start, ...words];
            let spec;
            try {
              spec = parseLaunch(argv, undefined, platform);
            } catch (error) {
              expect((error as Error).constructor).toBe(Error);
              // A refusal names a flag, never its value: neither the password of an index URL nor a token.
              expect((error as Error).message).not.toMatch(/u:p@|https:\/\/x/);
              return;
            }
            if (spec.kind === "host") {
              // Only a name that Windows and macOS alone read without case, read on Linux.
              expect(platform === "linux" && /[A-Z]/.test(start[0]!)).toBe(true);
              return;
            }
            expect(spec.kind).toBe("pypi");
            read++;
            expectPypi(spec as PypiLaunch, argv, platform);
            expect(serverIdFor(spec)).toMatch(/^[a-z0-9-]{1,40}-[0-9a-f]{8}$/);
          },
        ),
        2000,
      );
      // Not an empty property: many lines are read.
      expect(read).toBeGreaterThan(100);
    },
    TIMEOUT,
  );

  it(
    "take a requirement only when it is a name, extras and versions",
    () => {
      const piece = fc.oneof(anyText(6), fc.constantFrom("pkg", "Pkg_1.x", "[", "]", "x", ",", " ", "==", "!=", "<=", ">=", "<", ">", "~=", "===", "1.0", "1.*", "v2", "+local", "rc1", ".post1", ".dev0", "@", ";", "(", ")", "://", "/", "\\", ".whl", ".tar.gz", "-", "_", "."));
      check(
        fc.property(fc.array(piece, { maxLength: 8 }), (pieces) => {
          const text = pieces.join("");
          const parsed = pypiRequirement(text);
          if (parsed === undefined) return;
          expect(parsed.name).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
          expect(text).not.toMatch(/[@;()/\\]|:\/\//);
          expect(text).toMatch(/^[ \t]*[A-Za-z0-9]/);
          for (const specifier of parsed.specifiers) expect(specifier).toMatch(/^(?:===|==|!=|<=|>=|~=|<|>)v?[0-9]/i);
        }),
        2000,
      );
    },
    TIMEOUT,
  );

  it(
    "take a cmd /c line for plain npx or uvx only when cmd would hand it exactly its words",
    () => {
      check(
        fc.property(CMD, fc.array(fc.constantFrom("/d", "/s", "/D", "/S", "/q", "/k"), { maxLength: 2 }), fc.constantFrom("/c", "/C", "/k"), cmdLine, (cmd, switches, c, line) => {
          const argv = [cmd, ...switches, c, ...line];
          const read = cmdRunner(argv, "win32");
          expect(cmdRunner(argv, "darwin")).toBeUndefined();
          const type = serverType({ command: cmd, args: argv.slice(1) }, "win32");
          if (read === undefined || !("line" in read)) {
            expect(type).not.toBe("npx");
            expect(type).not.toBe("uvx");
            return;
          }
          expect(read.line).toEqual(line);
          expect((read.runner === "npx" ? isNpx : isUvx)(line[0]!, "win32")).toBe(true);
          expect(/^\/c$/i.test(c)).toBe(true);
          expect(switches.every((option) => /^\/[ds]$/i.test(option))).toBe(true);
          for (const part of line) {
            expect(part).not.toBe("");
            expect(part, JSON.stringify(part)).not.toMatch(CMD_SPECIAL);
          }
          // The program cmd starts is the first word whole: nothing in it ends a program's name for cmd.
          expect(line[0]).not.toMatch(/[\s,;=]/);
          expect(type).toBe(read.runner);
          if (read.runner === "uvx") expect(toolRunArgs(argv, "win32")).toEqual(line.slice(1));
          else expect(npxArgv(argv, "win32")).toEqual(line);
        }),
        2000,
      );
    },
    TIMEOUT,
  );
  it(
    "refuse a package or --from that uvx reads as a Python interpreter, in any case and spelling",
    () => {
      check(
        fc.property(
          fc.constantFrom<NodeJS.Platform>("darwin", "linux", "win32"),
          fc.constantFrom("python", "cpython", "pypy", "graalpy", "pyodide", "pythonw").chain((name) => anyCase(name).map((spelled) => ({ name, spelled }))),
          versionRequest,
          fc.constantFrom(["uvx"], ["uv", "tool", "run"], ["uv", "tool", "uvx"], ["/usr/local/bin/uvx"], ["cmd", "/c", "uvx"]),
          fc.constantFrom([], ["--offline"], ["-q"], ["--with", "mcp"], ["-p", "3.12"], ["--python=3.13"], ["--isolated", "--refresh"], ["--prerelease", "allow"]),
          fc.boolean(),
          (platform, { name, spelled }, version, start, flags, viaFrom) => {
            // pythonw is one on Windows only.
            fc.pre(name !== "pythonw" || platform === "win32");
            const word = `${spelled}${version}`;
            // cmd /c is read on Windows only, and as uvx only when cmd would hand uvx the words as they are.
            fc.pre(start[0] !== "cmd" || (platform === "win32" && !CMD_SPECIAL.test(word) && !/[\s,;=]/.test(word)));
            const argv = viaFrom ? [...start, ...flags, "--from", word, "server"] : [...start, ...flags, word, "server.py"];
            expect(() => parseLaunch(argv, undefined, platform), JSON.stringify(argv)).toThrow(new Error(`uvx ${viaFrom ? "--from" : "<package>"}: ${INTERPRETER}`));
          },
        ),
        1000,
      );
    },
    TIMEOUT,
  );
  it(
    "read uvx, uv and npx in any case on macOS and Windows, whose file systems compare names without case, and in lowercase only on Linux",
    () => {
      check(
        fc.property(
          fc.constantFrom("uvx", "uvx.exe", "uv", "uv.exe", "npx", "npx.cmd").chain((name) => anyCase(name).map((spelled) => ({ name, spelled }))),
          fc.constantFrom("", "/usr/local/bin/", "/Users/me/.local/bin/", "C:\\Users\\me\\.local\\bin\\"),
          fc.constantFrom("run", "uvx"),
          fc.constantFrom<NodeJS.Platform>("darwin", "linux", "win32"),
          ({ name, spelled }, dir, sub, platform) => {
            const command = `${dir}${spelled}`;
            const argv = name.startsWith("npx") ? [command, "-y", "@acme/notes-mcp"] : name.startsWith("uvx") ? [command, "mcp-server-time"] : [command, "tool", sub, "mcp-server-time"];
            const kind = name.startsWith("npx") ? "npm" : "pypi";
            const read = spelled === name || platform !== "linux";
            expect(parseLaunch(argv, undefined, platform).kind, JSON.stringify(argv)).toBe(read ? kind : "host");
            expect(serverType({ command, args: argv.slice(1) }, platform)).toBe(read ? (kind === "npm" ? "npx" : "uvx") : "other");
            if (name.startsWith("uvx")) expect(isUvx(command, platform)).toBe(read);
            if (name.startsWith("npx")) expect(isNpx(command, platform)).toBe(read);
          },
        ),
        1000,
      );
    },
    TIMEOUT,
  );
});
