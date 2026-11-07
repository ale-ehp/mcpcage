import { describe, expect, it } from "vitest";
import { serverType } from "../src/config.js";
import { cmdNpx, cmdRunner, imageRepository, isLocalPath, npxArgv, parseLaunch, pypiRequirement, serverIdFor, splitPackageSpec, startsUv, toolRunArgs, type LaunchSpec, type PypiLaunch } from "../src/launch.js";

/** `run` with the host's time zone set to `zone`, as TZ sets it for node and for uv. */
function inZone<T>(zone: string, run: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe("the server id", () => {
  it("stays the same from one version of mcpcage to the next, for each kind of server", () => {
    // The pins and the audit log of a server are kept under its id: an id computed another way is a
    // server never seen, whose tools are trusted again on first use and whose approvals are lost.
    const ids: Array<[LaunchSpec, string]> = [
      [parseLaunch(["npx", "-y", "@modelcontextprotocol/server-filesystem@2025.1.1", "/data"], undefined, "linux"), "modelcontextprotocol-server-filesystem-6c1aef84"],
      [parseLaunch(["npx", "./servers/notes/", "--dir", "/x"], undefined, "linux"), "notes-a39057e4"],
      [parseLaunch(["npx", "/opt/acme/notes-1.0.0.tgz"], undefined, "linux"), "notes-1-0-0-68710a1b"],
      [parseLaunch(["npx", "-y", "My__Server.TGZ.helper"], undefined, "linux"), "my-server-tgz-helper-b59d1698"],
      [parseLaunch(["npx", "-y", "an-mcp-server-whose-package-name-is-longer-than-forty-characters"], undefined, "linux"), "an-mcp-server-whose-package-name-is-long-23628b55"],
      [{ kind: "image", image: "docker.io/mcp/time:latest@sha256:abc", args: ["--tz", "UTC"] }, "docker-io-mcp-time-ffe1066f"],
      [{ kind: "host", command: "/usr/local/bin/uvx", args: ["mcp-server-time"] }, "uvx-82cf2188"],
      [{ kind: "npm", packageName: "", args: [] }, "local-0e7dc29e"],
      // A PyPI server by its project, whatever the command after --from.
      [parseLaunch(["uvx", "mcp-server-time"], undefined, "linux"), "mcp-server-time-8ede74b2"],
      [parseLaunch(["uvx", "--from", "awslabs.aws-api-mcp-server", "aws-api-server", "--x"], undefined, "linux"), "awslabs-aws-api-mcp-server-a1b12344"],
    ];
    for (const [spec, id] of ids) expect(serverIdFor(spec), JSON.stringify(spec)).toBe(id);
  });

  it("tells apart images and host commands by what they run", () => {
    const image = (name: string): LaunchSpec => ({ kind: "image", image: name, args: [] });
    const host = (command: string): LaunchSpec => ({ kind: "host", command, args: [] });
    expect(serverIdFor(image("mcp/time:1"))).toBe(serverIdFor(image("mcp/time:2")));
    expect(serverIdFor(image("mcp/time"))).not.toBe(serverIdFor(image("mcp/fetch")));
    expect(serverIdFor(host("/usr/bin/uvx"))).not.toBe(serverIdFor(host("/opt/bin/uvx")));
  });

  it("knows an image by its repository: without its tag or digest, a registry's port kept", () => {
    expect(imageRepository("time")).toBe("time");
    expect(imageRepository("mcp/time:1@sha256:abc")).toBe("mcp/time");
    expect(imageRepository("localhost:5000/mcp/time")).toBe("localhost:5000/mcp/time");
    expect(imageRepository("localhost:5000/mcp/time:2")).toBe("localhost:5000/mcp/time");
  });
});

describe("the command line after --", () => {
  it("takes the npx flags that only set npm's log level or say yes", () => {
    expect(parseLaunch(["npx", "-y", "--yes", "-q", "--quiet", "-s", "--silent", "--no-install=false", "notes"], undefined, "linux")).toEqual({ kind: "npm", packageName: "notes", versionRange: undefined, args: [] });
  });

  it("says what is missing or not supported, by name", () => {
    expect(() => parseLaunch([])).toThrow(/^missing the server command after `--`$/);
    expect(() => parseLaunch(["npx", "-y"])).toThrow(/^npx needs a package name$/);
    for (const flag of ["-p", "--package", "--package=@acme/notes", "-c", "--call"]) {
      expect(() => parseLaunch(["npx", flag, "x", "notes"])).toThrow(`npx ${flag} is not supported yet; use \`npx <package> [args]\``);
    }
  });

  it("is npx only when its command is a string", () => {
    // A configuration file is not type-checked: a list ["npx"] reads as "npx" once made a string.
    expect(npxArgv([["npx"], "-y", "notes"], "linux")).toBeUndefined();
    expect(npxArgv([42, "-y", "notes"], "win32")).toBeUndefined();
    expect(cmdNpx([42, "/c", "npx", "-y", "notes"], "win32")).toBeUndefined();
  });

  it("takes a package path on disk for one, and only a path", () => {
    expect(isLocalPath("../server", "linux")).toBe(true);
    expect(isLocalPath("..\\server", "win32")).toBe(true);
    // A name with ".\" or "c:/" inside it is not a path.
    expect(isLocalPath("x.\\y", "win32")).toBe(false);
    expect(isLocalPath("abc:/x", "win32")).toBe(false);
    expect(splitPackageSpec("notes@1.2.3")).toEqual({ name: "notes", range: "1.2.3" });
  });
});

describe("cmd /c npx on Windows", () => {
  const npx = ["npx", "-y", "@acme/notes"];

  it("is cmd or cmd.exe itself, not a program whose name holds it", () => {
    expect(cmdNpx(["C:\\Windows\\System32\\cmd.exe", "/c", ...npx], "win32")).toEqual({ npx });
    expect(cmdNpx(["C:\\tools\\mycmd.exe", "/c", ...npx], "win32")).toBeUndefined();
    expect(cmdNpx(["cmdx", "/c", ...npx], "win32")).toBeUndefined();
  });

  it("needs /c itself as its last switch, after /d and /s at most", () => {
    expect(cmdNpx(["cmd", "/d", "/s", "/C", ...npx], "win32")).toEqual({ npx });
    // A switch that only ends in /c, or starts with it, is another one.
    expect(cmdNpx(["cmd", "/q/c", ...npx], "win32")).toBeUndefined();
    expect(cmdNpx(["cmd", "/cx", ...npx], "win32")).toBeUndefined();
    for (const option of ["/q/d", "/dx"]) {
      expect(cmdNpx(["cmd", option, "/c", ...npx], "win32")).toEqual({ notPlain: "it gives cmd a switch other than /d and /s before /c" });
    }
    // Words that all start with / are all switches: there is no command line after /c.
    expect(cmdNpx(["cmd", "/c", "/nodejs/npx"], "win32")).toBeUndefined();
  });
});

describe("cmd /c uvx on Windows", () => {
  it("is read as the uvx line after /c, with the same spec and id, as mcp-for-blender's README configures it", () => {
    const plain = [
      ["cmd", "/c", "uvx", "mcp-for-blender"],
      ["CMD.EXE", "/D", "/S", "/C", "UVX.EXE", "mcp-for-blender"],
      ["C:\\Windows\\System32\\cmd.exe", "/c", "C:\\Users\\me\\.local\\bin\\uvx.exe", "mcp-for-blender"],
    ];
    for (const argv of plain) {
      const line = argv.slice(argv.findIndex((word) => /uvx/i.test(word)));
      expect(cmdRunner(argv, "win32")).toEqual({ runner: "uvx", line });
      expect(parseLaunch(argv, undefined, "win32")).toEqual(parseLaunch(line, undefined, "win32"));
      expect(parseLaunch(argv, undefined, "win32")).toMatchObject({ kind: "pypi", project: "mcp-for-blender", command: "mcp-for-blender" });
      expect([serverType({ command: argv[0]!, args: argv.slice(1) }, "win32"), serverType({ command: argv[0]!, args: argv.slice(1) }, "darwin")]).toEqual(["uvx", "other"]);
      // Only npx lines are npx's.
      expect(cmdNpx(argv, "win32")).toBeUndefined();
      expect(npxArgv(argv, "win32")).toBeUndefined();
      expect(cmdRunner(argv, "linux")).toBeUndefined();
    }
    // The uvx rules apply to the line after /c, a refused flag included.
    const aws = ["cmd", "/c", "uvx", "--from", "awslabs.aws-api-mcp-server@latest", "awslabs.aws-api-mcp-server.exe"];
    expect(parseLaunch(aws, undefined, "win32")).toMatchObject({ kind: "pypi", requirement: "awslabs.aws-api-mcp-server", command: "awslabs.aws-api-mcp-server" });
    expect(() => parseLaunch(["cmd", "/c", "uvx", "--index-url", "x", "mcp-for-blender"], undefined, "win32")).toThrow(/^uvx --index-url: installs from another index than PyPI/);
    expect(cmdRunner(["cmd", "/c", "npx", "-y", "x"], "win32")).toEqual({ runner: "npx", line: ["npx", "-y", "x"] });
  });

  it("says why a line that runs more than uvx is not plain, with the reasons of cmd /c npx, and leaves it a host command", () => {
    const blender = ["mcp-for-blender"];
    const notPlain: Array<[string[], string]> = [
      [["/c", "uvx", ...blender, "&", "calc"], "an argument after /c has & or |, with which cmd starts another command"],
      [["/c", "uvx", ...blender, ">", "out.txt"], "an argument after /c has < or >, with which cmd redirects what uvx reads or writes"],
      [["/c", "uvx", ...blender, "--token=%TOKEN%"], "an argument after /c has %, between two of which cmd fills in a variable"],
      [["/c", "uvx", ...blender, '"x"'], "an argument after /c has quotes, which cmd reads by rules of its own"],
      [["/c", "uvx", ...blender, ""], "an argument after /c is empty, which the client can give cmd only in quotes"],
      [["/q", "/c", "uvx", ...blender], "it gives cmd a switch other than /d and /s before /c"],
      [["/c", "uvx mcp-for-blender"], "it gives uvx and what follows in one argument, which cmd splits by rules of its own"],
      [["/c", "C:\\Users\\My Name\\.local\\bin\\uvx.exe", ...blender], "the path of uvx has a space, so the client quotes it, and cmd removes quotes there by rules of its own"],
    ];
    for (const [args, why] of notPlain) {
      expect(cmdRunner(["cmd", ...args], "win32"), JSON.stringify(args)).toEqual({ runner: "uvx", notPlain: why });
      expect(parseLaunch(["cmd", ...args], undefined, "win32")).toEqual({ kind: "host", command: "cmd", args });
      expect(serverType({ command: "cmd", args }, "win32")).toBe("other");
    }
    // An argument is never quoted in the reason: it may hold a credential.
    expect(JSON.stringify(cmdRunner(["cmd", "/c", "uvx", ...blender, "--token=%TOKEN%"], "win32"))).not.toContain("TOKEN");
  });
});

describe("uvx command lines", () => {
  // What each refusal says, as the parser words it: kept here in full, so that a change shows.
  const OUTSIDE = "builds or installs code from outside PyPI, and the cage installs PyPI wheels only";
  const INDEX = "installs from another index than PyPI, and the cage builds from PyPI only";
  const FILE = "reads a file on your machine, which the cage does not read when it builds";
  const SOURCE = "builds from source or for another platform, and the cage installs PyPI wheels for its own";
  const INSECURE = "turns off certificate checks for a host, which only another index or a proxy needs";
  const NOT_REQUIREMENT = "not a PyPI requirement: give a name, optional [extras] and versions (==, !=, <=, >=, <, >, ~=, ===)";
  const PYTHON = "the cage runs CPython 3.10 to 3.15: give a version such as 3.12 or 3.12.4";
  const AT = "after @, uvx takes only an exact version or latest, and reads anything else as a path or URL (for a range, write pkg>=1.2)";

  /** mcp-server-time as `uvx mcp-server-time` gives it, with `changes`. */
  const time = (changes: object = {}) => ({ kind: "pypi", project: "mcp-server-time", requirement: "mcp-server-time", command: "mcp-server-time", with: [], resolution: {}, args: [], ...changes });
  const uvx = (...words: string[]) => parseLaunch(["uvx", ...words], undefined, "linux");

  it("reads the forms PyPI servers' READMEs configure, as uv 0.13.7 reads them", () => {
    const forms: Array<[string[], object]> = [
      [["mcp-server-time"], time()],
      [["mcp-server-time", "--local-timezone", "UTC"], time({ args: ["--local-timezone", "UTC"] })],
      // @ and an exact version is ==, @latest no version at all (https://docs.astral.sh/uv/guides/tools/#requesting-specific-versions).
      [["mcp-server-time@2026.1.26"], time({ requirement: "mcp-server-time==2026.1.26" })],
      [["mcp-server-time@v2026.1.26"], time({ requirement: "mcp-server-time==v2026.1.26" })],
      [["mcp-server-time@1.0rc1"], time({ requirement: "mcp-server-time==1.0rc1" })],
      [["mcp-server-time@1!1.0+local.7"], time({ requirement: "mcp-server-time==1!1.0+local.7" })],
      [["mcp-server-time@latest"], time()],
      [["mcp-server-time==2026.1.26"], time({ requirement: "mcp-server-time==2026.1.26" })],
      [["mcp-server-time>=2026,<2027,!=2026.5.*"], time({ requirement: "mcp-server-time>=2026,<2027,!=2026.5.*" })],
      [["mcp-server-time ~= 2026.1 , === 2026.1.26"], time({ requirement: "mcp-server-time ~= 2026.1 , === 2026.1.26" })],
      [["mcp-server-time[x]"], time({ requirement: "mcp-server-time[x]" })],
      [["mcp-server-time [ x , y ]"], time({ requirement: "mcp-server-time [ x , y ]" })],
      [["mcp-server-time[]"], time({ requirement: "mcp-server-time[]" })],
      [["mcp-server-time[a,b]@2026.1.26"], time({ requirement: "mcp-server-time[a,b]==2026.1.26" })],
      [["mcp-server-time[x]@latest"], time({ requirement: "mcp-server-time[x]" })],
      // The command is the name as written, the project its PEP 503 normal form.
      [["awslabs.aws-documentation-mcp-server@latest"], { kind: "pypi", project: "awslabs-aws-documentation-mcp-server", requirement: "awslabs.aws-documentation-mcp-server", command: "awslabs.aws-documentation-mcp-server", with: [], resolution: {}, args: [] }],
      [["Mcp_Server..Time"], time({ requirement: "Mcp_Server..Time", command: "Mcp_Server..Time" })],
      [["--from", "mcpforunityserver", "mcp-for-unity"], { kind: "pypi", project: "mcpforunityserver", requirement: "mcpforunityserver", command: "mcp-for-unity", with: [], resolution: {}, args: [] }],
      [["--from=mcp-server-time@2026.1.26", "python", "-m", "mcp_server_time"], time({ requirement: "mcp-server-time==2026.1.26", command: "python", args: ["-m", "mcp_server_time"] })],
      [["--from", "mcp-server-time[x]@latest", "--", "mcp-server-time"], time({ requirement: "mcp-server-time[x]" })],
      // On macOS and Linux .exe is part of the name.
      [["--from", "mcp-server-time", "mcp-server-time.exe"], time({ command: "mcp-server-time.exe" })],
      [["--from", "mcp-server-time", "server.cmd"], time({ command: "server.cmd" })],
      // Everything after the package is the server's, flags and -- included.
      [["--", "mcp-server-time", "--", "--with", "x", "-q"], time({ args: ["--", "--with", "x", "-q"] })],
      [["--with", "duckduckgo-mcp-server[browser]", "duckduckgo-mcp-server"], { kind: "pypi", project: "duckduckgo-mcp-server", requirement: "duckduckgo-mcp-server", command: "duckduckgo-mcp-server", with: ["duckduckgo-mcp-server[browser]"], resolution: {}, args: [] }],
      // uv splits --with at a comma unless a version operator follows it.
      [["--with=a,b>=1,<2", "-w", "c, d [x,y]", "-we", "-w=f", "-qwg", "--with", "", "mcp-server-time"], time({ with: ["a", "b>=1,<2", "c", "d [x,y]", "e", "f", "g"] })],
      [["--python", "3.11", "--refresh-package", "arxiv-mcp-server", "mcp-server-time"], time({ python: "3.11" })],
      [["-p", "3.12.4", "mcp-server-time"], time({ python: "3.12.4" })],
      [["--python=3.15", "mcp-server-time"], time({ python: "3.15" })],
      [["-p3.10", "mcp-server-time"], time({ python: "3.10" })],
      [["-p=3.13", "mcp-server-time"], time({ python: "3.13" })],
      [["--prerelease", "allow", "--exclude-newer", "2026-10-01T00:00:00Z", "mcp-server-time"], time({ resolution: { prerelease: "allow", excludeNewer: "2026-10-01T00:00:00Z" } })],
      [["--prerelease=if-necessary-or-explicit", "--exclude-newer=P30D", "mcp-server-time"], time({ resolution: { prerelease: "if-necessary-or-explicit", excludeNewer: "P30D" } })],
    ];
    for (const [words, spec] of forms) expect(uvx(...words), JSON.stringify(words)).toEqual(spec);
  });

  it("takes the flags that only tune uv's cache, output or interpreter lookup on the host, which do nothing in the cage", () => {
    const flags = [
      "--no-build", "--no-config", "--isolated", "--refresh", "--refresh-package", "x", "--refresh-package=y", "-n", "--no-cache",
      "--cache-dir", "/tmp/c", "--cache-dir=/tmp/d", "--offline", "--managed-python", "--no-managed-python", "--no-python-downloads",
      "--system-certs", "-q", "-qq", "-v", "-vvv", "--quiet", "--verbose", "--no-progress", "--color", "never", "--color=auto", "-qn",
    ];
    expect(uvx(...flags, "mcp-server-time", "a")).toEqual(time({ args: ["a"] }));
    expect(() => uvx("--color", "red", "mcp-server-time")).toThrow(/^uvx --color: give auto, always or never$/);
    // uv 0.13.7 takes these too (`uv tool run --help`, and a run of each): they tune how uv installs
    // into its cache on the host, which the cage's build does on its own (bytecode with -I -S).
    const installer = ["--no-env-file", "--compile-bytecode", "--reinstall", "--reinstall-package", "idna", "--reinstall-package=x", "--link-mode", "copy", "--link-mode=hardlink"];
    expect(uvx(...installer, "mcp-server-time", "a")).toEqual(time({ args: ["a"] }));
    for (const mode of ["clone", "copy", "hardlink", "symlink"]) expect(uvx("--link-mode", mode, "mcp-server-time")).toEqual(time());
    expect(() => uvx("--link-mode", "weird", "mcp-server-time")).toThrow(/^uvx --link-mode: give clone, copy, hardlink or symlink$/);
    expect(() => uvx("--reinstall-package", "--offline", "mcp-server-time")).toThrow(/^uvx --reinstall-package needs a value$/);
    expect(() => uvx("--compile-bytecode=1", "mcp-server-time")).toThrow(/^uvx --compile-bytecode takes no value$/);
    expect(() => uvx("--offline=true", "mcp-server-time")).toThrow(/^uvx --offline takes no value$/);
  });

  it("refuses every flag that brings code from elsewhere, another index, a file on the machine or a build from source, saying why", () => {
    const refused: Array<[string[], string]> = [
      [["--with-editable", "./x"], `uvx --with-editable: ${OUTSIDE}`],
      [["--with-requirements", "requirements.txt"], `uvx --with-requirements: ${OUTSIDE}`],
      ...["--index", "--default-index", "--index-url", "--extra-index-url", "--find-links", "--index-strategy", "--keyring-provider", "--torch-backend"].map((flag): [string[], string] => [[flag, "x"], `uvx ${flag}: ${INDEX}`]),
      [["-i", "x"], `uvx -i: ${INDEX}`],
      [["-f", "x"], `uvx -f: ${INDEX}`],
      [["--no-index"], `uvx --no-index: ${INDEX}`],
      ...["--constraints", "--overrides", "--build-constraints", "--config-file", "--env-file", "--directory", "--project"].map((flag): [string[], string] => [[flag, "x"], `uvx ${flag}: ${FILE}`]),
      [["-c", "x"], `uvx -c: ${FILE}`],
      [["-b", "x"], `uvx -b: ${FILE}`],
      ...["--no-binary-package", "--config-setting", "--config-settings-package", "--no-build-isolation-package", "--python-platform"].map((flag): [string[], string] => [[flag, "x"], `uvx ${flag}: ${SOURCE}`]),
      [["-C", "x=y"], `uvx -C: ${SOURCE}`],
      [["--no-binary"], `uvx --no-binary: ${SOURCE}`],
      [["--no-build-isolation"], `uvx --no-build-isolation: ${SOURCE}`],
      [["--lfs"], `uvx --lfs: ${SOURCE}`],
      [["--allow-insecure-host", "x"], `uvx --allow-insecure-host: ${INSECURE}`],
      // Any other: what uv would do with it is not something the cage reproduces.
      ...["--upgrade", "--upgrade-package", "--no-sources", "--resolution", "--help", "--bogus"].map((flag): [string[], string] => [[flag, "x"], `unsupported uvx flag ${flag}`]),
      [["-U"], "unsupported uvx flag -U"],
      [["-h"], "unsupported uvx flag -h"],
      [["-qx"], "unsupported uvx flag -x"],
    ];
    for (const [words, message] of refused) {
      expect(() => uvx(...words, "mcp-server-time"), JSON.stringify(words)).toThrow(new Error(message));
      expect(() => parseLaunch(["uv", "tool", "run", ...words, "mcp-server-time"], undefined, "linux"), JSON.stringify(words)).toThrow(new Error(message));
    }
  });

  it("names a refused flag without its value, which can hold a credential", () => {
    for (const words of [["--index-url=https://user:s3cret@pypi.example/simple"], ["-ihttps://user:s3cret@pypi.example/simple"], ["-i=https://user:s3cret@pypi.example/simple"], ["-qfhttps://user:s3cret@x"], ["--token=s3cret"], ["--from", "git+https://s3cret@github.com/x/y", "y"], ["--with", "https://s3cret@x.example/x-1.0-py3-none-any.whl"]]) {
      expect(() => uvx(...words, "mcp-server-time"), JSON.stringify(words)).toThrow();
      try {
        uvx(...words, "mcp-server-time");
      } catch (error) {
        expect((error as Error).message).not.toContain("s3cret");
      }
    }
  });

  it("takes requirements from PyPI only: a name, extras and versions, never a path, a URL or a marker", () => {
    const refused: Array<[string[], string]> = [
      [["--from", "git+https://github.com/x/y", "y"], `uvx --from: ${OUTSIDE}`],
      [["--from", "https://example.com/x-1.0-py3-none-any.whl", "x"], `uvx --from: ${OUTSIDE}`],
      [["--from", "./server", "x"], `uvx --from: ${OUTSIDE}`],
      [["--from", "/abs/x-1.0-py3-none-any.whl", "x"], `uvx --from: ${OUTSIDE}`],
      [["--from", "x @ https://example.com/x.whl", "x"], `uvx --from: ${OUTSIDE}`],
      [["--with", "./dir", "mcp-server-time"], `uvx --with: ${OUTSIDE}`],
      [["--with", "https://example.com/x.whl", "mcp-server-time"], `uvx --with: ${OUTSIDE}`],
      // uv reads @ in --with as a path: `wa@1.0` is /tmp/w/1.0 for it.
      [["--with", "wa@1.0", "mcp-server-time"], `uvx --with: ${OUTSIDE}`],
      [["--with", "a;python_version>'3'", "mcp-server-time"], `uvx --with: ${NOT_REQUIREMENT}`],
      [["./server"], `uvx <package>: ${OUTSIDE}`],
      [["git+https://github.com/x/y"], `uvx <package>: ${OUTSIDE}`],
      [["C:\\work\\server"], `uvx <package>: ${OUTSIDE}`],
      // A name by PEP 508, a file for uv: it reads one that ends as an archive does from disk.
      [["x-1.0-py3-none-any.whl"], `uvx <package>: ${OUTSIDE}`],
      [["foo.tar.gz"], `uvx <package>: ${OUTSIDE}`],
      [["foo.TGZ==1"], `uvx <package>: ${OUTSIDE}`],
      [["--with", "foo.zip", "mcp-server-time"], `uvx --with: ${OUTSIDE}`],
      [["--from", "foo.tar", "x"], `uvx --from: ${OUTSIDE}`],
      [["mcp-server-time@>=1"], `uvx <package>: ${AT}`],
      [["mcp-server-time@LATEST"], `uvx <package>: ${AT}`],
      [["mcp-server-time@1.*"], `uvx <package>: ${AT}`],
      [["mcp-server-time@"], `uvx <package>: ${AT}`],
      [["mcp-server-time@https://example.com/x.whl"], `uvx <package>: ${OUTSIDE}`],
      [["@1.2"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time==1@2"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [['mcp-server-time; python_version > "3"'], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time (==1.0)"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time==1.0,"], `uvx <package>: ${NOT_REQUIREMENT}`],
      // What uv 0.13.7 refuses itself.
      [["mcp-server-time~=1"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time<=1.0+local"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time===abc"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time>=1.*"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time,wa"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["mcp-server-time[a,]"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["--", "-mcp"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [[""], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["--", "-x"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["-"], `uvx <package>: ${NOT_REQUIREMENT}`],
      // uv 0.13.7 reads a tab as a space there, and the resolve refuses every control character before
      // it writes a requirement on uv's stdin: read here, the line started nowhere.
      [["mcp-server-time\t"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["\tmcp-server-time>=1"], `uvx <package>: ${NOT_REQUIREMENT}`],
      [["--from", "mcp-server-time\t==1.0", "x"], `uvx --from: ${NOT_REQUIREMENT}`],
      [["--with", "anyio\t>=4", "mcp-server-time"], `uvx --with: ${NOT_REQUIREMENT}`],
    ];
    for (const [words, message] of refused) expect(() => uvx(...words), JSON.stringify(words)).toThrow(new Error(message));
  });

  it("refuses a package or --from that uvx reads as a Python interpreter to start, as uv 0.13.7 reads it, and keeps the names that only look like one", () => {
    const INTERPRETER = "uvx reads it as a Python interpreter to start (python, python3.13, python@3.12, cpython, pypy, graalpy, pyodide), not as a PyPI package, and the cage starts PyPI packages only";
    // Each started an interpreter in `uv tool run --offline <word>`, or said none was found (pypy...),
    // or refused the version (python@latest, python@foo, python255 read as 2.55): never a package.
    const interpreters = [
      "python", "PYTHON", "Python3", "python3", "python3.13", "python313", "python3.13t", "python3.13+debug", "python3.13gil", "python3.13rc1", "python3.13a",
      "python3.13.0", "python3.255", "python255", "pythonv3.13", "python@3.13", "python@latest", "python@foo", "python>=3.12", "python>=3.12,<3.14", "python ==3.13",
      "python==3.13.*", "cpython", "CPython3.13", "pypy", "pypy3.10", "pypy310", "graalpy", "GraalPy", "pyodide", "Pyodide", "pyodide3.12",
      // Separators around a pre-release and an epoch, each an interpreter for uv 0.13.7 too ("No interpreter found for Python 3.13rc1").
      "python3.13-rc1", "python3.13_rc1", "python3.13.rc1", "python3.13rc-1", "python3.13rc_1", "python10!3.13", "python1!3.13",
    ];
    for (const word of interpreters) {
      expect(() => uvx(word, "server.py"), word).toThrow(new Error(`uvx <package>: ${INTERPRETER}`));
      expect(() => uvx("--from", word, "pip"), word).toThrow(new Error(`uvx --from: ${INTERPRETER}`));
    }
    expect(() => uvx("--with", "mcp", "python3.13", "/srv/server.py")).toThrow(new Error(`uvx <package>: ${INTERPRETER}`));
    // pythonw is one on Windows only, where uv also reads it so.
    for (const word of ["pythonw", "PythonW3.12", "pythonw@3.12"]) expect(() => parseLaunch(["uvx", word], undefined, "win32"), word).toThrow(new Error(`uvx <package>: ${INTERPRETER}`));
    // Each was a package for uv 0.13.7: "Because <name> was not found in the cache".
    const packages: Array<[string, string]> = [
      ["python-dotenv", "python-dotenv"], ["python3-openid", "python3-openid"], ["python3foo", "python3foo"], ["python3rc1", "python3rc1"], ["python3.12.post1", "python3-12-post1"],
      ["python3.13-1", "python3-13-1"], ["python3.13dev", "python3-13dev"], ["python3.13r1", "python3-13r1"], ["python3.256", "python3-256"], ["python3.13.1.1", "python3-13-1-1"],
      ["python3_13", "python3-13"], ["python3.13[x]", "python3-13"], ["cpython-3.13", "cpython-3-13"], ["cp313", "cp313"], ["pp310", "pp310"], ["pythonw", "pythonw"], ["pythonw3.13", "pythonw3-13"],
    ];
    for (const [word, project] of packages) expect(uvx(word), word).toMatchObject({ kind: "pypi", project });
  });

  it("takes a command after --from that is a plain file name", () => {
    const COMMAND = "uvx --from: the command after its package must be a plain file name (no / or \\, no leading -, no control characters, not . or ..)";
    for (const command of ["../bin/x", "bin/x", "a\\b", ".", "..", "-x", "x\u0000", "a\nb", ""]) {
      expect(() => uvx("--from", "mcp-server-time", "--", command), JSON.stringify(command)).toThrow(new Error(COMMAND));
    }
    expect(() => uvx("--from", "mcp-server-time")).toThrow(/^uvx --from needs a command after its package$/);
    expect(() => uvx()).toThrow(/^uvx needs a package name$/);
    expect(() => uvx("--offline", "-q")).toThrow(/^uvx needs a package name$/);
  });

  it("keeps the versions and the interpreter to what the cage can build: CPython 3.10 to 3.15, a validated prerelease mode and date", () => {
    for (const python of ["3.9", "3.16", "3", "312", "3.12.", "3.012", "cpython3.12", "pypy3.10", "/usr/bin/python3", ">=3.12", "", " 3.13"]) {
      expect(() => uvx("--python", python, "mcp-server-time"), JSON.stringify(python)).toThrow(new Error(`uvx --python: ${PYTHON}`));
    }
    expect(() => uvx("--prerelease", "sometimes", "mcp-server-time")).toThrow(/^uvx --prerelease: give one of disallow, allow, if-necessary, explicit, if-necessary-or-explicit$/);
    // Forms uv 0.13.7 takes, a zone required on a time: without one, uv reads it in the host's zone, and the cage has another.
    for (const date of ["2026-01-01T00:00:00Z", "2026-01-01t12:30:59.5+02:00", "2026-01-01T00:00z", "3 days", "1 day", "2 weeks", "24 hours", "3d", "3h", "2w", "30s", "3 days ago", "5 minutes", "3 mins", "3 hrs", "3 secs", "1 wk", "99999 days", "P3D", "PT1H30M", "P2W3D", "p3d", "pt1h", "P1DT12H"]) {
      expect(uvx("--exclude-newer", date, "mcp-server-time"), date).toEqual(time({ resolution: { excludeNewer: date } }));
    }
    for (const date of ["2023-02-29", "2026-13-01", "2026-1-1", "2026-01-01T25:00:00Z", "2026-01-01T00:00", "2026-01-01 00:00:00Z", "1 month", "1 year", "P1Y", "P1M", "P", "PT", "1.5 days", "999999 days", "3 DAYS", "friday", ""]) {
      expect(() => uvx("--exclude-newer", date, "mcp-server-time"), JSON.stringify(date)).toThrow(new Error("uvx --exclude-newer: give a date (2026-01-31), a time with its zone (2026-01-31T12:00:00Z) or a duration (30 days, P30D)"));
    }
  });

  it("gives the cage the instant uv reads a date of --exclude-newer as on the host: the start of the next day in its time zone", () => {
    // What uv 0.13.7 wrote into a uv.lock for `--exclude-newer 2026-01-01` with each TZ; the cage's uv runs in UTC.
    const lock: Array<[string, string, string]> = [
      ["Europe/Rome", "2026-01-01", "2026-01-01T23:00:00Z"],
      ["Europe/Rome", "2026-07-01", "2026-07-01T22:00:00Z"],
      ["America/New_York", "2026-01-01", "2026-01-02T05:00:00Z"],
      ["Asia/Tokyo", "2026-01-01", "2026-01-01T15:00:00Z"],
      ["UTC", "2026-01-01", "2026-01-02T00:00:00Z"],
      ["UTC", "2024-02-29", "2024-03-01T00:00:00Z"],
      ["UTC", "2026-12-31", "2027-01-01T00:00:00Z"],
    ];
    for (const [zone, date, instant] of lock) {
      inZone(zone, () => {
        expect(uvx("--exclude-newer", date, "mcp-server-time"), `${zone} ${date}`).toEqual(time({ resolution: { excludeNewer: instant } }));
        expect(uvx(`--exclude-newer=${date}`, "mcp-server-time"), `${zone} ${date}`).toEqual(time({ resolution: { excludeNewer: instant } }));
        // UV_EXCLUDE_NEWER is read as uv reads the flag.
        expect(parseLaunch(["uvx", "mcp-server-time"], undefined, "linux", [{ where: "its env", variables: { UV_EXCLUDE_NEWER: date } }]), `${zone} ${date}`).toEqual(time({ resolution: { excludeNewer: instant } }));
      });
    }
    // A time with its zone and a duration mean the same in the cage: as written.
    inZone("Asia/Tokyo", () => {
      for (const value of ["2026-01-01T00:00:00Z", "2026-01-01T12:30:00+02:00", "30 days", "P3D"]) expect(uvx("--exclude-newer", value, "mcp-server-time"), value).toEqual(time({ resolution: { excludeNewer: value } }));
    });
  });

  it("takes each form of --exclude-newer uv 0.13.7 takes, and refuses an impossible date or time", () => {
    const taken = [
      "2024-02-29", "2026-12-31", "2026-01-01T23:59:59Z", "2026-01-01t00:00z", "2026-01-01T12:30:00.123456789+02:00", "2026-01-01T12:30-23:59",
      "1 s", "2 sec", "3 secs", "4 second", "5 seconds", "6 min", "7 mins", "8 minute", "9 minutes", "10 h", "11 hr", "12 hrs", "13 hour", "14 hours",
      "15 d", "16day", "17 days", "18 w", "19 wk", "20 week", "21 weeks", "99999 days ago", "P1W", "P2D", "P1W2D", "PT3H", "PT4M", "PT5S", "P1DT2H3M4S", "p3d",
    ];
    for (const value of taken) expect((uvx("--exclude-newer", value, "mcp-server-time") as PypiLaunch).resolution, value).toHaveProperty("excludeNewer");
    const refused = [
      "2026-02-29", "2026-04-31", "2026-00-10", "2026-01-00", "2026-01-01T24:00:00Z", "2026-01-01T23:60:00Z", "2026-01-01T23:59:60Z", "2026-01-01T12:00+24:00",
      "2026-01-01T12:00+02:60", "x2026-01-01", "2026-01-01x", "123456 days", "1 dayz", "1 years", "P", "PT", "P1DT", "P123456D", "xP1D", "P1Dx", "1 day ago now",
    ];
    for (const value of refused) expect(() => uvx("--exclude-newer", value, "mcp-server-time"), value).toThrow(/^uvx --exclude-newer: give a date/);
  });

  it("refuses an instant of --exclude-newer after the last one uv 0.13.7 can write, 9999-12-30T22:00:00Z, at the start and not at the resolve", () => {
    const LATE = "uvx --exclude-newer: uv takes no instant after 9999-12-30T22:00:00Z, the last one it can write, and a date stands for the next midnight in this time zone";
    const late = (value: string) => () => uvx("--exclude-newer", value, "mcp-server-time");
    // Each as uv 0.13.7 answered in its pinned image with that TZ: refused, or the instant it gave.
    inZone("UTC", () => {
      expect(late("9999-12-30")).toThrow(new Error(LATE));
      expect(late("9999-12-31")).toThrow(new Error(LATE));
      expect(late("9999-12-30T22:00:01Z")).toThrow(new Error(LATE));
      expect(late("9999-12-31T08:00:01+10:00")).toThrow(new Error(LATE));
      expect((uvx("--exclude-newer", "9999-12-29", "mcp-server-time") as PypiLaunch).resolution.excludeNewer).toBe("9999-12-30T00:00:00Z");
      for (const value of ["9999-12-30T22:00:00Z", "9999-12-30T22:00:00.999999999Z", "9999-12-31T08:00:00+10:00"]) expect(late(value), value).not.toThrow();
      expect(() => parseLaunch(["uvx", "mcp-server-time"], undefined, "linux", [{ where: "its env", variables: { UV_EXCLUDE_NEWER: "9999-12-31" } }])).toThrow(
        new Error("its env sets UV_EXCLUDE_NEWER to an instant after 9999-12-30T22:00:00Z, the last one uv can write, and a date stands for the next midnight in this time zone"),
      );
    });
    // East of UTC the next midnight comes earlier: 9999-12-30 is 9999-12-30T10:00:00Z at UTC+14.
    inZone("Pacific/Kiritimati", () => {
      expect((uvx("--exclude-newer", "9999-12-30", "mcp-server-time") as PypiLaunch).resolution.excludeNewer).toBe("9999-12-30T10:00:00Z");
      expect(late("9999-12-31")).toThrow(new Error(LATE));
    });
    inZone("Etc/GMT+12", () => {
      expect((uvx("--exclude-newer", "9999-12-29", "mcp-server-time") as PypiLaunch).resolution.excludeNewer).toBe("9999-12-30T12:00:00Z");
      expect(late("9999-12-30")).toThrow(new Error(LATE));
    });
  });

  it("splits a --with value at its commas as uv does: not inside brackets, nor before a version operator", () => {
    const withs = (value: string) => (uvx("--with", value, "mcp-server-time") as { with: string[] }).with;
    expect(withs("a[x,y],b")).toEqual(["a[x,y]", "b"]);
    expect(withs("a[x],b[y]")).toEqual(["a[x]", "b[y]"]);
    expect(withs("a>=1, <2,b")).toEqual(["a>=1, <2", "b"]);
    expect(withs("a>=1,  !=1.5")).toEqual(["a>=1,  !=1.5"]);
    expect(withs("a,  b ,c")).toEqual(["a", "b", "c"]);
    expect(() => withs("a[x")).toThrow(/^uvx --with: not a PyPI requirement/);
  });

  it("takes extras and versions as PEP 508 and uv 0.13.7 write them, and refuses the ones uv refuses", () => {
    const taken = ["a[ x , y ]==1", "a [x]", "a == 1 , != 1.5", "a==1.0+local", "a!=1.0+local", "a===1.0+local", "a==1!2.*", "a!=v1.2.*", "a~=1!2.0", "a~=V2.0rc1", "a>=1.0"];
    for (const text of taken) expect(pypiRequirement(text), text).toBeDefined();
    const refused = ["a[x", "a[x,]", "a[-x]", "a[x-]", "a>=1.0+local", "a~=1.0+local", "a~=1", "a~=1!2", "a>=1.*", "a==1*", "a==1.0,", "a==1.0 x", "a==", "a 1.0"];
    for (const text of refused) expect(pypiRequirement(text), text).toBeUndefined();
  });

  it("ignores a variable of uv's set empty, as uv does, and reads UV_CONFIG_FILE as a settings file only from the user or a caged entry", () => {
    const env = (variables: Record<string, string>, more: object = {}) => [{ where: "its env", variables, ...more }];
    const read = (variables: Record<string, string>, more: object = {}) => parseLaunch(["uvx", "mcp-server-time"], undefined, "linux", env(variables, more));
    expect(read({ UV_PYTHON: "", UV_INDEX_URL: "", UV_EXCLUDE_NEWER: "", UV_RESOLUTION: "" })).toEqual(time());
    expect(() => read({ UV_CONFIG_FILE: "/home/me/uv.toml" })).toThrow("its env sets UV_CONFIG_FILE: uvx reads a file on your machine there, which the cage does not read");
    expect(read({ UV_CONFIG_FILE: "/home/me/uv.toml" }, { caged: true })).toEqual(time());
    expect(read({ UV_CONFIG_FILE: "/home/me/uv.toml" }, { own: true })).toEqual(time());
  });

  it("takes --color auto, always and never, which only tune uv's output", () => {
    for (const value of ["auto", "always", "never"]) expect(uvx("--color", value, "mcp-server-time"), value).toEqual(time());
  });

  it("reads uv tool run only at the start of uv's line, with nothing of uv's own before it", () => {
    expect(() => parseLaunch(["uv", "-q", "tool", "run", "mcp-server-time"], undefined, "linux")).toThrow(/^uv -q before tool run: /);
    expect(() => parseLaunch(["uv", "--directory=/x", "tool", "uvx", "mcp-server-time"], undefined, "linux")).toThrow(/^uv --directory before tool run: /);
    // Another uv command, or a word that only looks like a flag of uv's elsewhere: a host command.
    for (const argv of [["uv", "run", "-q", "tool", "run", "x"], ["uv", "-q", "pip", "install", "x"], ["uvicorn", "-q", "tool", "run", "x"]]) {
      expect(parseLaunch(argv, undefined, "linux"), argv.join(" ")).toEqual({ kind: "host", command: argv[0], args: argv.slice(1) });
    }
    expect(toolRunArgs([5, "mcp-server-time"], "linux")).toBeUndefined();
    expect(toolRunArgs(["cmd", "/c", "npx", "-y", "x"], "win32")).toBeUndefined();
    expect(toolRunArgs(["cmd", "/c", "uvx", "mcp-server-time"], "win32")).toEqual(["mcp-server-time"]);
  });

  it("knows a command line that starts uv: uvx, uv tool run, or uv itself with anything after it", () => {
    for (const argv of [["uvx", "x"], ["uv", "pip", "install", "x"], ["/opt/uv/bin/uv"], ["uv", "tool", "run", "x"]]) expect(startsUv(argv, "linux"), argv.join(" ")).toBe(true);
    for (const argv of [["npx", "x"], ["uvicorn", "app"], ["uv.exe.old"], [5], []]) expect(startsUv(argv as unknown[], "linux"), JSON.stringify(argv)).toBe(false);
  });

  it("refuses a Windows script after --from, and drops only a final .exe there", () => {
    const from = (command: string) => (parseLaunch(["uvx", "--from", "mcp-server-time", command], undefined, "win32") as { command: string }).command;
    expect(from("server.EXE")).toBe("server");
    expect(from("tool.exec")).toBe("tool.exec");
    expect(from("server.cmdline")).toBe("server.cmdline");
    expect(() => from("server.Cmd")).toThrow(/^uvx --from: the command is a Windows script/);
  });

  it("says a requirement is from outside PyPI only when uv would read it so", () => {
    for (const text of ["agit+x", "afile:x", "pkg:x"]) expect(() => uvx(text), text).toThrow(new Error(`uvx <package>: ${NOT_REQUIREMENT}`));
    for (const text of ["git+x", "file:x", "C:x", " ./x"]) expect(() => uvx(text), text).toThrow(new Error(`uvx <package>: ${OUTSIDE}`));
  });

  it("refuses a flag that misses its value or is given twice, as uv does", () => {
    expect(() => uvx("--with")).toThrow(/^uvx --with needs a value$/);
    expect(() => uvx("-w")).toThrow(/^uvx --with needs a value$/);
    expect(() => uvx("--cache-dir", "--offline", "mcp-server-time")).toThrow(/^uvx --cache-dir needs a value$/);
    expect(() => uvx("--from", "--offline", "x")).toThrow(/^uvx --from needs a value$/);
    for (const words of [["--python", "3.12", "-p", "3.13"], ["--from", "a", "--from=b"], ["--prerelease", "allow", "--prerelease", "allow"], ["--exclude-newer", "P1D", "--exclude-newer", "P2D"]]) {
      expect(() => uvx(...words, "mcp-server-time"), JSON.stringify(words)).toThrow(new RegExp(`^uvx ${words[0]} is given twice$`));
    }
  });

  it("reads uv tool run as uvx, but not with uv's own flags before it, and leaves uv run and pipx alone", () => {
    expect(parseLaunch(["uv", "tool", "run", "mcp-server-time", "a"], undefined, "linux")).toEqual(time({ args: ["a"] }));
    expect(parseLaunch(["/usr/local/bin/uv", "tool", "run", "--from", "awslabs.aws-api-mcp-server@latest", "awslabs.aws-api-mcp-server"], undefined, "linux")).toMatchObject({ kind: "pypi", project: "awslabs-aws-api-mcp-server", command: "awslabs.aws-api-mcp-server" });
    expect(parseLaunch(["/Users/me/.local/bin/uvx", "mcp-server-time"], undefined, "darwin")).toEqual(time());
    // --directory before tool run changes uv's working directory.
    expect(() => parseLaunch(["uv", "--directory", "/x", "tool", "run", "mcp-server-time"], undefined, "linux")).toThrow(
      new Error("uv --directory before tool run: flags there are uv's own (--directory changes its working directory), and only `uv tool run [flags] <package>` is read as uvx"),
    );
    expect(() => parseLaunch(["uv", "-q", "tool", "run", "mcp-server-time"], undefined, "linux")).toThrow(/^uv -q before tool run: /);
    for (const argv of [["uv", "run", "--with", "mcp-clickhouse", "mcp-clickhouse"], ["uv", "--directory", "/x/weather", "run", "weather.py"], ["uv", "tool", "install", "x"], ["uv", "tool"], ["uv"], ["pipx", "run", "analytics-mcp"], ["python", "-m", "mcp_server_time"], ["uvxx", "x"], ["myuvx", "x"]]) {
      expect(parseLaunch(argv, undefined, "linux")).toEqual({ kind: "host", command: argv[0], args: argv.slice(1) });
    }
  });

  it("knows uvx.exe and uv.exe in any case on Windows, and drops .exe from the command after --from there only", () => {
    for (const command of ["UVX.EXE", "uvx.exe", "Uvx", "C:\\Users\\me\\.local\\bin\\uvx.exe", "c:/tools/UVX"]) {
      expect(parseLaunch([command, "mcp-server-time"], undefined, "win32"), command).toEqual(time());
    }
    expect(parseLaunch(["UVX.EXE", "mcp-server-time"], undefined, "linux")).toEqual({ kind: "host", command: "UVX.EXE", args: ["mcp-server-time"] });
    expect(parseLaunch(["uvx.exe", "mcp-server-time"], undefined, "linux")).toEqual(time());
    expect(parseLaunch(["C:\\Users\\me\\.local\\bin\\UV.exe", "tool", "run", "mcp-server-time"], undefined, "win32")).toEqual(time());
    // awslabs' Windows form.
    const aws = ["tool", "run", "--from", "awslabs.aws-api-mcp-server@latest", "awslabs.aws-api-mcp-server.exe"];
    expect(parseLaunch(["uv.exe", ...aws], undefined, "win32")).toMatchObject({ requirement: "awslabs.aws-api-mcp-server", command: "awslabs.aws-api-mcp-server" });
    expect(parseLaunch(["uv.exe", ...aws], undefined, "linux")).toMatchObject({ command: "awslabs.aws-api-mcp-server.exe" });
    expect(parseLaunch(["uvx", "--from", "mcp-server-time", "Server.EXE"], undefined, "win32")).toMatchObject({ command: "Server" });
    // Without --from, uvx reads x.exe as a package named x-exe.
    expect(parseLaunch(["uvx", "mcp-server-time.exe"], undefined, "win32")).toMatchObject({ project: "mcp-server-time-exe", command: "mcp-server-time.exe" });
    for (const script of ["server.cmd", "server.BAT", "server.ps1"]) {
      expect(() => parseLaunch(["uvx", "--from", "mcp-server-time", script], undefined, "win32"), script).toThrow(new Error("uvx --from: the command is a Windows script (.cmd, .bat or .ps1), which the cage cannot start"));
    }
    expect(() => parseLaunch(["uvx", "--from", "mcp-server-time", ".exe"], undefined, "win32")).toThrow(/^uvx --from: the command after its package must be a plain file name/);
  });

  it("knows uvx, uv and npx in any case on macOS too, whose APFS compares names without case, and reads uv tool uvx as uv tool run", () => {
    // An UVX in ~/.local/bin was uv's uvx on macOS, and a client started it.
    for (const command of ["UVX", "Uvx", "/Users/me/.local/bin/UVX", "uvx.EXE"]) {
      expect(parseLaunch([command, "mcp-server-time"], undefined, "darwin"), command).toEqual(time());
      expect(serverType({ command, args: ["mcp-server-time"] }, "darwin"), command).toBe("uvx");
      expect(serverType({ command }, "darwin"), command).toBe("uvx");
    }
    expect(parseLaunch(["UV", "tool", "run", "mcp-server-time"], undefined, "darwin")).toEqual(time());
    expect(parseLaunch(["NPX", "-y", "@acme/notes-mcp"], undefined, "darwin")).toEqual({ kind: "npm", packageName: "@acme/notes-mcp", args: [] });
    expect(serverType({ command: "/opt/homebrew/bin/NPX", args: ["-y", "@acme/notes-mcp"] }, "darwin")).toBe("npx");
    // Linux compares names with case: those are other programs there.
    expect(parseLaunch(["UVX", "mcp-server-time"], undefined, "linux")).toEqual({ kind: "host", command: "UVX", args: ["mcp-server-time"] });
    expect(parseLaunch(["NPX", "-y", "x"], undefined, "linux")).toEqual({ kind: "host", command: "NPX", args: ["-y", "x"] });
    expect(serverType({ command: "UVX" }, "linux")).toBe("other");
    // `uv tool uvx` is the command uvx itself calls: `uv tool uvx --offline mcp-server-time` 0.13.7 ran it as uvx does.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(parseLaunch(["uv", "tool", "uvx", "mcp-server-time", "a"], undefined, platform), platform).toEqual(time({ args: ["a"] }));
      expect(serverType({ command: "uv", args: ["tool", "uvx", "--from", "mcp-server-time", "mcp-server-time"] }, platform), platform).toBe("uvx");
    }
    expect(() => parseLaunch(["uv", "--directory", "/x", "tool", "uvx", "mcp-server-time"], undefined, "linux")).toThrow(/^uv --directory before tool run: /);
    // uv's subcommands keep their case: uv 0.13.7 refused `uv tool UVX` and `uv TOOL run`.
    for (const argv of [["uv", "tool", "UVX", "mcp-server-time"], ["uv", "TOOL", "run", "mcp-server-time"]]) {
      expect(parseLaunch(argv, undefined, "darwin"), JSON.stringify(argv)).toEqual({ kind: "host", command: "uv", args: argv.slice(1) });
    }
  });

  it("gives a uvx server an id from its project, command and arguments, not from its version, extras, --with or --python", () => {
    const id = serverIdFor(uvx("mcp-server-time", "--local-timezone", "UTC"));
    // sha256 of {"args":["--local-timezone","UTC"],"command":"mcp-server-time","kind":"pypi","project":"mcp-server-time"}.
    expect(id).toBe("mcp-server-time-36c64a4d");
    const same = [
      uvx("mcp-server-time@2026.1.26", "--local-timezone", "UTC"),
      uvx("mcp-server-time@latest", "--local-timezone", "UTC"),
      uvx("mcp-server-time[x]>=2027", "--local-timezone", "UTC"),
      uvx("--with", "tzdata", "--python", "3.12", "--prerelease", "allow", "--exclude-newer", "P1D", "mcp-server-time", "--local-timezone", "UTC"),
      uvx("--from", "Mcp_Server.Time==1", "mcp-server-time", "--local-timezone", "UTC"),
      parseLaunch(["uv", "tool", "run", "mcp-server-time", "--local-timezone", "UTC"], undefined, "linux"),
      parseLaunch(["C:\\x\\UVX.EXE", "--from", "mcp-server-time", "mcp-server-time.exe", "--local-timezone", "UTC"], undefined, "win32"),
    ];
    for (const spec of same) expect(serverIdFor(spec), JSON.stringify(spec)).toBe(id);
    const other = [
      uvx("mcp-server-time", "--local-timezone", "Europe/Rome"),
      uvx("mcp-server-time"),
      uvx("--from", "mcp-server-time", "python", "--local-timezone", "UTC"),
      uvx("mcp-server-fetch", "--local-timezone", "UTC"),
    ];
    for (const spec of other) expect(serverIdFor(spec), JSON.stringify(spec)).not.toBe(id);
    // The same line run on the host, as `run --no-sandbox` reads it, keeps the id it had.
    expect(serverIdFor({ kind: "host", command: "/usr/local/bin/uvx", args: ["mcp-server-time"] })).toBe("uvx-82cf2188");
  });
});

describe("uv's environment on a uvx line", () => {
  const time = (changes: object = {}) => ({ kind: "pypi", project: "mcp-server-time", requirement: "mcp-server-time", command: "mcp-server-time", with: [], resolution: {}, args: [], ...changes });
  /** `uvx [words]` started with `env`, an entry's env as a client gives it. */
  const started = (env: unknown, words: string[] = ["mcp-server-time"], platform: NodeJS.Platform = "linux") =>
    parseLaunch(["uvx", ...words], undefined, platform, [{ where: "its env", variables: env }]);

  it("refuses each variable that makes uvx install from another index, from a file on the machine or from source, naming it and never its value", () => {
    const secret = "https://user:s3cret-t0ken@pypi.corp.example/simple";
    const table: Array<[string, string]> = [
      ...["UV_INDEX", "UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS", "UV_INDEX_STRATEGY", "UV_KEYRING_PROVIDER", "UV_TORCH_BACKEND"].map((name): [string, string] => [name, "uvx installs from another index there"]),
      ...["UV_CONFIG_FILE", "UV_CONSTRAINT", "UV_OVERRIDE", "UV_BUILD_CONSTRAINT", "UV_ENV_FILE"].map((name): [string, string] => [name, "uvx reads a file on your machine there, which the cage does not read"]),
      // --directory's: uv 0.13.7 ran the server in that directory, and read a relative UV_CONFIG_FILE from it.
      ...["UV_WORKING_DIR", "UV_WORKING_DIRECTORY"].map((name): [string, string] => [name, "uvx reads a file on your machine there, which the cage does not read"]),
      ["UV_NO_BINARY", "uvx builds packages from source there, and the cage installs PyPI wheels only"],
      ["UV_NO_BINARY_PACKAGE", "uvx builds packages from source there, and the cage installs PyPI wheels only"],
      ["UV_INSECURE_HOST", "uvx turns off certificate checks for a host there, which only another index or a proxy needs"],
    ];
    for (const [name, why] of table) {
      let message = "";
      try {
        started({ API_KEY: "x", [name]: secret });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, name).toBe(`its env sets ${name}: ${why}`);
      expect(message).not.toContain("s3cret");
      // Any value, a number or a list as a configuration file may hold one, and through uv tool run and --from too.
      expect(() => started({ [name]: 1 }), name).toThrow(`its env sets ${name}: ${why}`);
      expect(() => parseLaunch(["uv", "tool", "run", "--from", "mcp-server-time", "mcp-server-time"], undefined, "linux", [{ where: "its env", variables: { [name]: "x" } }]), name).toThrow(`its env sets ${name}:`);
    }
    // The exact text protect and wrap show for the most common one.
    expect(() => started({ UV_INDEX_URL: secret })).toThrow(new Error("its env sets UV_INDEX_URL: uvx installs from another index there"));
  });

  it("leaves alone what uv does not read: an empty value, a name in another case off Windows, UV_NO_INDEX, and the variables that tune uv on the host", () => {
    // uv 0.13.7 ignored UV_INDEX_URL= and installed from PyPI with UV_NO_INDEX=1.
    expect(started({ UV_INDEX_URL: "", UV_PYTHON: "", UV_NO_INDEX: "1" })).toEqual(time());
    expect(started({ uv_index_url: "https://x.example/simple" })).toEqual(time());
    const tuning = { UV_CACHE_DIR: "/tmp/c", UV_NO_PROGRESS: "1", UV_LINK_MODE: "copy", UV_PYTHON_PREFERENCE: "only-system", UV_NO_CACHE: "1", UV_OFFLINE: "1", UV_NO_CONFIG: "1", UV_RESOLUTION: "highest", UV_NO_BUILD_ISOLATION: "1" };
    expect(started(tuning)).toEqual(time());
    // uv 0.13.7's tool run kept its directory with UV_PROJECT set, and read nothing in the one it named.
    expect(started({ UV_PROJECT: "/tmp/project" })).toEqual(time());
    // No env at all, or one that is not an object, as configuration files are not type-checked.
    for (const env of [undefined, null, "UV_INDEX_URL=x", ["UV_INDEX_URL"], 3]) expect(started(env), JSON.stringify(env)).toEqual(time());
  });

  it("refuses UV_RESOLUTION but for highest, uv's default: lowest made uv install another version than the cage", () => {
    for (const value of ["lowest", "lowest-direct", "Highest", 1]) {
      expect(() => started({ UV_RESOLUTION: value }), JSON.stringify(value)).toThrow(new Error("its env sets UV_RESOLUTION: uvx chooses other versions there than the newest, which the cage installs"));
    }
  });

  it("reads UV_PYTHON, UV_PRERELEASE and UV_EXCLUDE_NEWER as their flags, with the same values, the flag winning as in uv", () => {
    expect(started({ UV_PYTHON: "3.12", UV_PRERELEASE: "allow", UV_EXCLUDE_NEWER: "P7D" })).toEqual(time({ python: "3.12", resolution: { prerelease: "allow", excludeNewer: "P7D" } }));
    expect(started({ UV_PYTHON: "3.11.4" })).toEqual(time({ python: "3.11.4" }));
    // The flag wins, whatever the variable says: uv does not read the variable then.
    expect(started({ UV_PYTHON: "pypy3.10", UV_PRERELEASE: "sometimes", UV_EXCLUDE_NEWER: "1 year" }, ["--python", "3.13", "--prerelease", "explicit", "--exclude-newer", "P1D", "mcp-server-time"])).toEqual(
      time({ python: "3.13", resolution: { prerelease: "explicit", excludeNewer: "P1D" } }),
    );
    const python = "its env sets UV_PYTHON to another value than a CPython version from 3.10 to 3.15 (such as 3.12 or 3.12.4), the only ones the cage runs";
    for (const value of ["3.9", "pypy3.10", "/usr/bin/python3", ">=3.12", "3.12t", 3.12, ["3.12"]]) expect(() => started({ UV_PYTHON: value }), JSON.stringify(value)).toThrow(new Error(python));
    expect(() => started({ UV_PRERELEASE: "sometimes" })).toThrow(new Error("its env sets UV_PRERELEASE to another value than one of disallow, allow, if-necessary, explicit, if-necessary-or-explicit"));
    expect(() => started({ UV_EXCLUDE_NEWER: "1 year" })).toThrow(
      new Error("its env sets UV_EXCLUDE_NEWER to another value than a date (2026-01-31), a time with its zone (2026-01-31T12:00:00Z) or a duration (30 days, P30D)"),
    );
    // The Python and the resolution change the lock, not the server's id.
    expect(serverIdFor(started({ UV_PYTHON: "3.12" }))).toBe(serverIdFor(started({})));
  });

  it("compares names without case on Windows, as uv's reads there do, and says the name as written", () => {
    expect(() => started({ Uv_Index_Url: "x" }, ["mcp-server-time"], "win32")).toThrow(new Error("its env sets Uv_Index_Url: uvx installs from another index there"));
    expect(started({ uv_python: "3.12" }, ["mcp-server-time"], "win32")).toEqual(time({ python: "3.12" }));
    expect(parseLaunch(["cmd", "/c", "uvx", "mcp-server-time"], undefined, "win32", [{ where: "its env", variables: { UV_PYTHON: "3.14" } }])).toEqual(time({ python: "3.14" }));
  });

  it("takes each variable from the last layer that sets it, and names that layer", () => {
    const layers = (user: object, entry: object) => parseLaunch(["uvx", "mcp-server-time"], undefined, "linux", [{ where: "your environment", variables: user }, { where: "its env", variables: entry }]);
    expect(layers({ UV_PYTHON: "3.11" }, { UV_PYTHON: "3.12" })).toEqual(time({ python: "3.12" }));
    expect(layers({ UV_PYTHON: "3.11" }, {})).toEqual(time({ python: "3.11" }));
    expect(() => layers({ UV_INDEX_URL: "x" }, {})).toThrow(new Error("your environment sets UV_INDEX_URL: uvx installs from another index there"));
    expect(() => layers({ UV_INDEX_URL: "x" }, { UV_INDEX_URL: "y" })).toThrow(new Error("its env sets UV_INDEX_URL: uvx installs from another index there"));
    // Set empty by the entry, it is unset for uv, whatever the client's environment gave.
    expect(layers({ UV_INDEX_URL: "x" }, { UV_INDEX_URL: "" })).toEqual(time());
    // The user's own UV_CONFIG_FILE names their settings, which uv-settings.ts looks at for an index; an entry's is refused.
    const own = (user: object, entry: object) =>
      parseLaunch(["uvx", "mcp-server-time"], undefined, "linux", [{ where: "your environment", variables: user, own: true }, { where: "its env", variables: entry }]);
    expect(own({ UV_CONFIG_FILE: "/home/me/uv.toml" }, {})).toEqual(time());
    expect(() => own({}, { UV_CONFIG_FILE: "/tmp/x.toml" })).toThrow(new Error("its env sets UV_CONFIG_FILE: uvx reads a file on your machine there, which the cage does not read"));
    expect(() => own({ UV_CONSTRAINT: "/home/me/c.txt" }, {})).toThrow(new Error("your environment sets UV_CONSTRAINT: uvx reads a file on your machine there, which the cage does not read"));
    // An npx line reads none of it.
    expect(parseLaunch(["npx", "-y", "x"], undefined, "linux", [{ where: "its env", variables: { UV_INDEX_URL: "x" } }])).toEqual({ kind: "npm", packageName: "x", versionRange: undefined, args: [] });
  });
});
