import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";
import { CLIENT_NAMES, userConfigs } from "./clients.js";
import { cageHome } from "./paths.js";

/*
 * The paths mcpcage will not mount into a cage. A server that can reach the whole disk, the home
 * directory, the system configuration, a Docker socket or the places where other tools keep their
 * keys and tokens is not isolated any more, whatever else the cage closes; one that can reach
 * mcpcage's own pins and audit logs can approve its own tools and erase what it did. One that can
 * write where the user's machine finds commands to run (the configurations of other MCP clients,
 * the shell's startup files, git's configuration and hooks, the programs on the PATH) gets out of
 * the cage the next time the user, or a client, runs one. `wrap` and `protect --fix` leave such a
 * server as it is and say why, `run` refuses such a --mount unless --allow-sensitive-mount is given,
 * and `protect` names the path in its report.
 */

export interface SensitiveOptions {
  /** The user's home directory: what `~` stands for, and where most credentials are kept. */
  home: string;
  /**
   * The account's own home directory, from the system's user database, when it may differ from
   * `home`: its places count as well, though `~` stays `home`. HOME is only a variable, and whoever
   * starts mcpcage sets it.
   */
  account?: string;
  /** Path syntax (`C:\` on Windows), case (ignored on macOS and Windows), and the macOS keychains. */
  platform: NodeJS.Platform;
  /** mcpcage's own directory, when MCPCAGE_HOME moves it out of ~/.mcpcage. */
  cage?: string;
  /** The PATH, as process.env.PATH writes it: each of its directories holds programs the user runs. */
  path?: string;
  /**
   * Other clients' configuration files and directories where the environment puts them, which may
   * be outside the places below (see clientPlaces). Each counts with all it holds.
   */
  clients?: ReadonlyArray<{ path: string; what: string }>;
}

/**
 * The account's own home directory. `os.homedir()` follows HOME (USERPROFILE on Windows), which a
 * client sets for mcpcage from a server entry's `env`: with HOME pointed at an empty directory, the
 * real ~/.ssh was an ordinary path. The user database says where the account's home is, whatever
 * HOME says; an account it does not know (some containers) falls back to HOME.
 */
export function accountHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

/**
 * The options for a path of this machine, as `run` and `wrap` check it: `~` is HOME, the account's
 * home counts too, and so do the client configurations `protect` finds with this environment.
 */
export function thisMachine(): SensitiveOptions {
  const home = homedir();
  return {
    home,
    account: accountHome(),
    platform: process.platform,
    cage: cageHome(),
    path: process.env.PATH,
    clients: clientPlaces({ platform: process.platform, home, env: process.env }),
  };
}

/**
 * The clients' user configurations, where `protect` finds them with this environment (see
 * userConfigs): each file, and the client's own directory when the file is in one. The places in
 * the home directory below are only where the clients keep them by default: VS Code under an
 * absolute XDG_CONFIG_HOME on Linux, GitHub Copilot under COPILOT_HOME and the Windows clients
 * under another APPDATA were ordinary paths, mounted writable by `wrap`.
 */
export function clientPlaces(options: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv }): Array<{ path: string; what: string }> {
  return userConfigs(options).flatMap((config) => {
    const what = settingsOf(CLIENT_NAMES[config.client]);
    return config.dir === undefined ? [{ path: config.file, what }] : [{ path: config.dir, what }, { path: config.file, what }];
  });
}

/** What other MCP clients keep in their directories, and why a cage must not write there. */
const settingsOf = (client: string) => `the MCP servers and settings of ${client}`;
const SHELL = "the commands your shell runs";
const AT_LOGIN = "the programs that start at login";

