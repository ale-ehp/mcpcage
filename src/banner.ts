/*
 * The banner at the start of the commands a person runs at a terminal and reads: mcpcage alone,
 * help, doctor and protect. Never anywhere else: the stdout of `run` is the MCP channel, on which
 * nothing but the server's JSON-RPC may ever be written, and the output of the other commands is read
 * by programs and scripts as much as by people.
 */

const ART = [
  "███╗   ███╗ ██████╗██████╗  ██████╗ █████╗  ██████╗ ███████╗",
  "████╗ ████║██╔════╝██╔══██╗██╔════╝██╔══██╗██╔════╝ ██╔════╝",
  "██╔████╔██║██║     ██████╔╝██║     ███████║██║  ███╗█████╗",
  "██║╚██╔╝██║██║     ██╔═══╝ ██║     ██╔══██║██║   ██║██╔══╝",
  "██║ ╚═╝ ██║╚██████╗██║     ╚██████╗██║  ██║╚██████╔╝███████╗",
  "╚═╝     ╚═╝ ╚═════╝╚═╝      ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

/** The widest line of the banner, plus a column on each side: a narrower terminal would wrap it. */
const MIN_COLUMNS = 62;

/** The commands that print it, as main() reads them: no command at all, help, doctor and protect. */
const INTERACTIVE: ReadonlySet<string | undefined> = new Set([undefined, "help", "--help", "-h", "doctor", "protect"]);

/**
 * The banner for `command`, or undefined when it has none: only when stdout is a terminal (a TTY),
 * never when it is a pipe, a file or a CI log, and only the version line in a terminal narrower than
 * the banner. Plain text, no color: NO_COLOR has nothing to turn off.
 */
export function banner(command: string | undefined, stdout: { isTTY?: boolean; columns?: number }, version: string): string | undefined {
  if (!INTERACTIVE.has(command) || stdout.isTTY !== true) return undefined;
  const line = ` mcpcage ${version}  ·  MCP servers in a cage`;
  return stdout.columns !== undefined && stdout.columns < MIN_COLUMNS ? line : [...ART, line].join("\n");
}
