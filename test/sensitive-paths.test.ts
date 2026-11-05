import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountHome, clientPlaces, sensitivePath } from "../src/sensitive.js";

// An account the user database does not know, as in some containers: userInfo() throws.
const database = vi.hoisted(() => ({ knows: true }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return {
    ...os,
    userInfo: (...args: Parameters<typeof os.userInfo>) => {
      if (!database.knows) throw new Error("no such account");
      return os.userInfo(...args);
    },
  };
});
afterEach(() => {
  database.knows = true;
});

const linux = { home: "/home/me", platform: "linux" as const };
const windows = { home: "C:\\Users\\me", platform: "win32" as const };

describe("the account's home directory", () => {
  it("is HOME's for an account the user database does not know", () => {
    database.knows = false;
    expect(accountHome()).toBe(homedir());
  });
});

describe("paths mcpcage will not mount, in more detail", () => {
  it("takes a drive letter alone for the root of its drive on Windows, and a tilde path from the home directory", () => {
    expect(sensitivePath("C:", windows)).toBe("the whole disk");
    expect(sensitivePath("~\\.ssh", windows)).toBe("your SSH keys in ~\\.ssh");
    expect(sensitivePath("~\\.ssh\\x:", windows)).toBe("your SSH keys in ~\\.ssh");
  });

  it("says nothing of a relative path, even one named like a project's settings", () => {
    expect(sensitivePath(".git", linux)).toBeUndefined();
    expect(sensitivePath("project/.vscode", linux)).toBeUndefined();
  });

  it("names the settings each editor and agent loads from a project", () => {
    expect(sensitivePath("/work/p/.cursor/rules", linux)).toBe("the settings Cursor loads when it opens /work/p");
    expect(sensitivePath("/work/p/.devin", linux)).toBe("the settings Devin loads when it opens /work/p");
    expect(sensitivePath("/work/p/.windsurf", linux)).toBe("the settings Windsurf loads when it opens /work/p");
  });

  it("counts what holds the home directory or the account's, wherever they are", () => {
    // Neither is under /home or /Users, which count already.
    expect(sensitivePath("/srv/people", { ...linux, home: "/srv/people/me" })).toBe("your whole home directory and more");
    expect(sensitivePath("/srv/people", { ...linux, home: "/data/me", account: "/srv/people/me" })).toBe("your whole home directory and more");
    expect(sensitivePath("/data", { ...linux, home: "/data/me", account: "/srv/people/me" })).toBe("your whole home directory and more");
    // C:\Users holds every profile, whichever drive the home directory is on.
    expect(sensitivePath("C:\\Users", { ...windows, home: "D:\\home\\me" })).toBe("your whole home directory and more");
  });

  it("writes a place in the home directory from ~, when the home directory is the place or the root", () => {
    expect(sensitivePath("/home/me/notes", { ...linux, cage: "/home/me" })).toBe("mcpcage's own pins and audit logs in ~");
    expect(sensitivePath("/nowhere-mcpcage/bin/tool", { home: "/", platform: "linux", path: "/nowhere-mcpcage/bin" })).toBe("the programs on your PATH in ~/nowhere-mcpcage/bin");
  });

  it("looks for no place from a relative home directory", () => {
    expect(sensitivePath(join(process.cwd(), "relative-home", ".ssh"), { home: "relative-home", platform: "linux" })).toBeUndefined();
  });

  it("keeps each system's places to that system", () => {
    // \etc is an ordinary folder on Windows; macOS has no /run.
    expect(sensitivePath("\\etc\\hosts", windows)).toBeUndefined();
    expect(sensitivePath("/run/user/501/podman", { home: "/Users/me", platform: "darwin" })).toBeUndefined();
    expect(sensitivePath("/run/user/1000/podman", linux)).toBe("the Docker and Podman sockets in /run");
  });

  it("knows the data volume of macOS itself as the whole disk, and only on macOS", () => {
    expect(sensitivePath("/System/Volumes/Data", { home: "/Users/me", platform: "darwin" })).toBe("the whole disk");
    expect(sensitivePath("/System/Volumes/Data/etc", linux)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not take every path in the home directory for a client's or the PATH's when a link to the home directory names them", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "mcpcage-home-")));
    mkdirSync(join(home, "Projects"));
    const elsewhere = mkdtempSync(join(tmpdir(), "mcpcage-links-"));
    const link = join(elsewhere, "home-link");
    symlinkSync(home, link);
    const options = { home, platform: "linux" as const, clients: [{ path: link, what: "the settings of a client" }], path: link };
    expect(sensitivePath(join(home, "Projects"), options)).toBeUndefined();
  });
});

describe("client configurations", () => {
  it("count a client's file alone when it keeps no directory of its own", () => {
    expect(clientPlaces({ platform: "linux", home: "/home/me", env: {} })).toContainEqual({ path: "/home/me/.claude.json", what: "the MCP servers and settings of Claude Code" });
  });
});