/** Where other tools keep keys, tokens, sockets and what they run, from the home directory, in plain words. */
const IN_HOME: ReadonlyArray<{ path: string; what: string; platform?: NodeJS.Platform }> = [
  { path: ".ssh", what: "your SSH keys" },
  { path: ".aws", what: "your AWS credentials" },
  { path: ".gnupg", what: "your GnuPG keys" },
  { path: ".kube", what: "your Kubernetes credentials" },
  { path: ".docker", what: "your Docker credentials" },
  { path: ".config/gcloud", what: "your Google Cloud credentials" },
  { path: ".azure", what: "your Azure credentials" },
  { path: ".npmrc", what: "your npm token" },
  { path: ".netrc", what: "your saved logins" },
  { path: ".git-credentials", what: "your Git credentials" },
  { path: ".password-store", what: "your passwords" },
  { path: "Library/Keychains", what: "your keychains", platform: "darwin" },
  // Colima and OrbStack, which the README names next to Docker Desktop, keep the Docker socket here.
  { path: ".colima", what: "the Docker socket of Colima" },
  { path: ".orbstack", what: "the Docker socket of OrbStack" },
  { path: ".mcpcage", what: "mcpcage's own pins and audit logs" },
  { path: ".claude.json", what: "your MCP configurations and their tokens" },

  // Other clients' MCP and agent configurations: they hold the tokens of other servers and decide
  // which servers start, uncaged. A server that can write there adds one of its own, which runs on
  // the host at the client's next start; one that can read there takes the other servers' tokens.
  // ~/.vscode and ~/.cursor also hold the editors' extensions, which are code the editor runs.
  { path: ".cursor", what: "the MCP servers, settings and extensions of Cursor" },
  { path: ".vscode", what: "the settings and extensions of VS Code" },
  { path: ".vscode-insiders", what: "the settings and extensions of VS Code Insiders" },
  { path: ".claude", what: "the settings and hooks of Claude Code" },
  { path: ".codeium", what: settingsOf("Windsurf") },
  { path: ".copilot", what: settingsOf("GitHub Copilot") },
  { path: ".config/devin", what: settingsOf("Devin") },
  { path: ".gemini", what: settingsOf("Gemini CLI") },
  { path: ".codex", what: settingsOf("Codex") },
  { path: ".continue", what: settingsOf("Continue") },
  { path: ".config/zed", what: settingsOf("Zed") },
  { path: "Library/Application Support/Claude", what: settingsOf("Claude Desktop"), platform: "darwin" },
  { path: "Library/Application Support/Code", what: settingsOf("VS Code"), platform: "darwin" },
  { path: "Library/Application Support/Code - Insiders", what: settingsOf("VS Code Insiders"), platform: "darwin" },
  { path: "Library/Application Support/Cursor", what: settingsOf("Cursor"), platform: "darwin" },
  { path: "Library/Application Support/Windsurf", what: settingsOf("Windsurf"), platform: "darwin" },
  { path: "Library/Application Support/Zed", what: settingsOf("Zed"), platform: "darwin" },
  { path: ".config/Code", what: settingsOf("VS Code"), platform: "linux" },
  { path: ".config/Code - Insiders", what: settingsOf("VS Code Insiders"), platform: "linux" },
  { path: ".config/Cursor", what: settingsOf("Cursor"), platform: "linux" },
  { path: ".config/Windsurf", what: settingsOf("Windsurf"), platform: "linux" },
  { path: "AppData/Roaming/Claude", what: settingsOf("Claude Desktop"), platform: "win32" },
  { path: "AppData/Roaming/Code", what: settingsOf("VS Code"), platform: "win32" },
  { path: "AppData/Roaming/Code - Insiders", what: settingsOf("VS Code Insiders"), platform: "win32" },
  { path: "AppData/Roaming/Cursor", what: settingsOf("Cursor"), platform: "win32" },
  { path: "AppData/Roaming/devin", what: settingsOf("Devin"), platform: "win32" },

  // What runs when a shell or a session starts: a line added there runs as the user, outside any
  // cage, the next time a terminal opens or the user logs in.
  ...[".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".config/fish", ".oh-my-zsh"].map(
    (path) => ({ path, what: SHELL }),
  ),
  { path: "Library/LaunchAgents", what: AT_LOGIN, platform: "darwin" },
  { path: ".config/autostart", what: AT_LOGIN, platform: "linux" },
  { path: ".config/systemd", what: "your systemd services", platform: "linux" },
  { path: "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup", what: AT_LOGIN, platform: "win32" },

  // Git's own configuration, which can name commands git runs (a hooks directory, an fsmonitor, a
  // pager, aliases) in every repository of the user.
  { path: ".gitconfig", what: "your Git configuration" },
  { path: ".config/git", what: "your Git configuration" },

  // More credentials: tokens that publish packages, reach GitHub and the cloud, or open the vaults.
  { path: ".config/gh", what: "your GitHub CLI token" },
  { path: ".config/hub", what: "your GitHub token" },
  { path: ".pypirc", what: "your PyPI token" },
  { path: ".cargo/credentials", what: "your crates.io token" },
  { path: ".cargo/credentials.toml", what: "your crates.io token" },
  { path: ".gem/credentials", what: "your RubyGems token" },
  { path: ".terraform.d", what: "your Terraform tokens" },
  { path: ".vault-token", what: "your Vault token" },
  { path: ".boto", what: "your cloud storage credentials" },
  { path: ".s3cfg", what: "your S3 credentials" },
  { path: ".yarnrc.yml", what: "your Yarn token" },
  { path: ".config/op", what: "your 1Password CLI accounts" },

  // The programs the user runs and the places that install them: a writable copy is a way to
  // replace a program the user, or a client, starts later on the host. ~/.npm is where npx keeps
  // the packages it runs.
  { path: ".local/bin", what: "the programs you run" },
  { path: "bin", what: "the programs you run" },
  { path: ".npm", what: "the packages npx runs" },
  { path: ".nvm", what: "the programs nvm installs" },
  { path: ".volta", what: "the programs Volta installs" },
  { path: ".bun", what: "the programs Bun installs" },
  { path: ".deno", what: "the programs Deno installs" },
  { path: ".cargo/bin", what: "the programs Cargo installs" },
  { path: "go/bin", what: "the programs Go installs" },
  { path: ".pyenv", what: "the programs pyenv installs" },
  { path: ".rbenv", what: "the programs rbenv installs" },
  { path: ".asdf", what: "the programs asdf installs" },
  { path: "Library/pnpm", what: "the programs pnpm installs", platform: "darwin" },
  { path: "Applications", what: "your applications", platform: "darwin" },
  { path: ".local/share/pnpm", what: "the programs pnpm installs", platform: "linux" },

  // More Docker sockets, which start containers with any part of the host mounted.
  { path: ".rd", what: "the Docker socket of Rancher Desktop" },
  { path: ".lima", what: "the Docker socket of Lima" },
  { path: "Library/Containers/com.docker.docker", what: "the Docker socket of Docker Desktop", platform: "darwin" },
];

