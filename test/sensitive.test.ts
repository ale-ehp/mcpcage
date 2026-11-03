import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sensitivePath } from "../src/sensitive.js";

describe("paths mcpcage will not mount", () => {
  const mac = { home: "/Users/me", platform: "darwin" as const };

  it("names the disk, the home directory and the places with credentials, what is inside them and what holds them", () => {
    const table: Array<[string, string]> = [
      ["/", "the whole disk"],
      ["/Users/me", "your whole home directory"],
      ["~", "your whole home directory"],
      ["/Users", "your whole home directory and more"],
      ["/Users/me/.ssh", "your SSH keys in ~/.ssh"],
      ["~/.ssh", "your SSH keys in ~/.ssh"],
      ["/Users/me/.ssh/id_rsa", "your SSH keys in ~/.ssh"],
      ["/Users/me/Projects/../.ssh", "your SSH keys in ~/.ssh"],
      // macOS ignores case, and shows its data volume at / as well.
      ["/Users/me/.SSH/", "your SSH keys in ~/.ssh"],
      ["/System/Volumes/Data/Users/me/.ssh", "your SSH keys in ~/.ssh"],
      ["/Users/me/.aws/credentials", "your AWS credentials in ~/.aws"],
      ["/Users/me/.config", "your Google Cloud credentials in ~/.config, which holds ~/.config/gcloud"],
      ["/Users/me/Library", "your keychains in ~/Library, which holds ~/Library/Keychains"],
      ["/Users/me/.mcpcage/audit", "mcpcage's own pins and audit logs in ~/.mcpcage"],
      ["/Users/me/.claude.json", "your MCP configurations and their tokens in ~/.claude.json"],
      ["/Users/me/.colima/default/docker.sock", "the Docker socket of Colima in ~/.colima"],
      ["/private/var/run/docker.sock", "the Docker socket in /private/var/run"],
      ["/var", "the Docker socket in /var, which holds /var/run"],
      ["/etc/ssh", "the system configuration in /etc"],
      ["/root", "the home directory of the root user"],
    ];
    for (const [path, reason] of table) expect(sensitivePath(path, mac), path).toBe(reason);
  });

  it("leaves ordinary paths alone, in the home directory too", () => {
    for (const path of ["/Users/me/Projects/notes", "/tmp/mcpcage-demo", "/Users/me/Documents", "/Users/me/.sshd", "/Users/me/.config-old", "/Users/other/notes", "relative/dir", "~notes"]) {
      expect(sensitivePath(path, mac), path).toBeUndefined();
    }
    // The keychains are a macOS place: on Linux ~/Library is an ordinary directory.
    expect(sensitivePath("/home/me/Library", { home: "/home/me", platform: "linux" })).toBeUndefined();
    expect(sensitivePath("/home/me/.ssh", { home: "/home/me", platform: "linux" })).toBe("your SSH keys in ~/.ssh");
  });

  it("protects mcpcage's own directory where MCPCAGE_HOME puts it", () => {
    const options = { ...mac, cage: "/srv/mcpcage" };
    expect(sensitivePath("/srv/mcpcage/servers/notes/pin.json", options)).toBe("mcpcage's own pins and audit logs in /srv/mcpcage");
    expect(sensitivePath("/srv", options)).toBe("mcpcage's own pins and audit logs in /srv, which holds /srv/mcpcage");
    expect(sensitivePath("/srv/data", options)).toBeUndefined();
  });

  it("follows symlinks: a link in an ordinary directory that leads to the SSH keys is the SSH keys", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-sensitive-"));
    const home = join(top, "home");
    const projects = join(top, "projects");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(projects);
    symlinkSync(join(home, ".ssh"), join(projects, "keys"));
    symlinkSync(home, join(projects, "everything"));
    const options = { home, platform: process.platform };
    expect(sensitivePath(join(projects, "keys"), options)).toBe("your SSH keys in ~/.ssh");
    expect(sensitivePath(join(projects, "keys", "id_ed25519"), options)).toBe("your SSH keys in ~/.ssh"); // not there: its parent is resolved
    expect(sensitivePath(join(projects, "everything"), options)).toBe("your whole home directory");
    // Mounting the directory itself is fine: inside the cage its links lead nowhere.
    expect(sensitivePath(projects, options)).toBeUndefined();
  });

  it("knows Windows paths: the root of a drive and the same places in the user's profile", () => {
    const windows = { home: "C:\\Users\\me", platform: "win32" as const };
    expect(sensitivePath("C:\\", windows)).toBe("the whole disk");
    expect(sensitivePath("C:\\Users\\me\\.ssh", windows)).toBe("your SSH keys in ~\\.ssh");
    expect(sensitivePath("c:/users/ME/.SSH/id_rsa", windows)).toBe("your SSH keys in ~\\.ssh");
    expect(sensitivePath("C:\\Users", windows)).toBe("your whole home directory and more");
    expect(sensitivePath("C:\\Users\\me\\Documents", windows)).toBeUndefined();
  });
});
