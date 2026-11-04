# Threat model

mcpcage protects the person running an MCP client from the MCP servers that client starts.

## Assets

- Files in the user's home directory: SSH keys, cloud credentials, source code, documents.
- Secrets in the environment of the client process and in its configuration files.
- The integrity of what the model is told about each tool (descriptions and schemas), because the
  model acts on it.
- A trustworthy record of what each server was asked to do.

## Adversaries in scope

| Adversary | Example | What mcpcage does |
|---|---|---|
| A malicious package from the start | a lookalike of a popular server | It runs in a container with no network, no home directory, a read-only filesystem, no capabilities and a nonroot user. Install scripts never run. |
| A trusted package that turns malicious in an update (rug pull) | postmark-mcp after fifteen clean releases | The lockfile keeps the approved version until `--rebuild`, or until the package or its version range in the configuration changes. When the update arrives, changed tool definitions block the session until a human approves them. |
| Tool poisoning through descriptions | hidden instructions in a tool description | Every description and schema is fingerprinted; a change is shown by `mcpcage diff` and blocked until approved. Fixed rules point at the signs of hidden instructions (privileged tags, "ignore previous instructions", "do not tell the user", secret files, invisible characters, orders about other tools) so the reviewer does not have to find them alone. The first listing is trusted unless `--strict` is used: its first page and the pages the client asks for with the cursor each page returned. Every later page is compared with the pin, and no page, of the first listing or after it, can replace a definition approved before it. |
| Instructions hidden in invisible characters | zero-width text, Unicode Tags, bidi controls, variation selectors in a description | The same rules report them as high-severity signs, decode Unicode Tags to the text they spell, and show every invisible character as `[U+XXXX]`, so what the reviewer reads is what the model reads. |
| Instructions hidden in a tool result | a note, a web page or an issue comment returned by a tool that tells the model to read `~/.ssh/id_rsa` and pass it to the next call | The rules that make sense on free text read every result: the signs are recorded in the audit log and the high-severity ones printed on stderr, so the user can see them in the client's log. The result passes unchanged, because blocking or editing data would break legitimate content: the model may still follow the instructions, and the cage limits what it can reach through that server. |
| A server that pollutes stdout | logs, binary output or JSON that is not JSON-RPC on the channel | Anything that is not JSON-RPC by its shape is dropped and recorded. |
| A server that tries to exhaust the proxy's memory | one line of gigabytes without a newline; requests whose answers it never reads; notifications faster than the client reads them | A line over 16 MiB is counted and thrown away as it streams in, never held whole, and recorded with its size; the proxy goes on serving. mcpcage stops answering refused requests while 16 MiB wait unread in the server's input, and stops reading the server while the client is behind. |
| A server whose definitions or messages are built to crash or stall mcpcage | a schema nested 10,000 levels deep; one line listing 200,000 tools; an enum of millions of one-letter values; a description of 16 MiB of invisible characters; a result or an id nested 10,000 levels deep | A page of more than 10,000 tools, or with a definition nested more than 256 levels deep, is refused whole before anything walks it: the client gets an error, nothing is pinned or saved, and the session is locked; `diff` and `approve` refuse a pending definition nested that deep too. The limit of 10,000 tools holds for a whole listing and for what is pinned or pending for a server too, where pages and listings add up: a page that would take them past it is refused the same way. Nothing else a server sends nested more than 256 levels deep is serialized again or walked: a result passes unmeasured with a `scan-budget` sign, an unasked answer or a batch message like that is dropped, and a pin or pending entry like that is left out, so its tool needs a fresh approval. The rules read a long text a window at a time and stop after 20,000 strings or 32 Mi characters of one definition or result, with a `scan-budget` sign in place of the rest (high in a definition, medium in a result). |
| A server that answers what nobody asked | a forged response to a request the client never sent, or a second response to one already answered | A response whose id the client is not waiting for is dropped and recorded. |
| A server that makes the client act for it | `sampling/createMessage` to run the model on the server's prompt, `elicitation/create` to put the server's question to the user | Both are a way in for a prompt injection and a way out for data, so they are refused by default with an error to the server, like any request mcpcage does not know, and recorded. `ping` and `roots/list` pass, and so do notifications. `--allow-server-requests` lets every request through, with a warning on stderr. |
| A server that asks to call tools outside its manifest | a call routed to a tool the user never saw | Calls to tools that are not approved never reach the server, a call sent as a notification (without an id) included. A call whose arguments are nested more than 256 levels deep is refused before anything serializes them. |
| A server written into a client configuration without the user's knowledge | SANDWORM_MODE adding entries to Claude Code, Cursor and Windsurf configs | `mcpcage protect` reads every configuration file the clients document and lists each server with how it starts, what it can reach and whether it is caged; `--fix` cages the npx ones. |
| A server entry whose `env` configures mcpcage instead of the server | `NODE_OPTIONS=--import ./x.mjs`, `LD_PRELOAD`, `OPENSSL_CONF`, `SHELLOPTS=xtrace` with a `PS4` of `$(...)` for the pnpm shim that starts mcpcage, a `DOCKER_HOST` on another machine, `HOME` pointed at an empty directory, `MCPCAGE_HOME` pointed at an empty store | A client starts the entry's command with its `env`, and after `wrap` that command is mcpcage, on the host, often through a shell script (pnpm's shim, the asdf and nodenv shims). `wrap` and `protect --fix` move `NODE_*`, `LD_*`, `DYLD_*`, `DOCKER_*` (except a `unix://` or `npipe://` `DOCKER_HOST`), `OPENSSL_*`, `GCONV_PATH`, the shell's `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4`, `ZDOTDIR` and `BASH_FUNC_*`, and `npm_config_*` into the cage as `--env NAME=value`, and drop `HOME`, `USERPROFILE` and `MCPCAGE_HOME`. `protect` names each such variable and counts a caged entry that still has one as running on the host. An entry's `PATH` stays, and must stay within the user's own `PATH`: `protect` names each other directory, and each relative or empty one, and does not count the entry as caged; so too for a `COPILOT_HOME`, `XDG_CONFIG_HOME`, `APPDATA` or, on Windows, `LOCALAPPDATA` set to another place than the user's, with which `run` would look elsewhere for the client configurations it refuses to mount. VS Code adds the variables of an entry's `envFile` to that environment: `protect` reads that file as it reads `env`, and does not count as caged an entry whose `envFile` sets such a variable or cannot be read; `wrap` and `--fix` keep the `envFile` and say that its variables reach mcpcage. `wrap` and `--fix` check each entry they are about to write as `protect` will, and leave one that would still not count as caged as it is, with the reason, instead of writing it and calling it caged. The home directory whose places are never mounted is the account's own, from the system's user database, as well as the one `HOME` names, and a relative `MCPCAGE_HOME` is made absolute, so it is never mounted either. |
| Someone editing the audit trail after the fact | removing the record of a call | The hash chain makes edits, reordering and deletions inside a file detectable, except deletions at its end. |

