# Changelog

Notable changes to mcpcage. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-04

Hardening, second round. Independent reviews tried to break 0.4.0 from both sides: a server
talking to the proxy or writing in its mounts, and a client configuration entry that nobody meant
to write. Two more reviews then tried to break the fixes. Every change below closes something one
of them found.

### Changed

- `wrap` and `protect --fix` mount the paths a server is configured with read-only. Three review
  rounds each found another way for a server with a writable mount of a project to have the host
  run code (git hooks and configuration, editor settings, `.env` files a client loads), and no list
  of names to protect can be complete. `--writable` keeps the previous behavior, with a warning for
  each writable mount, and `protect` reports a writable mount as an opened cage.
- On macOS and Windows, a writable mount that holds a file setting (a `.git` file, `.mcp.json`)
  refuses to start: the server could rewrite it under another case of its name. An entry that
  0.4.0 caged with such a mount starts again once its `:rw` is dropped.
- mcpcage runs docker from the standard install places and npm from next to the node running it,
  each with a PATH of those places only, instead of the PATH a client was given.
- `protect` exits 1 when it could not check a configuration file, as it does for an uncaged server.
- The server's stderr reaches the client's log line by line, prefixed with `[<server-id>]`.
- `wrap` and `protect --fix` move some variables of an entry's `env` into the cage as
  `--env NAME=value` arguments (see Fixed), so their values show in the process list while the
  server runs; `unwrap` puts them back in `env`.
- Many more paths are never mounted (see Fixed): `wrap` and `--fix` may leave uncaged a server that
  0.4.0 caged, with the reason, and `run` refuses its `--mount` without `--allow-sensitive-mount`.
- Inside a writable mount, existing git and editor settings are mounted read-only and the
  directories that lead to them are held in place: a server can no longer rename those directories,
  and moving a file across them fails (EXDEV).
- `protect` counts an entry as caged only when it starts the mcpcage on your PATH (or the one that
  runs the report), and says when an entry's run options, its own `PATH` (any directory that is not
  on yours), its `envFile`, or a writable mount open the cage. `wrap` and `--fix` check the entry
  they write with the same rules and leave one that would not count as caged as it is.
- `mcpcage run` refuses a `--memory` or `--cpus` that is not positive, and a server id with other
  characters than letters, digits, dots, dashes and underscores.
- A definition approved by an earlier version with a `"__proto__"` key counts as changed once and
  needs a fresh approval, and an audit entry an earlier version wrote with such a key no longer
  verifies.

### Fixed

The proxy and the pin

- Names that every JavaScript object inherits fooled the pinning: what a definition held under a
  `"__proto__"` key was left out of its fingerprint, so hidden text added there passed as no change,
  and a `tools/call` for `constructor`, `toString` or `__proto__` reached the server although no tool
  of that name was approved. Every key now counts, and a call passes only for a tool approved under
  its own name.
- Trust on first use reached past the first listing: a server that had the client list again, or
  answered a cursor it never issued, replaced approved definitions. Only the first listing is trusted
  now, its first page and the pages asked for with the cursor each page returned, and none of them
  may redefine a tool pinned before.
- The limit of 10,000 tools held for one page only. It now holds for what is pinned and pending
  together, across pages, listings and approvals.
- Text a server controls reached the terminal raw: escape sequences in a tool's name could clear or
  rewrite what `mcpcage diff` shows before approval, and the server's stderr could print lines that
  read like mcpcage's own. Everything mcpcage prints from a server or a configuration spells out
  control and format characters as `[U+XXXX]`, long names and keys show a 200-character excerpt
  with their length, and the new-tool view shows every field the user approves.
- With a client that does not read mcpcage's stderr, log lines piled up in memory, and one long
  message went through whole. At most 1 MiB now waits; a message that does not fit is cut with its
  length or dropped, and the dropped lines are counted.
- The signs of hidden instructions missed the keys of a definition, anything but a plain URI or
  JSON pointer under `$schema`, `$id` and `$ref`, and the address, name, title and description of a
  `resource_link` or an embedded resource in a result.

The cage and its mounts

- `wrap`, `protect --fix` and `run --mount` reached places from which the machine later runs
  commands: other clients' MCP configurations (also where XDG_CONFIG_HOME, COPILOT_HOME or APPDATA
  move them), shell and login startup files, git's configuration and any repository's `.git`,
  project editor and agent settings, the programs on the PATH and where they are installed, and
  more Docker sockets. They are never mounted now, and the report names them.
- A writable mount of a project let a caged server change the project's `.git` and editor
  settings, from which git and editors run commands on the host as soon as the project is open, or
  rename the directory holding them and write new ones in its place, or change the repository a
  `.git` file points to. Existing settings are now mounted read-only, the directories leading to
  them are held in place, and a repository a `.git` file or `commondir` points to is followed and kept
  read-only; anything that cannot be kept so refuses the start.
