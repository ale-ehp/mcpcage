import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountHome, clientPlaces, sensitivePath } from "../src/sensitive.js";
import { literal } from "./helpers.js";

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
    // Places are also looked up where their symlinks lead on the machine running the test. On Linux
    // /var/run leads to /run, so there /var/run, a place on macOS too, holds /run/user; on a Mac it
    // leads to /private/var/run. Either way the place /run must not count on macOS: it would be
    // named first, as written.
    const varRunIsRun = process.platform !== "win32" && existsSync("/var/run") && realpathSync.native("/var/run") === "/run";
    expect(sensitivePath("/run/user/501/podman", { home: "/Users/me", platform: "darwin" })).toBe(varRunIsRun ? "the Docker socket in /var/run" : undefined);
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

describe("each place mcpcage will not mount", () => {
  // The Linux home directory of these checks is not under /home. Places are also looked up where
  // their symlinks lead on the machine running the test, and on macOS /home is an automount: each
  // question about a path in /home/<name> waits for the automounter, about 12 ms on an idle Mac and
  // more on a busy one. With /home/me the Linux checks asked it some 650 times, and the first test
  // below went past its 30 seconds on a loaded Mac, where on Linux it takes milliseconds. Places are
  // named from ~, wherever the home directory is.
  const linuxHome = "/nowhere-mcpcage/home/me";

  /** Every place in the home directory, what it holds, and the one system it is on (none: every system). */
  const places: Array<[path: string, what: string, platform: string]> = [
      [".ssh", "your SSH keys", ""],
      [".aws", "your AWS credentials", ""],
      [".gnupg", "your GnuPG keys", ""],
      [".kube", "your Kubernetes credentials", ""],
      [".docker", "your Docker credentials", ""],
      [".config/gcloud", "your Google Cloud credentials", ""],
      [".azure", "your Azure credentials", ""],
      [".npmrc", "your npm token", ""],
      [".netrc", "your saved logins", ""],
      [".git-credentials", "your Git credentials", ""],
      [".password-store", "your passwords", ""],
      ["Library/Keychains", "your keychains", "darwin"],
      [".colima", "the Docker socket of Colima", ""],
      [".orbstack", "the Docker socket of OrbStack", ""],
      [".mcpcage", "mcpcage's own pins and audit logs", ""],
      [".claude.json", "your MCP configurations and their tokens", ""],
      [".cursor", "the MCP servers, settings and extensions of Cursor", ""],
      [".vscode", "the settings and extensions of VS Code", ""],
      [".vscode-insiders", "the settings and extensions of VS Code Insiders", ""],
      [".claude", "the settings and hooks of Claude Code", ""],
      [".codeium", "the MCP servers and settings of Windsurf", ""],
      [".copilot", "the MCP servers and settings of GitHub Copilot", ""],
      [".config/devin", "the MCP servers and settings of Devin", ""],
      [".gemini", "the MCP servers and settings of Gemini CLI", ""],
      [".codex", "the MCP servers and settings of Codex", ""],
      [".continue", "the MCP servers and settings of Continue", ""],
      [".config/zed", "the MCP servers and settings of Zed", ""],
      ["Library/Application Support/Claude", "the MCP servers and settings of Claude Desktop", "darwin"],
      ["Library/Application Support/Code", "the MCP servers and settings of VS Code", "darwin"],
      ["Library/Application Support/Code - Insiders", "the MCP servers and settings of VS Code Insiders", "darwin"],
      ["Library/Application Support/Cursor", "the MCP servers and settings of Cursor", "darwin"],
      ["Library/Application Support/Windsurf", "the MCP servers and settings of Windsurf", "darwin"],
      ["Library/Application Support/Zed", "the MCP servers and settings of Zed", "darwin"],
      [".config/Code", "the MCP servers and settings of VS Code", "linux"],
      [".config/Code - Insiders", "the MCP servers and settings of VS Code Insiders", "linux"],
      [".config/Cursor", "the MCP servers and settings of Cursor", "linux"],
      [".config/Windsurf", "the MCP servers and settings of Windsurf", "linux"],
      ["AppData/Roaming/Claude", "the MCP servers and settings of Claude Desktop", "win32"],
      ["AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude", "the MCP servers and settings of Claude Desktop", "win32"],
      ["AppData/Roaming/Code", "the MCP servers and settings of VS Code", "win32"],
      ["AppData/Roaming/Code - Insiders", "the MCP servers and settings of VS Code Insiders", "win32"],
      ["AppData/Roaming/Cursor", "the MCP servers and settings of Cursor", "win32"],
      ["AppData/Roaming/devin", "the MCP servers and settings of Devin", "win32"],
      ["Library/LaunchAgents", "the programs that start at login", "darwin"],
      [".config/autostart", "the programs that start at login", "linux"],
      [".config/systemd", "your systemd services", "linux"],
      ["AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup", "the programs that start at login", "win32"],
      [".gitconfig", "your Git configuration", ""],
      [".config/git", "your Git configuration", ""],
      [".config/gh", "your GitHub CLI token", ""],
      [".config/hub", "your GitHub token", ""],
      [".pypirc", "your PyPI token", ""],
      [".cargo/credentials", "your crates.io token", ""],
      [".cargo/credentials.toml", "your crates.io token", ""],
      [".gem/credentials", "your RubyGems token", ""],
      [".terraform.d", "your Terraform tokens", ""],
      [".vault-token", "your Vault token", ""],
      [".boto", "your cloud storage credentials", ""],
      [".s3cfg", "your S3 credentials", ""],
      [".yarnrc.yml", "your Yarn token", ""],
      [".config/op", "your 1Password CLI accounts", ""],
      [".local/bin", "the programs you run", ""],
      ["bin", "the programs you run", ""],
      [".npm", "the packages npx runs", ""],
      [".nvm", "the programs nvm installs", ""],
      [".volta", "the programs Volta installs", ""],
      [".bun", "the programs Bun installs", ""],
      [".deno", "the programs Deno installs", ""],
      [".cargo/bin", "the programs Cargo installs", ""],
      ["go/bin", "the programs Go installs", ""],
      [".pyenv", "the programs pyenv installs", ""],
      [".rbenv", "the programs rbenv installs", ""],
      [".asdf", "the programs asdf installs", ""],
      ["Library/pnpm", "the programs pnpm installs", "darwin"],
      ["Applications", "your applications", "darwin"],
      [".local/share/pnpm", "the programs pnpm installs", "linux"],
      [".rd", "the Docker socket of Rancher Desktop", ""],
      [".lima", "the Docker socket of Lima", ""],
      ["Library/Containers/com.docker.docker", "the Docker socket of Docker Desktop", "darwin"],
      [".zshrc", "the commands your shell runs", ""],
      [".zshenv", "the commands your shell runs", ""],
      [".zprofile", "the commands your shell runs", ""],
      [".zlogin", "the commands your shell runs", ""],
      [".zlogout", "the commands your shell runs", ""],
      [".bashrc", "the commands your shell runs", ""],
      [".bash_profile", "the commands your shell runs", ""],
      [".bash_login", "the commands your shell runs", ""],
      [".bash_logout", "the commands your shell runs", ""],
      [".profile", "the commands your shell runs", ""],
      [".config/fish", "the commands your shell runs", ""],
      [".oh-my-zsh", "the commands your shell runs", ""],
  ];

  it("is named with what it holds, from the home directory, on the systems where it is", () => {
    const homes = { darwin: "/Users/me", linux: linuxHome, win32: "C:\\Users\\me" } as const;
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const windows = platform === "win32";
      const at = (path: string) => (windows ? path.split("/").join("\\") : path);
      const home = homes[platform];
      for (const [path, what, only] of places) {
        if (only !== "" && only !== platform) continue;
        const separator = windows ? "\\" : "/";
        expect(sensitivePath(`${home}${separator}${at(path)}${separator}x`, { home, platform }), `${platform} ${path}`).toBe(`${what} in ~${separator}${at(path)}`);
      }
    }
  });

  it("outside the home directory, is named with what it holds on macOS and Linux", () => {
    const system: Array<[path: string, what: string, only?: NodeJS.Platform]> = [
      ["/etc", "the system configuration"],
      ["/private/etc", "the system configuration"],
      ["/var/run", "the Docker socket"],
      ["/private/var/run", "the Docker socket"],
      ["/usr/bin", "the system's programs"],
      ["/bin", "the system's programs"],
      ["/usr/sbin", "the system's programs"],
      ["/sbin", "the system's programs"],
      ["/usr/local", "the programs you run"],
      ["/opt/homebrew", "the programs Homebrew installs"],
      ["/Applications", "your applications", "darwin"],
      ["/Library", "the programs and settings of every user", "darwin"],
    ];
    for (const [platform, home] of [["darwin", "/Users/me"], ["linux", linuxHome]] as const) {
      for (const [path, what, only] of system) {
        if (only !== undefined && only !== platform) continue;
        // Named as written or where a link leads (/bin is /usr/bin on some Linux systems): what it holds is the same.
        expect(sensitivePath(`${path}/mcpcage-nothing-here`, { home, platform }), `${platform} ${path}`).toMatch(new RegExp(`^${literal(what)} in /`));
      }
    }
    // The directories that hold every user's home directory, wherever this one is.
    expect(sensitivePath("/Users", { home: "/var/me", platform: "darwin" })).toBe("your whole home directory and more");
    expect(sensitivePath("/home", { home: "/var/me", platform: "linux" })).toBe("your whole home directory and more");
  });
});

describe("client configurations", () => {
  it("count a client's file alone when it keeps no directory of its own", () => {
    expect(clientPlaces({ platform: "linux", home: "/home/me", env: {} })).toContainEqual({ path: "/home/me/.claude.json", what: "the MCP servers and settings of Claude Code" });
  });
});