## Trust boundaries

1. **Client and mcpcage, same user.** mcpcage trusts the client and the configuration it is given.
   Anyone who can edit the client configuration can remove mcpcage from it. `mcpcage protect`
   reads those configurations and, only with `--fix` and a confirmation, rewrites the server
   entries of a file after writing a backup next to it; everything else in the file is kept.
2. **mcpcage and the container.** The server's process, files and network live behind Docker's
   isolation. mcpcage only parses newline-delimited JSON from it and never executes what it sends.
   `--inspect` starts a server in the same cage, with its path arguments mounted read-only as
   written and the sensitive ones left out, only to read its tool list. It reads that list with the
   same limits as the proxy: a line over 16 MiB is dropped, and more than 10,000 tools, or a
   definition nested more than 256 levels deep, is reported as refused, not read.
3. **Build time and run time.** Building the image needs the npm registry; running it does not.
   Packages are fetched once, recorded by integrity hash and reused from the lockfile.
4. **The report and the secrets it finds.** `protect` names the environment variables, headers
   and arguments whose values look like credentials and never prints the values, so the report
   can be shared. The values stay where they were: mcpcage does not move secrets out of
   configuration files.

## Out of scope, and residual risks

- **Container escapes.** mcpcage relies on Docker and the kernel. A kernel or runtime vulnerability
  can break the isolation. gVisor or microVM runtimes are on the roadmap for stronger isolation.
