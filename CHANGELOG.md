# Changelog

Notable changes to mcpcage. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