/** Outside the home directory, on macOS and Linux. /private is where macOS really keeps /etc and /var. */
const SYSTEM: ReadonlyArray<{ path: string; what: string; platform?: NodeJS.Platform; unless?: NodeJS.Platform }> = [
  { path: "/etc", what: "the system configuration" },
  { path: "/private/etc", what: "the system configuration" },
  { path: "/var/run", what: "the Docker socket" },
  { path: "/private/var/run", what: "the Docker socket" },
  // The programs of the system and of the package managers, which every user runs: a writable copy
  // is a way to replace them. /usr/bin comes first, so that /usr is named for it.
  { path: "/usr/bin", what: "the system's programs" },
  { path: "/bin", what: "the system's programs" },
  { path: "/usr/sbin", what: "the system's programs" },
  { path: "/sbin", what: "the system's programs" },
  { path: "/usr/local", what: "the programs you run" },
  { path: "/opt/homebrew", what: "the programs Homebrew installs" },
  { path: "/Applications", what: "your applications", platform: "darwin" },
  { path: "/Library", what: "the programs and settings of every user", platform: "darwin" },
  // Rootless Docker and Podman keep their sockets under /run/user. macOS has no /run.
  { path: "/run", what: "the Docker and Podman sockets", unless: "darwin" },
];

