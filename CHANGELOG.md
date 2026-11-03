# Changelog

Notable changes to mcpcage. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
