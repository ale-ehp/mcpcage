import { describe, expect, it } from "vitest";
import { cmdNpx, imageRepository, isLocalPath, npxArgv, parseLaunch, serverIdFor, splitPackageSpec, type LaunchSpec } from "../src/launch.js";

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