/**
 * Directories that count wherever they are, by name: a repository's git configuration and hooks,
 * and the settings an editor or an agent loads from the project it opens, which can start servers
 * or run commands. Only the directory itself and what is inside it count: the project that holds
 * one is the place a filesystem server is given to work in.
 */
const BY_NAME = new Map<string, (project: string) => string>([
  [".git", (repo) => `the git configuration and hooks of ${repo}, which can make your machine run commands`],
  [".vscode", (project) => `the settings VS Code loads when it opens ${project}`],
  [".idea", (project) => `the settings a JetBrains IDE loads when it opens ${project}`],
  [".cursor", (project) => `the settings Cursor loads when it opens ${project}`],
  [".claude", (project) => `the settings Claude Code loads when it opens ${project}`],
  [".devin", (project) => `the settings Devin loads when it opens ${project}`],
  [".windsurf", (project) => `the settings Windsurf loads when it opens ${project}`],
  [".mcp.json", (project) => `the MCP servers Claude Code starts when it opens ${project}`],
]);

/** The directories that hold every user's home directory, on macOS and Linux. */
const ALL_HOMES = ["/Users", "/home"];

/** macOS shows its data volume at / as well: /System/Volumes/Data/Users is /Users, and no symlink says so. */
const DATA_VOLUME = "/system/volumes/data";

type Syntax = typeof posix;

/** A path as messages show it, and as it is compared: in lowercase where the system ignores case. */
interface Spelling {
  path: string;
  key: string;
}

/** A place that counts with all it holds. Its first spelling is as written, the others where symlinks lead. */
interface Place {
  spellings: Spelling[];
  what: string;
  shown: string;
}

/**
 * Plain words for what a path would open, or undefined for an ordinary path and for a relative one.
 * A path counts when it is the root of the disk, the home directory, a directory that holds it
 * (/Users, /home or another parent) or /root, and when it is, is inside or holds one of the places
 * above: /etc, /var/run, the system's programs, the credentials, client configurations, startup
 * files and programs in the home directory, mcpcage's own directory, a directory on the PATH, a
 * client configuration where the environment moves it. It also counts when it is, or is inside, a
 * directory named like those in BY_NAME, at any depth.
 * Inside the home directory only those places count: ~/Projects/x is ordinary, ~/.config holds
 * gcloud's credentials. `~` stands for the home directory and `..` is resolved; so are symlinks, for
 * a path of this machine, which makes a link that leads into ~/.ssh count as ~/.ssh. Case does not
 * matter on macOS and Windows. The account's home directory, when it is not `home`, counts like the
 * home directory, with its places written in full.
 */
