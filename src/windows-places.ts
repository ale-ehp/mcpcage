import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { win32 } from "node:path";

/*
 * Windows' own places: the variables Windows sets for every program from its registry, which say
 * where Windows is (SystemRoot, windir, SystemDrive), where programs and their shared files are
 * installed (ProgramFiles and the like), where the machine's and the user's settings are
 * (ProgramData, ALLUSERSPROFILE, APPDATA, LOCALAPPDATA, HOMEDRIVE and HOMEPATH), the temporary
 * directory (TEMP, TMP), which files are programs (PATHEXT) and which shell runs a command line
 * (ComSpec). The programs mcpcage runs on the host find code and settings through them: docker.exe
 * loads its plugins from %ProgramData%\Docker\cli-plugins and %ProgramFiles%\Docker\cli-plugins
 * (`docker build` is its buildx plugin), and from Docker\cli-plugins in the current directory when
 * ProgramData is not set; node loads Windows' rsaenh.dll from %SystemRoot%\System32 as it starts;
 * npm takes its global settings from under %APPDATA%\npm (the npmrc Node's installer writes says
 * prefix=${APPDATA}\npm) and keeps its cache in %LOCALAPPDATA%. Checked on Windows 10 with Docker
 * Desktop 4.49 (docker 28.5.1), Node 24.15 and npm 11. USERPROFILE, the home directory, is one of
 * them too, and has its own rules (see HOST_ENV in config.ts). Names are compared without case, as
 * Windows compares them.
 */
export const WINDOWS_PLACES: readonly string[] = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "ProgramData",
  "ALLUSERSPROFILE",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "HOMEDRIVE",
  "HOMEPATH",
];


/** What mcpcage sets in the environment of the programs it runs on Windows (see windowsEnv): Windows' places, the home directory, and the switch that keeps the current directory out of a program's search. */
export const WINDOWS_ENV: readonly string[] = [...WINDOWS_PLACES, "USERPROFILE", "HOME", "NoDefaultCurrentDirectoryInExePath"];

/** Where mcpcage asks for Windows' places, rather than its own environment (see windowsEnv). */
export interface WindowsSources {
  /** Windows' own directory, such as C:\Windows. */
  windows: string;
  /** The account's home directory, under the Users folder. */
  home: string;
  /** What `reg query <key>` prints, or undefined when the key could not be read. */
  registry: (key: string) => string | undefined;
}

/** The registry keys Windows makes those variables from, for every program it starts. */
const PROGRAMS_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion";
const FOLDERS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

/**
 * The environment variables mcpcage gives, on Windows, the programs it runs on the host, in place of
 * its own: docker, the npm that packs a local package, and the node that runs npm. mcpcage's
 * environment is the client's, plus the entry's `env`, and so is not to be trusted where docker,
 * npm and node find code and settings: an entry's ProgramData made `docker build` run the entry's
 * docker-buildx.exe, and the MCP SDK's client, which leaves ProgramData out, made docker look for its
 * plugins in Docker\cli-plugins of the current directory, a cloned repository's. So each of Windows'
 * places (see WINDOWS_PLACES) comes from Windows: SystemRoot and windir are its own directory,
 * SystemDrive its drive, ComSpec the cmd.exe there and ProgramData the ProgramData of that drive;
 * the program folders come from the registry key Windows makes them from (HKLM, which only an
 * administrator can change), APPDATA and LOCALAPPDATA from the user's shell folders, which folder
 * redirection can move, the temporary directory is LOCALAPPDATA's Temp, and the home directory,
 * USERPROFILE and HOME, is the account's. PATHEXT is the four extensions Windows starts
 * programs with, and NoDefaultCurrentDirectoryInExePath keeps the current directory out of the
 * search for a program by name, which cmd.exe and Go's exec.LookPath, in docker and its credential
 * helpers, otherwise make first. A value the registry does not give, or gives as anything but a full
 * path on a drive once SystemDrive, SystemRoot, windir and USERPROFILE in it are filled in, is where
 * Windows puts it by default: never empty, never relative.
 */
