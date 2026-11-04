import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("counts the account's own home directory when HOME names another, and writes its places in full", () => {
    const options = { home: "/tmp/decoy", account: "/Users/me", platform: "darwin" as const };
    expect(sensitivePath("/Users/me/.ssh/id_ed25519", options)).toBe("your SSH keys in /Users/me/.ssh");
    expect(sensitivePath("/Users/me", options)).toBe("your whole home directory");
    expect(sensitivePath("/Users/me/.mcpcage", options)).toBe("mcpcage's own pins and audit logs in /Users/me/.mcpcage");
    // `~` stays what HOME says.
    expect(sensitivePath("~/.ssh", options)).toBe("your SSH keys in ~/.ssh");
    expect(sensitivePath("/Users/me/Projects/notes", options)).toBeUndefined();
    // The same directory twice is one home directory.
    expect(sensitivePath("/Users/me/.aws", { ...mac, account: "/Users/me" })).toBe("your AWS credentials in ~/.aws");
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

  it("names other clients' configurations, startup files, git's configuration, more credentials, programs and Docker sockets", () => {
    const table: Array<[string, string]> = [
      // Other clients' MCP and agent configurations: other servers' tokens, and which servers start.
      ["~/.cursor", "the MCP servers, settings and extensions of Cursor in ~/.cursor"],
      ["/Users/me/.cursor/mcp.json", "the MCP servers, settings and extensions of Cursor in ~/.cursor"],
      ["~/.vscode/extensions", "the settings and extensions of VS Code in ~/.vscode"],
      ["~/.claude/settings.json", "the settings and hooks of Claude Code in ~/.claude"],
      ["~/.codeium/windsurf/mcp_config.json", "the MCP servers and settings of Windsurf in ~/.codeium"],
      ["~/.config/devin", "the MCP servers and settings of Devin in ~/.config/devin"],
      ["~/.codex/config.toml", "the MCP servers and settings of Codex in ~/.codex"],
      ["~/Library/Application Support/Claude/claude_desktop_config.json", "the MCP servers and settings of Claude Desktop in ~/Library/Application Support/Claude"],
      ["~/Library/Application Support/Code/User/mcp.json", "the MCP servers and settings of VS Code in ~/Library/Application Support/Code"],
      ["~/Library/Application Support", "the MCP servers and settings of Claude Desktop in ~/Library/Application Support, which holds ~/Library/Application Support/Claude"],
      // What runs when a shell or a session starts.
      ["~/.zshrc", "the commands your shell runs in ~/.zshrc"],
      ["/Users/me/.bash_profile", "the commands your shell runs in ~/.bash_profile"],
      ["~/.config/fish/config.fish", "the commands your shell runs in ~/.config/fish"],
      ["~/Library/LaunchAgents/com.example.plist", "the programs that start at login in ~/Library/LaunchAgents"],
      // Git's own configuration.
      ["~/.gitconfig", "your Git configuration in ~/.gitconfig"],
      ["~/.config/git/config", "your Git configuration in ~/.config/git"],
      // More credentials.
      ["~/.config/gh/hosts.yml", "your GitHub CLI token in ~/.config/gh"],
      ["~/.pypirc", "your PyPI token in ~/.pypirc"],
      ["~/.cargo/credentials.toml", "your crates.io token in ~/.cargo/credentials.toml"],
      ["~/.cargo", "your crates.io token in ~/.cargo, which holds ~/.cargo/credentials"],
      ["~/.vault-token", "your Vault token in ~/.vault-token"],
      ["~/.config/op", "your 1Password CLI accounts in ~/.config/op"],
      // The programs the user runs, in the home directory and in the system.
      ["~/.local/bin/some-tool", "the programs you run in ~/.local/bin"],
      ["~/.local", "the programs you run in ~/.local, which holds ~/.local/bin"],
      ["~/.npm/_npx", "the packages npx runs in ~/.npm"],
      ["~/.nvm/versions/node/v22.0.0/bin", "the programs nvm installs in ~/.nvm"],
      ["~/go", "the programs Go installs in ~/go, which holds ~/go/bin"],
      ["~/Library/pnpm", "the programs pnpm installs in ~/Library/pnpm"],
      ["~/Applications/Some.app", "your applications in ~/Applications"],
      ["/usr/local/bin/some-tool", "the programs you run in /usr/local"],
      ["/usr", "the system's programs in /usr, which holds /usr/bin"],
      ["/opt", "the programs Homebrew installs in /opt, which holds /opt/homebrew"],
      ["/opt/homebrew/bin", "the programs Homebrew installs in /opt/homebrew"],
      ["/Applications/Some.app", "your applications in /Applications"],
      ["/Library/LaunchDaemons", "the programs and settings of every user in /Library"],
      // More Docker sockets.
      ["~/.rd/docker.sock", "the Docker socket of Rancher Desktop in ~/.rd"],
      ["~/.lima/default/sock/docker.sock", "the Docker socket of Lima in ~/.lima"],
      ["~/Library/Containers/com.docker.docker/Data/docker.raw.sock", "the Docker socket of Docker Desktop in ~/Library/Containers/com.docker.docker"],
    ];
    for (const [path, reason] of table) expect(sensitivePath(path, mac), path).toBe(reason);
    // Other projects in the home directory stay ordinary.
    for (const path of ["~/Projects/notes", "~/Documents/notes", "~/.cursor-old", "~/.zshrc.bak", "~/binaries", "~/Library/Application Support/Notes"]) {
      expect(sensitivePath(path, mac), path).toBeUndefined();
    }
  });

  it("knows where Linux and Windows keep the same things, and the places of each system only there", () => {
    const linux = { home: "/home/me", platform: "linux" as const };
    expect(sensitivePath("/home/me/.config/Code/User/mcp.json", linux)).toBe("the MCP servers and settings of VS Code in ~/.config/Code");
    expect(sensitivePath("/home/me/.config/Cursor", linux)).toBe("the MCP servers and settings of Cursor in ~/.config/Cursor");
    expect(sensitivePath("/home/me/.config/autostart/tool.desktop", linux)).toBe("the programs that start at login in ~/.config/autostart");
    expect(sensitivePath("/home/me/.config/systemd/user", linux)).toBe("your systemd services in ~/.config/systemd");
    expect(sensitivePath("/home/me/.local/share/pnpm", linux)).toBe("the programs pnpm installs in ~/.local/share/pnpm");
    expect(sensitivePath("/run/user/1000/podman/podman.sock", linux)).toBe("the Docker and Podman sockets in /run");
    // The macOS places are ordinary on Linux.
    for (const path of ["/home/me/Library/LaunchAgents", "/home/me/Library/Application Support/Claude", "/Applications"]) expect(sensitivePath(path, linux), path).toBeUndefined();

    const windows = { home: "C:\\Users\\me", platform: "win32" as const };
    expect(sensitivePath("C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json", windows)).toBe("the MCP servers and settings of Claude Desktop in ~\\AppData\\Roaming\\Claude");
    expect(sensitivePath("c:/users/me/appdata/roaming/code - insiders", windows)).toBe("the MCP servers and settings of VS Code Insiders in ~\\AppData\\Roaming\\Code - Insiders");
    expect(sensitivePath("C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\tool.lnk", windows)).toBe(
      "the programs that start at login in ~\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    );
    expect(sensitivePath("C:\\Users\\me\\AppData", windows)).toBe("the MCP servers and settings of Claude Desktop in ~\\AppData, which holds ~\\AppData\\Roaming\\Claude");
    expect(sensitivePath("C:\\Users\\me\\.cursor\\mcp.json", windows)).toBe("the MCP servers, settings and extensions of Cursor in ~\\.cursor");
    expect(sensitivePath("C:\\Users\\me\\Projects\\notes\\.git\\hooks", windows)).toBe("the git configuration and hooks of ~\\Projects\\notes, which can make your machine run commands");
    expect(sensitivePath("C:\\Users\\me\\Projects\\notes", windows)).toBeUndefined();
  });

  it("counts every directory on the PATH it is given, and skips empty and relative entries", () => {
    const options = { ...mac, path: ["/opt/tools/bin", "", "relative/bin", "~/.dotnet/tools", "/Users/me/sdk/bin/"].join(":") };
    expect(sensitivePath("/opt/tools/bin", options)).toBe("the programs on your PATH in /opt/tools/bin");
    expect(sensitivePath("/opt/tools/bin/tool", options)).toBe("the programs on your PATH in /opt/tools/bin");
    expect(sensitivePath("/opt/tools", options)).toBe("the programs on your PATH in /opt/tools, which holds /opt/tools/bin");
    expect(sensitivePath("/Users/me/sdk/bin/cc", options)).toBe("the programs on your PATH in ~/sdk/bin");
    expect(sensitivePath("/opt/tools/lib", options)).toBeUndefined();
    // A relative entry names no directory of its own: neither the one under the current directory nor ~/.dotnet/tools.
    expect(sensitivePath(resolve("relative", "bin"), options)).toBeUndefined();
    expect(sensitivePath("/Users/me/.dotnet/tools", options)).toBeUndefined();
    // Without a PATH, the same directory is ordinary.
    expect(sensitivePath("/opt/tools/bin", mac)).toBeUndefined();
    // The disk and the home directory on the PATH count as themselves, and make nothing below them count.
    const broad = { ...mac, path: "/:/Users/me:/Users" };
    expect(sensitivePath("/Users/me", broad)).toBe("your whole home directory");
    for (const path of ["/Users/me/Projects/notes", "/srv/data"]) expect(sensitivePath(path, broad), path).toBeUndefined();
  });

  it("leaves out the node_modules/.bin that npm exec and npx put on the PATH, and keeps a project's other directories on it", () => {
    const project = "/Users/me/Projects/notes";
    const npx = { ...mac, path: [`${project}/node_modules/.bin`, "/Users/me/Projects/node_modules/.bin", "/Users/me/node_modules/.bin", "/node_modules/.bin", "/usr/bin"].join(":") };
    for (const path of [project, `${project}/node_modules`, "/Users/me/Projects"]) expect(sensitivePath(path, npx), path).toBeUndefined();
    // Any case on macOS, as the system reads it.
    expect(sensitivePath(project, { ...mac, path: `${project}/Node_Modules/.BIN` })).toBeUndefined();
    // A project's own bin directory on the PATH still counts, and so does the project that holds it.
    const own = { ...npx, path: `${npx.path}:${project}/bin` };
    expect(sensitivePath(project, own)).toBe("the programs on your PATH in ~/Projects/notes, which holds ~/Projects/notes/bin");
    expect(sensitivePath(`${project}/bin/tool`, own)).toBe("the programs on your PATH in ~/Projects/notes/bin");
    // Linux minds the case: there a Node_Modules/.BIN is an ordinary directory on the PATH.
    const linux = { home: "/home/me", platform: "linux" as const, path: "/home/me/p/Node_Modules/.BIN" };
    expect(sensitivePath("/home/me/p", linux)).toBe("the programs on your PATH in ~/p, which holds ~/p/Node_Modules/.BIN");
    // On Windows too, with its own separators.
    const windows = { home: "C:\\Users\\me", platform: "win32" as const, path: "C:\\Users\\me\\p\\node_modules\\.bin;C:\\Users\\me\\p\\bin" };
    expect(sensitivePath("C:\\Users\\me\\p\\node_modules", windows)).toBeUndefined();
    expect(sensitivePath("C:\\Users\\me\\p\\bin", windows)).toBe("the programs on your PATH in ~\\p\\bin");
  });

  it("counts a repository's .git and a project's editor and agent settings at any depth, and not the project", () => {
    const project = "/Users/me/Projects/notes";
    const git = "the git configuration and hooks of ~/Projects/notes, which can make your machine run commands";
    for (const path of [`${project}/.git`, `${project}/.git/hooks`, `${project}/.git/config`, `${project}/.GIT/hooks/`]) expect(sensitivePath(path, mac), path).toBe(git);
    expect(sensitivePath("/srv/repo/.git/hooks/pre-commit", mac)).toBe("the git configuration and hooks of /srv/repo, which can make your machine run commands");
    expect(sensitivePath(`${project}/.vscode`, mac)).toBe("the settings VS Code loads when it opens ~/Projects/notes");
    expect(sensitivePath(`${project}/.vscode/settings.json`, mac)).toBe("the settings VS Code loads when it opens ~/Projects/notes");
    expect(sensitivePath(`${project}/.claude/settings.json`, mac)).toBe("the settings Claude Code loads when it opens ~/Projects/notes");
    expect(sensitivePath(`${project}/.idea`, mac)).toBe("the settings a JetBrains IDE loads when it opens ~/Projects/notes");
    expect(sensitivePath(`${project}/.mcp.json`, mac)).toBe("the MCP servers Claude Code starts when it opens ~/Projects/notes");
    // The project that holds them is where a filesystem server is meant to work.
    for (const path of [project, `${project}/src`, `${project}/.github`, `${project}/.github/workflows`, `${project}/.gitignore`, `${project}/.vscode-old`, `${project}/.mcp.json.bak`]) {
      expect(sensitivePath(path, mac), path).toBeUndefined();
    }
    // Linux minds the case: .GIT there is just a directory.
    expect(sensitivePath("/home/me/p/.GIT", { home: "/home/me", platform: "linux" })).toBeUndefined();
    expect(sensitivePath("/home/me/p/.git", { home: "/home/me", platform: "linux" })).toBe("the git configuration and hooks of ~/p, which can make your machine run commands");
  });

  it("follows symlinks into a .git directory too", () => {
    const top = mkdtempSync(join(tmpdir(), "mcpcage-sensitive-"));
    const home = join(top, "home");
    mkdirSync(join(home, "repo", ".git", "hooks"), { recursive: true });
    mkdirSync(join(home, "links"));
    symlinkSync(join(home, "repo", ".git", "hooks"), join(home, "links", "hooks"));
    const options = { home, platform: process.platform };
    expect(sensitivePath(join(home, "links", "hooks"), options)).toBe("the git configuration and hooks of ~/repo, which can make your machine run commands");
    expect(sensitivePath(join(home, "links"), options)).toBeUndefined();
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