export function sensitivePath(path: string, options: SensitiveOptions): string | undefined {
  const windows = options.platform === "win32";
  const darwin = options.platform === "darwin";
  const syntax = windows ? win32 : posix;
  const missing = new Set<string>();
  const fold = (text: string) => (windows || darwin ? text.toLowerCase() : text);
  const spell = (text: string): Spelling[] => spellings(text, syntax, darwin, missing).map((spelling) => ({ path: spelling, key: fold(spelling) }));
  // `C:` alone is read as the root of drive C, as the report always did.
  const written = windows && /^[A-Za-z]:$/.test(path) ? `${path}\\` : expandTilde(path, options.home, windows);
  if (!syntax.isAbsolute(written)) return undefined;
  const targets = spell(written);
  const homes = syntax.isAbsolute(options.home) ? spell(options.home) : [];
  // The account's home, when HOME names another directory: it holds the real keys whatever HOME says.
  const account = options.account !== undefined && syntax.isAbsolute(options.account) ? spell(options.account) : [];
  const other = account.some((spelling) => homes.some((home) => home.key === spelling.key)) ? [] : account;
  const mine = [...homes, ...other];
  const inside = (spelling: Spelling, dir: Spelling) =>
    spelling.key !== dir.key && spelling.key.startsWith(dir.key.endsWith(syntax.sep) ? dir.key : `${dir.key}${syntax.sep}`);
  const any = (test: (target: Spelling) => boolean) => targets.some(test);
  /** A path in the home directory, written from ~. */
  const shown = (spelling: Spelling) => {
    const home = homes.find((candidate) => candidate.key === spelling.key || inside(spelling, candidate));
    if (home === undefined) return spelling.path;
    const rest = spelling.path.slice(home.path.length);
    return rest === "" || rest.startsWith(syntax.sep) ? `~${rest}` : `~${syntax.sep}${rest}`;
  };

  const isDisk = (spelling: Spelling) => syntax.parse(spelling.path).root === spelling.path;
  const isHome = (spelling: Spelling) => mine.some((home) => home.key === spelling.key);
  const allHomes = windows ? [] : ALL_HOMES.flatMap((where) => spell(where));
  const holdsHomes = (spelling: Spelling) =>
    mine.some((home) => inside(home, spelling)) || allHomes.some((all) => all.key === spelling.key) || (windows && /^[a-z]:\\users$/.test(spelling.key));
  if (any(isDisk)) return "the whole disk";
  if (any(isHome)) return "your whole home directory";
  if (any(holdsHomes)) return "your whole home directory and more";
  if (!windows && any((target) => target.key === "/root")) return "the home directory of the root user";

  const places: Place[] = [];
  if (!windows) {
    for (const place of SYSTEM) {
      if ((place.platform !== undefined && place.platform !== options.platform) || place.unless === options.platform) continue;
      places.push({ spellings: spell(place.path), what: place.what, shown: place.path });
    }
  }
  for (const place of IN_HOME) {
    if (place.platform !== undefined && place.platform !== options.platform) continue;
    const parts = place.path.split("/");
    if (homes.length > 0) places.push({ spellings: spell(syntax.join(options.home, ...parts)), what: place.what, shown: ["~", ...parts].join(syntax.sep) });
    if (other.length > 0) {
      const spellings = spell(syntax.join(options.account!, ...parts));
      places.push({ spellings, what: place.what, shown: shown(spellings[0]!) });
    }
  }
  // Where the environment moves other clients' configurations. The home directory and what holds it
  // count already as themselves: COPILOT_HOME set to the home directory makes its file count, not
  // every path in the home directory.
  for (const client of options.clients ?? []) {
    if (!syntax.isAbsolute(client.path)) continue;
    const place = spell(client.path);
    if (place.some((spelling) => isDisk(spelling) || isHome(spelling) || holdsHomes(spelling))) continue;
    places.push({ spellings: place, what: client.what, shown: shown(place[0]!) });
  }
  if (options.cage !== undefined && syntax.isAbsolute(options.cage)) {
    const cage = spell(options.cage);
    places.push({ spellings: cage, what: "mcpcage's own pins and audit logs", shown: shown(cage[0]!) });
  }
  // Whatever installed them, the programs on the PATH are the ones the user and the clients start
  // by name. An empty or relative entry names no directory of its own. The disk, the home directory
  // and what holds it count already as themselves; below them a program on the PATH is an entry
  // right in the directory, and with ~ on the PATH, ~/Projects/x is none. A node_modules/.bin is left
  // out: npm exec and npx put one on the PATH for the current directory and for each of its parents,
  // whether it exists or not, so with it mcpcage started from a project would refuse that project
  // and leave its server uncaged. The programs there are a project's own dependencies, and a writable
  // project mount lets a server change code the user runs later anyway.
  for (const entry of new Set(options.path?.split(syntax.delimiter) ?? [])) {
    if (entry === "" || !syntax.isAbsolute(entry)) continue;
    const dir = spell(entry);
    if (dir.some((spelling) => isDisk(spelling) || isHome(spelling) || holdsHomes(spelling))) continue;
    if (fold(dir[0]!.path.split(syntax.sep).slice(-2).join("/")) === "node_modules/.bin") continue;
    places.push({ spellings: dir, what: "the programs on your PATH", shown: shown(dir[0]!) });
  }
  // Every place as written is tried before any place through its symlinks, so that a path gets the
  // same words on every machine: on macOS /var/run leads to /private/var/run, on Linux it does not.
  const levels = Math.max(0, ...places.map((place) => place.spellings.length));
  for (let level = 0; level < levels; level++) {
    for (const place of places) {
      const spot = place.spellings[level];
      if (spot === undefined) continue;
      for (const target of targets) {
        if (target.key === spot.key || inside(target, spot)) return `${place.what} in ${place.shown}`;
        if (inside(spot, target)) return `${place.what} in ${shown(target)}, which holds ${place.shown}`;
      }
    }
  }
  // By name, at any depth: the outermost such directory in the path, and the project that holds it.
  for (const target of targets) {
    const root = syntax.parse(target.path).root;
    const parts = target.path.slice(root.length).split(syntax.sep);
    const at = parts.findIndex((part) => BY_NAME.has(fold(part)));
    if (at === -1) continue;
    const project = `${root}${parts.slice(0, at).join(syntax.sep)}`;
    return BY_NAME.get(fold(parts[at]!))!(shown({ path: project, key: fold(project) }));
  }
  return undefined;
}