- A server entry's `env` configured mcpcage itself once `wrap` or `--fix` routed it through mcpcage:
  NODE_OPTIONS or OPENSSL_CONF ran code on the host before the cage existed, DOCKER_HOST sent the cage
  to another daemon, a HOME pointed elsewhere turned the real `~/.ssh` into an ordinary path, and
  MCPCAGE_HOME moved the pins to an empty store. `NODE_*` (except `NODE_ENV`), `LD_*`, `DYLD_*`,
  `DOCKER_*` (except a local-socket `DOCKER_HOST`), `OPENSSL_*`, `GCONV_PATH`, `npm_config_*` and
  the shell's `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4`, `ZDOTDIR` and `BASH_FUNC_*` now move into
  the cage as `--env NAME=value`; HOME, USERPROFILE and MCPCAGE_HOME are dropped; the mount
  check counts the account's own home whatever HOME says; a relative MCPCAGE_HOME is made absolute.
- `protect --inspect` read a path argument ending in `:rw` as a mount option, so a directory named
  `~/.ssh:rw` got the real `~/.ssh` mounted writable, and it mounted sensitive paths for the listing.
  It now mounts each path argument read-only as written, never one that `wrap` refuses, and names in
  the report what a server was inspected without.
- An entry's `PATH` chose the docker mcpcage runs, the credential helpers docker runs and the npm
  that packs a local package, and a VS Code `envFile` could set any of the variables above unseen.
  docker and npm now come from trusted places, an entry's `PATH` counts only when it stays within
  yours, and `protect` reads an `envFile` like `env`.
- When a package declares several programs, the launcher in the image ran the first one where npx
  refuses to choose; it now chooses as npx does.
- `run --id` and the id given to `diff`, `approve`, `audit show` and `audit verify` were used as
  given, so `../../x` read and wrote outside mcpcage's store.

The report of `mcpcage protect`

- `protect` said "caged" for any command named `mcpcage`, a look-alike or one next to a package.json
  that claims the name included, for entries whose run options open the cage, and for entries whose
  own `PATH` makes the client start another `node`. An entry now counts as caged only when its
  command is the same file as the mcpcage `--fix` writes or the one running the report; a
  look-alike is caged by `--fix` and by `wrap`; opened cages and a `PATH` that picks other programs
  are named, one line each, and not counted as caged.
- One malformed entry or file stopped the whole report: an argument that is not a string, a value
  nested thousands of levels deep, a FIFO in a configuration's place or an `npm view` answer of an
  unexpected shape. Each now becomes a line of the report and the scan goes on; a file over 16 MiB
  is reported without being read.
- The report printed credentials it promises to keep out: the second value of a repeated query
  name, a SAS signature or an Azure Functions key, a real key containing `xxx` or `changeme`, an
  address behind `--url=`, a token used as the user name of an address, and values a server copied
  into its tools during `--inspect`, whole, cut up, spliced with invisible characters or printed on
  several lines. All are masked now.
- `protect` missed VS Code configurations under XDG_CONFIG_HOME on Linux and in named profiles.

`wrap`, `unwrap` and `--inspect`

- `wrap` and `unwrap` wrote the configuration straight over the live file, stopped at one malformed
  entry, and dropped an env variable named `__proto__`. They now replace the file atomically, leave a
  malformed entry as it is with the reason, and keep every variable.
- `protect --inspect` queued without bound the answers and requests for a server that does not
  read its input, and accepted a listing of any size over its pages. Nothing is added while 16 MiB
  wait to be sent, and a listing over 16 MiB in total is refused.

## [0.4.0] - 2026-11-04

Hardening. Every change below came out of trying to break mcpcage: hostile servers against the
proxy, abuse inside the cage, mounts that undo it, and a first CodeQL scan.

### Added

- `mcpcage run --allow-sensitive-mount` and `--allow-server-requests`, each printing a warning when
  used.
- The proxy reads every `tools/call` result with the hidden-instruction rules that make sense on free
  text, records the signs in the audit log (`result-signs`) and prints the high-severity ones. Results
  always pass unchanged.
- Docker tests that abuse the cage: writes outside the mounts, a file run from `/tmp`, a fork bomb,
  a memory bomb, the environment, the capabilities, the absence of a Docker socket, DNS and TCP
  without and with `--allow-net`.
- CodeQL on every change and every Monday; secret scanning with push protection and Dependabot
  security updates on the repository.

### Changed

- `mcpcage wrap` and `protect --fix` no longer cage a server that needs the whole disk, the home
  directory or its parents, the system configuration, a Docker socket, a directory with credentials
  (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, gcloud, `.azure`, `.npmrc`, `.netrc`,
  `.git-credentials`, `.password-store`, the keychains, Colima's and OrbStack's sockets,
  `.claude.json`) or mcpcage's own pins and audit logs: the entry is left as it is, with the reason.
  `run --mount` refuses such a path unless `--allow-sensitive-mount` is given; `protect` names it.
  A server that 0.3.0 caged with such a mount is refused at its next start, with a message that says
  what to do.
- The proxy reads the server's output with a bounded splitter: a line over 16 MiB is dropped and
  counted (`oversize-line`), output that is not JSON-RPC is dropped (`stdout-noise`), a response to
  an id the client is not waiting for is dropped (`unsolicited-response`), and an id must come back
  with the type the client sent.
