import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/*
 * The paths mcpcage will not mount into a cage. A server that can reach the whole disk, the home
 * directory, the system configuration, a Docker socket or the places where other tools keep their
 * keys and tokens is not isolated any more, whatever else the cage closes; one that can reach
 * mcpcage's own pins and audit logs can approve its own tools and erase what it did. `wrap` and
 * `protect --fix` leave such a server as it is and say why, `run` refuses such a --mount unless
 * --allow-sensitive-mount is given, and `protect` names the path in its report.
 */

export interface SensitiveOptions {
  /** The user's home directory: what `~` stands for, and where most credentials are kept. */
  home: string;
  /** Path syntax (`C:\` on Windows), case (ignored on macOS and Windows), and the macOS keychains. */
  platform: NodeJS.Platform;
  /** mcpcage's own directory, when MCPCAGE_HOME moves it out of ~/.mcpcage. */
  cage?: string;
}

/** Where other tools keep keys, tokens and sockets, from the home directory, in plain words. */
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
];

/** Outside the home directory, on macOS and Linux. /private is where macOS really keeps /etc and /var. */
const SYSTEM: ReadonlyArray<{ path: string; what: string }> = [
  { path: "/etc", what: "the system configuration" },
  { path: "/private/etc", what: "the system configuration" },
  { path: "/var/run", what: "the Docker socket" },
  { path: "/private/var/run", what: "the Docker socket" },
];

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
 * above: /etc, /var/run, the credentials in the home directory, mcpcage's own directory. Inside the
 * home directory only those places count: ~/Projects/x is ordinary, ~/.config holds gcloud's
 * credentials. `~` stands for the home directory and `..` is resolved; so are symlinks, for a path
 * of this machine, which makes a link that leads into ~/.ssh count as ~/.ssh. Case does not matter
 * on macOS and Windows.
 */
export function sensitivePath(path: string, options: SensitiveOptions): string | undefined {
  const windows = options.platform === "win32";
  const darwin = options.platform === "darwin";
  const syntax = windows ? win32 : posix;
  const missing = new Set<string>();
  const spell = (text: string): Spelling[] =>
    spellings(text, syntax, darwin, missing).map((spelling) => ({ path: spelling, key: windows || darwin ? spelling.toLowerCase() : spelling }));
  // `C:` alone is read as the root of drive C, as the report always did.
  const written = windows && /^[A-Za-z]:$/.test(path) ? `${path}\\` : expandTilde(path, options.home, windows);
  if (!syntax.isAbsolute(written)) return undefined;
  const targets = spell(written);
  const homes = syntax.isAbsolute(options.home) ? spell(options.home) : [];
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

  if (any((target) => syntax.parse(target.path).root === target.path)) return "the whole disk";
  if (any((target) => homes.some((home) => home.key === target.key))) return "your whole home directory";
  const allHomes = windows ? [] : ALL_HOMES.flatMap((where) => spell(where));
  const holdsHomes = (target: Spelling) =>
    homes.some((home) => inside(home, target)) || allHomes.some((all) => all.key === target.key) || (windows && /^[a-z]:\\users$/.test(target.key));
  if (any(holdsHomes)) return "your whole home directory and more";
  if (!windows && any((target) => target.key === "/root")) return "the home directory of the root user";

  const places: Place[] = [];
  if (!windows) for (const place of SYSTEM) places.push({ spellings: spell(place.path), what: place.what, shown: place.path });
  if (homes.length > 0) {
    for (const place of IN_HOME) {
      if (place.platform !== undefined && place.platform !== options.platform) continue;
      const parts = place.path.split("/");
      places.push({ spellings: spell(syntax.join(options.home, ...parts)), what: place.what, shown: ["~", ...parts].join(syntax.sep) });
    }
  }
  if (options.cage !== undefined && syntax.isAbsolute(options.cage)) {
    const cage = spell(options.cage);
    places.push({ spellings: cage, what: "mcpcage's own pins and audit logs", shown: shown(cage[0]!) });
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