/**
 * The path with `..` and repeated or final separators resolved, then, for a path of this machine,
 * where its symlinks lead, and on macOS the same path without the data volume in front.
 */
function spellings(path: string, syntax: Syntax, darwin: boolean, missing: Set<string>): string[] {
  const found = [tidy(syntax.normalize(path), syntax)];
  const real = realPath(path, syntax, missing);
  if (real !== undefined) found.push(tidy(real, syntax));
  if (darwin) {
    for (const spelling of [...found]) {
      const lower = spelling.toLowerCase();
      if (lower === DATA_VOLUME || lower.startsWith(`${DATA_VOLUME}/`)) found.push(spelling.slice(DATA_VOLUME.length) || "/");
    }
  }
  return [...new Set(found)];
}

/**
 * Where a path of this machine leads, with symlinks and `..` resolved by the system (which also
 * gives a name its real case on macOS). For a path that does not exist, its nearest existing parent
 * is resolved and the rest added back. `missing` keeps, for one check, what the system said does not
 * exist: what is inside it does not exist either, and is not asked about again.
 */
function realPath(path: string, syntax: Syntax, missing: Set<string>): string | undefined {
  // A Windows path names nothing on macOS or Linux, and the other way round.
  if ((syntax === win32) !== (process.platform === "win32")) return undefined;
  const rest: string[] = [];
  let current = path;
  for (;;) {
    const parent = syntax.dirname(current);
    // On macOS /home is an automount: every question about /home/<name> waits for the automounter,
    // and the credential places of a home directory that does not exist would ask a dozen times.
    if (missing.has(current) || missing.has(parent)) {
      missing.add(current);
    } else {
      try {
        return syntax.join(realpathSync.native(current), ...rest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.add(current);
      }
    }
    if (parent === current) return undefined;
    rest.unshift(syntax.basename(current));
    current = parent;
  }
}

/** Without a final separator, except for the root. */
function tidy(path: string, syntax: Syntax): string {
  const root = syntax.parse(path).root;
  let end = path.length;
  while (end > root.length && path.endsWith(syntax.sep, end)) end--;
  return path.slice(0, end);
}

/** `~`, `~/...` and, on Windows, `~\...` from the home directory. */
function expandTilde(path: string, home: string, windows: boolean): string {
  if (path === "~") return home;
  return path.startsWith("~/") || (windows && path.startsWith("~\\")) ? `${home}${path.slice(1)}` : path;
}