export function windowsEnv(sources: WindowsSources): Record<string, string | undefined> {
  const { windows, home } = sources;
  const drive = /^[A-Za-z]:/.exec(windows)?.[0] ?? "C:";
  const known: Record<string, string> = { SYSTEMDRIVE: drive, SYSTEMROOT: windows, WINDIR: windows, USERPROFILE: home };
  const read = (key: string) => {
    const values = new Map<string, string>();
    for (const line of (sources.registry(key) ?? "").split(/\r?\n/)) {
      const found = /^ {4}(.+?) {4}REG_(?:EXPAND_)?SZ {4}(.*)$/.exec(line);
      if (found !== null) values.set(found[1]!, found[2]!);
    }
    return (name: string, otherwise: string) => {
      let whole = true;
      const value = (values.get(name) ?? "").replace(/%([^%]*)%/g, (variable, inner: string) => {
        const filled = known[inner.toUpperCase()];
        if (filled === undefined) whole = false;
        return filled ?? variable;
      });
      return whole && FULL_PATH.test(value) ? value : otherwise;
    };
  };
  const programs = read(PROGRAMS_KEY);
  const programFiles = programs("ProgramFilesDir", `${drive}\\Program Files`);
  const programFiles86 = programs("ProgramFilesDir (x86)", `${drive}\\Program Files (x86)`);
  const common = programs("CommonFilesDir", win32.join(programFiles, "Common Files"));
  // Where Windows puts it, on its own drive: Windows does not support moving it elsewhere.
  const programData = `${drive}\\ProgramData`;
  const folders = read(FOLDERS_KEY);
  const localAppData = folders("Local AppData", win32.join(home, "AppData", "Local"));
  const temp = win32.join(localAppData, "Temp");
  const homeDrive = /^([A-Za-z]:)(\\.*)$/.exec(home);
  return {
    SystemRoot: windows,
    windir: windows,
    SystemDrive: drive,
    ComSpec: win32.join(windows, "System32", "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ProgramData: programData,
    ALLUSERSPROFILE: programData,
    ProgramFiles: programFiles,
    "ProgramFiles(x86)": programFiles86,
    ProgramW6432: programs("ProgramW6432Dir", programFiles),
    CommonProgramFiles: common,
    "CommonProgramFiles(x86)": programs("CommonFilesDir (x86)", win32.join(programFiles86, "Common Files")),
    CommonProgramW6432: programs("CommonW6432Dir", common),
    APPDATA: folders("AppData", win32.join(home, "AppData", "Roaming")),
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    // Only for a home directory on a drive; none is better than one made up.
    HOMEDRIVE: homeDrive?.[1],
    HOMEPATH: homeDrive?.[2],
    USERPROFILE: home,
    HOME: home,
    NoDefaultCurrentDirectoryInExePath: "1",
  };
}

/** A full path on a drive, as Windows' places are: no variable left to fill in, nothing that was not read whole. */
const FULL_PATH = /^[A-Za-z]:\\[^%"*<>?|\u0000-\u001f\uFFFD]*$/;

/**
 * Where Windows' places are on this machine, from Windows itself: its own directory as the object
 * manager names it (\SystemRoot, a link Windows makes as it starts: no variable is read), the
 * account's home directory from the system (os.userInfo, from the account, not from USERPROFILE),
 * and the registry, read by the reg.exe in that directory's System32, with no environment, from
 * that directory, so that nothing of mcpcage's environment or of the client's directory reaches it.
 * Checked on Windows 10: \SystemRoot is C:\Windows, and os.userInfo().homedir stayed the account's
 * with USERPROFILE set elsewhere. Each reg query took 30 to 150 ms, about a fifth of what
 * `docker version` takes there.
 */
export function windowsSources(): WindowsSources {
  let windows = "C:\\Windows";
  try {
    const found = realpathSync.native("\\\\?\\GLOBALROOT\\SystemRoot");
    if (/^[A-Za-z]:\\/.test(found)) windows = found;
  } catch {
    // Not on Windows, where only the tests ask: Windows' own default.
  }
  const reg = win32.join(windows, "System32", "reg.exe");
  return {
    windows,
    home: userInfo().homedir,
    registry: (key) => {
      const listed = spawnSync(reg, ["query", key, "/reg:64"], { encoding: "utf8", env: {}, cwd: windows, windowsHide: true, timeout: 10_000 });
      return listed.status === 0 ? listed.stdout : undefined;
    },
  };
}
