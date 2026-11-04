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