- **What you mount or allow.** A server can use what it is given: a `--mount`, `--allow-net`.
  Mounts are read-only unless `:rw` is written explicitly. `wrap` and `protect --fix` mount the
  paths a server is configured with, because the server is expected to work there: read-only, and
  writable only with `--writable`, which prints a warning for each such mount. They never mount
  the whole disk, the home directory, a directory with credentials or system files
  (`~/.ssh`, `~/.aws`, `~/.config/gh`, `/etc`, the Docker sockets, mcpcage's own `~/.mcpcage`...),
  nor a place the machine runs commands from: other clients' MCP and agent configurations
  (`~/.cursor`, `~/.claude`...), shell and login startup files, git's configuration and any
  repository's `.git`, a project's editor and agent settings (`.vscode`, `.mcp.json`...), and the
  programs on the PATH and where they are installed (`~/.local/bin`, `~/.npm`, `/usr/local`...): a
  server that needs one is left uncaged, with the reason, and the report names the path. `mcpcage
  run` refuses such a `--mount` unless `--allow-sensitive-mount` is given; with it, the server can
  use that path like any other.
- **Writable mounts.** A server with a writable mount (`:rw`, or `--writable` in `wrap` and
  `protect --fix`) can change what the host later runs from it: the code you run and build, and the
  files that git, editors and build tools read as settings and run commands from. Among them: the
  hooks of a directory that `core.hooksPath` names (husky's `.husky/_`), a file that a git
  configuration includes (`include.path`), a repository under any name (a bare `proj.git`), the
  `.env` file a client loads into a server's environment (VS Code's `envFile`), and a new nested
  repository or project MCP configuration where none existed. No list of names covers all of them,
  so write access is an explicit choice, and `protect` names each writable mount of a caged server
  and counts it as caged with its cage opened. As a best effort, the git and editor settings that
  exist at start (`.git`, `.vscode`, `.idea`, `.cursor`, `.claude`, `.devin`, `.windsurf`,
  `.mcp.json`, at any depth) stay read-only, because git and editors run the commands they name as
  soon as the project is open; so does the repository a `.git` file points to. The directories that
  lead to each of them are held in place, each a mount point of its own, so that none can be moved
  away and replaced: renaming one fails with `EBUSY`, and moving a file from one held directory into
  another, or between a held directory and the rest of the mount, fails with `EXDEV`, as between two
  filesystems. On macOS and Windows, which compare names without case, a read-only mount covers only
  the spelling it is placed on: the server could write `.GIT` or `.MCP.JSON` and change the file
  underneath, so a writable mount that holds a setting that is a file (a `.git` file, `.mcp.json`)
  is refused, and paths are compared as spelled on disk and without case. On Windows a directory is
  no better covered (see Paths on Windows), so there a writable mount that holds any setting is
  refused. A server that only needs to read should get a read-only mount.
- **Two cages writing in one directory.** The git and editor settings of a writable mount are
  found at start, then mounted read-only by Docker. Two cages of servers with write access to the
  same directory, running at once, give one of them a moment to swap a setting for a symlink before
  the other's mounts are made: that other cage then gets, read-only, the place the link names.
- **Paths on Windows.** The cage is a Linux container: a folder `C:\Users\me\notes` is mounted at
  `/c/Users/me/notes`, and the server is given that path for each of its arguments that names a
  mounted folder or a path inside one. Each folder is spelled as Windows keeps it on disk, because
  the container compares mount points with case. Tool calls are not translated: the model has to use
  the paths the server lists (`list_allowed_directories`); a call that names `C:\...` names nothing
  in the cage, so the mapping opens nothing beyond the mounts. Network shares and device paths
  (`\\server\share`, `\\?\...`) are never mounted. Docker Desktop shares a folder so that its names
  are found under any case, and a mount point covers only the spelling it is placed on: in a test on
  Windows 10, a server wrote `.GIT/config` through the writable mount around a read-only `.git` and
  changed the repository's `.git\config` on the host, and wrote `SUB/x.txt` next to a read-only
  `sub` mounted inside a writable folder. So on Windows mcpcage relies on no read-only mount inside a
  writable one: a writable mount that holds any of git's or the editors' settings, and a read-only
  mount given inside a writable one, refuse the start, and the settings it keeps read-only elsewhere
  are kept so on Windows only by keeping them out of writable mounts. A writable folder inside a
  read-only one is fine: what the server reaches through the read-only one, under any spelling, is
  read-only.
- **Hard links.** The checks read paths. A hard link to a credential file, made elsewhere on the
  disk before anything was caged, is another path to the same file, and does not count as the file.
- **Sensitive paths during `protect --inspect`.** Inspection never mounts them, and mounts every
  other path argument read-only; the report names the paths a server was inspected without.
- **Misuse of granted capabilities.** A filesystem server with a writable mount can still
  overwrite files in that mount when asked to, and change or create files that git, an editor or a
  build later reads as settings or runs as code (see Writable mounts). mcpcage records the call but
  does not judge it.
- **Prompt injection through tool results.** Data a tool returns can still steer the model. The
  cage limits what a misled model can reach through that server, not what it decides.
- **The highlighter is a set of fixed rules, not a verdict.** A paraphrased instruction can avoid
  every rule, and a legitimate description can trip one. The block comes from the pin, which sees
  any change; the rules only explain what they recognize. They are deliberately not a model: an
  attacker can tune a text against a classifier, and the same text must give the same answer
  every time. They read at most 20,000 strings or 32 Mi characters of one definition or result,
  and say so with a `scan-budget` sign instead of explaining the rest.
- **Trust on first use.** The first listing is trusted: its first page and the pages the client
  asks for with the cursor each page returned. A later page, in the same session or after, cannot
  replace an approved definition. If the package was malicious from the start, the cage is the
  protection, not the pin. `--strict` requires an explicit review instead,
  and `protect --inspect` shows the signs in a server's tools before you approve anything.
- **Deleting the audit log.** The chain shows that the entries a file holds were written in that
  order and not changed since. It cannot show that entries were cut from the end of a file, nor
  that a whole file was deleted or replaced by another valid one, and whoever can write the file can
  write a new chain, because the hashes are not keyed. A cage never gets mcpcage's own directory,
  so this takes access to the machine itself. Shipping entries to an external store is not
  implemented yet.
- **The rate of log entries.** Every line dropped, request refused and unsolicited response writes
  one audit entry and one line on stderr, with ids recorded as the server sent them, up to 16 MiB
  each. A server can grow the audit log, and the client's log while the client reads it, as fast as
  it writes; there is no rate limit. When the client does not read, at most 1 MiB of lines waits in
  mcpcage's memory: a message too long for what is left is cut with its full length or dropped, the
  next ones are dropped and counted, and one line gives the count once it reads.
- **What a client's parser refuses.** mcpcage passes on what is JSON-RPC by its shape. A client's
  own parser can be stricter (the official SDK refuses a message with both a method and a result,
  or a fractional id): such a message only leaves the client's request without an answer.
- **Ids of another type.** An answer must carry the id of its request with the same type, as
  JSON-RPC requires. A server that answers the request with id `5` using the id `"5"` has its answer
  dropped as unsolicited, and the request goes unanswered.
- **Prompts and resources.** Their descriptions are not pinned yet.
- **Remote MCP servers.** Nothing runs locally to cage; they are out of scope. `protect` lists
  them and reports credentials written in clear text in their headers.
- **Servers not started with `npx`.** `uvx`, `node`, `bun` or a binary run on the host as before;
  `protect` reports them as not caged and cannot fix them yet.
- **The Docker daemon itself.** Whoever controls it controls the containers.
- **What stays in a server entry's `env`.** `PATH` stays, because it is often what lets the client
  find `node`. mcpcage runs `docker` from its usual install places (the `PATH` is searched only when
  none has it) and `npm` from next to the `node` that runs mcpcage, each with a `PATH` of those
  places only; but the client finds that `node`, and a shim such as pnpm's finds `dirname`, `sed`
  and `uname`, through the entry's `PATH`. So `protect` accepts an entry's `PATH` only when each of
  its directories is one of the user's own `PATH`, compared as they resolve, without case on macOS
  and Windows: an entry whose `PATH` has another directory, or a relative or empty one, is named and
  not counted as caged, and `wrap` and `--fix` leave such an entry as it is, for the user to check
  or remove that `PATH`, since they cannot know which one was meant. Run from a temporary place
  (`npx`, `pnpm dlx`, `yarn dlx`, `bunx`), mcpcage leaves out of the user's own `PATH` what the
  runner put first on it: the directories in a temporary place, every `node_modules/.bin` and npm's
  `node-gyp-bin`. They are not the user's, and a look-alike mcpcage in a project's
  `node_modules/.bin` would otherwise be taken for the installed one, and written by `--fix`.
  Within the user's own directories the order can differ, so an
  entry can pick one of the user's programs over another of the same name; and `run`, which refuses
  to mount the directories of the `PATH` it is started with, does not check those of the user's that
  the entry's `PATH` leaves out (the report still names such a `--mount`). `COPILOT_HOME`,
  `XDG_CONFIG_HOME`, `APPDATA` and, on Windows, `LOCALAPPDATA` stay too: an entry that sets one to
  another place than the user's is named and not counted as caged, because `run` would look there
  for the client configurations it refuses to mount. An `envFile` stays as well, since VS Code
  loads it: `protect` reads it where it can name it (`${workspaceFolder}` only in a project's own
  configuration) and calls any other unknown, which keeps the entry from counting as caged. A value
  moved into `--env NAME=value` is written in the arguments, so it shows in the machine's process
  list while the server runs.
- **`--no-sandbox`.** It keeps pinning and audit but provides no isolation at all. `protect` counts
  such entries as exposed.
- **Configuration files mcpcage will not rewrite.** A file with comments (VS Code's `mcp.json`) is
  left for the user to edit by hand, and `~/.claude.json` is left alone while Claude Code is
  running, because Claude Code rewrites it while it runs. `protect` prints the exact command to
  put in the file instead.