- Requests from the server to the client: `ping` and `roots/list` pass; `sampling/createMessage`,
  `elicitation/create` and any other method are refused with error -32001 unless
  `--allow-server-requests` is given (`server-request-blocked`).
- A `tools/list` with more than 10,000 tools, or with a definition nested more than 256 levels
  deep, is refused whole: the client gets an error, nothing is pinned, the session is locked.
  `diff` and `approve` refuse such a pending file; `protect --inspect` reports such a server as
  refused and reads servers with the same limits.
- The hidden-instruction rules read a text in windows of 1 MiB, at most 100 matches per rule per
  window, and at most 20,000 strings or 32 Mi characters per definition or result; a `scan-budget`
  sign stands for the rest.
- Nothing a server sends that is nested more than 256 levels deep is serialized again or walked:
  a tool result like that passes unchanged, unmeasured (`call-result` records no size) and with a
  `scan-budget` sign; an answer nobody asked for or a batch message like that is dropped
  (`deep-message`); a pin or pending entry like that, written by an older version, is left out and
  the tool counts as new. The inspect client answers a server's requests only when their id is a
  string or a number.
- The cage gets no swap: `--memory-swap` equals `--memory`. Before, Docker allowed as much swap
  again on a host that has some, and the limit doubled.

### Fixed

- The proxy crashed with EPIPE when the server exited while the client was still writing, when the
  client went away while the proxy wrote to it, or when the log pipe closed. It now ends cleanly
  with the server's exit code.
- A client that reads slower than the server writes no longer lets the server's output pile up in
  memory, and answers to a server that does not read its input are capped.
- The hidden-instruction rules could crash or stall on texts of millions of characters or strings
  and on definitions nested thousands of levels deep.
- Backups of configuration files are created with an exclusive write, `wrap` reads the file instead
  of checking for it first, and the demo's probe server writes a file with a random name (the three
  findings of the first CodeQL scan).

## [0.3.0] - 2026-11-03

### Added

- Devin: `mcpcage protect` finds its MCP configuration files, `~/.config/devin/mcp_config.json`
  (`%APPDATA%\devin\mcp_config.json` on Windows), `<project>/.devin/mcp_config.json` and
  `<project>/.devin/mcp_config.local.json`, and reports their servers; `--fix` routes their npx
  servers through mcpcage, with a backup, as it does for Cursor, and `mcpcage wrap` takes these
  files too. The Windsurf files of older installs are still read.

### Changed

- `mcpcage protect` lists the clients of the files it did not find on their own line, under the
  count, so the report stays readable in narrow terminals.

## [0.2.1] - 2026-11-03

### Fixed

- When the server fails to start (for example a `docker run` that the daemon refuses), mcpcage now
  exits at once with the server's exit code and says on stderr how many client requests were left
  unanswered. Before, it stayed silent until the client gave up, so the client reported a timeout
  instead of the real error.

## [0.2.0] - 2026-11-03

### Added

- `mcpcage protect`: finds every MCP configuration file of Claude Desktop, Claude Code, Cursor,
  VS Code, GitHub Copilot CLI and Windsurf and reports each server: which client and file it comes
  from, how it starts, whether it already runs through mcpcage, whether its package declares
  install scripts, whether the configuration holds a secret in clear text, and whether an argument
  opens the whole home directory or the disk. `--inspect` starts each npx server inside the cage
  and checks its tools for hidden instructions; `--fix` routes the npx servers through mcpcage,
  with a backup of every file it rewrites.
- An explanation under every blocked change of tool definitions: fixed rules point at the signs of
  hidden instructions (privileged tags, override and concealment phrases, secret files, invisible
  characters, orders about other tools, abnormal growth since approval), each with a severity, in
  `mcpcage diff`, `mcpcage approve`, the proxy log and the error returned to the client.
- A recorded demo at the top of the README, reproducible with `npm run demo:webp`.

### Changed

- `mcpcage wrap` mounts a server's existing path arguments read-write and expands `~/`, so a
  filesystem server keeps working inside the cage.

## [0.1.0] - 2026-11-02

### Added

- The proxy: tool definitions pinned on first use (or `--strict`); a new or changed tool blocks
  `tools/list` and locks the session; calls to tools that are not approved never reach the server;
  stdout that is not JSON-RPC is dropped.
- The cage: npx packages installed with `--ignore-scripts` into a distroless nonroot image, with
  the lockfile kept and reused; `docker run` with no network, a read-only root, no capabilities, a
  nonroot user, explicit mounts and environment; refuses to start without Docker.
- The audit log: hash-chained JSONL with hashes of the arguments only, and `mcpcage audit verify`.
- Commands: `run`, `prepare`, `wrap`, `unwrap`, `diff`, `approve`, `list`, `audit`, `doctor`.
- A demo of a stolen SSH key and of a rug pull, reproduced locally with a fake key and a collector
  on 127.0.0.1.
