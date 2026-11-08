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
| A malicious package from the start | a lookalike of a popular server | It runs in a container with no network, no home directory, a read-only filesystem, no capabilities and a nonroot user. Install scripts never run. A PyPI server is installed from wheels only, each checked against its hash, and nothing is built from source, so no code of the package runs while its image is built either. |
| A trusted package that turns malicious in an update (rug pull) | postmark-mcp after fifteen clean releases | The lockfile (for a PyPI server, the requirements locked with their hashes) keeps the approved version until `--rebuild`, or until the package or its version range in the configuration changes; a PyPI server's `@latest` stays at the release of its first build. When the update arrives, changed tool definitions block the session until a human approves them. |
| Tool poisoning through descriptions | hidden instructions in a tool description | Every description and schema is fingerprinted; a change is shown by `mcpcage diff` and blocked until approved. A listing with an entry that is not a tool definition is refused whole, since it cannot be compared. Fixed rules point at the signs of hidden instructions (privileged tags, "ignore previous instructions", "do not tell the user", secret files, invisible characters, orders about other tools) so the reviewer does not have to find them alone. The first listing is trusted unless `--strict` is used: its first page and the pages the client asks for with the cursor each page returned. Every later page is compared with the pin, and no page, of the first listing or after it, can replace a definition approved before it. |
| Instructions hidden in invisible characters | zero-width text, Unicode Tags, bidi controls, variation selectors in a description | The same rules report them as high-severity signs, decode Unicode Tags to the text they spell, and show every invisible character as `[U+XXXX]`, so what the reviewer reads is what the model reads. |
| Instructions hidden in a tool result | a note, a web page or an issue comment returned by a tool that tells the model to read `~/.ssh/id_rsa` and pass it to the next call | The rules that make sense on free text read every result: the signs are recorded in the audit log and the high-severity ones printed on stderr, so the user can see them in the client's log. The result passes unchanged, because blocking or editing data would break legitimate content: the model may still follow the instructions, and the cage limits what it can reach through that server. |
| A server that pollutes stdout | logs, binary output or JSON that is not JSON-RPC on the channel | Anything that is not JSON-RPC by its shape is dropped and recorded. |
| A server that tries to exhaust the proxy's memory | one line of gigabytes without a newline; requests whose answers it never reads; notifications faster than the client reads them | A line over 16 MiB is counted and thrown away as it streams in, never held whole, and recorded with its size; the proxy goes on serving. mcpcage stops answering refused requests while 16 MiB wait unread in the server's input, and stops reading the server while the client is behind. |
| A server whose definitions or messages are built to crash or stall mcpcage | a schema nested 10,000 levels deep; one line listing 200,000 tools; an enum of millions of one-letter values; a description of 16 MiB of invisible characters; a result or an id nested 10,000 levels deep | A page of more than 10,000 tools, or with a definition nested more than 256 levels deep, is refused whole before anything walks it: the client gets an error, nothing is pinned or saved, and the session is locked; `diff` and `approve` refuse a pending definition nested that deep too. The limit of 10,000 tools holds for a whole listing and for what is pinned or pending for a server too, where pages and listings add up: a page that would take them past it is refused the same way. Nothing else a server sends nested more than 256 levels deep is serialized again or walked: a result passes unmeasured with a `scan-budget` sign, an unasked answer or a batch message like that is dropped, and a pin or pending entry like that is left out, so its tool needs a fresh approval. The rules read a long text a window at a time and stop after 20,000 strings or 32 Mi characters of one definition or result, with a `scan-budget` sign in place of the rest (high in a definition, medium in a result). |
| A server that answers what nobody asked | a forged response to a request the client never sent, or a second response to one already answered | A response whose id the client is not waiting for is dropped and recorded. |
| A server that makes the client act for it | `sampling/createMessage` to run the model on the server's prompt, `elicitation/create` to put the server's question to the user | Both are a way in for a prompt injection and a way out for data, so they are refused by default with an error to the server, like any request mcpcage does not know, and recorded. `ping` and `roots/list` pass, and so do notifications. `--allow-server-requests` lets every request through, with a warning on stderr. |
| A server that asks to call tools outside its manifest | a call routed to a tool the user never saw | Calls to tools that are not approved never reach the server, a call sent as a notification (without an id) included. A call whose arguments are nested more than 256 levels deep is refused before anything serializes them. |
| A server written into a client configuration without the user's knowledge | SANDWORM_MODE adding entries to Claude Code, Cursor and Windsurf configs | `mcpcage protect` reads every configuration file the clients document and lists each server with how it starts, what it can reach and whether it is caged; `--fix` cages the npx and uvx ones. |
| A server entry whose `env` configures mcpcage instead of the server | `NODE_OPTIONS=--import ./x.mjs`, `LD_PRELOAD`, `OPENSSL_CONF`, `SHELLOPTS=xtrace` with a `PS4` of `$(...)` for the pnpm shim that starts mcpcage, a `DOCKER_HOST` on another machine, `HOME` pointed at an empty directory, `MCPCAGE_HOME` pointed at an empty store | A client starts the entry's command with its `env`, and after `wrap` that command is mcpcage, on the host, often through a shell script (pnpm's shim, the asdf and nodenv shims). `wrap` and `protect --fix` move `NODE_*`, `LD_*`, `DYLD_*`, `DOCKER_*` (except a `unix://` or `npipe://` `DOCKER_HOST`), `OPENSSL_*`, `GCONV_PATH`, the shell's `BASH_ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4`, `ZDOTDIR` and `BASH_FUNC_*`, `npm_config_*`, and on Windows Windows' own places (`SystemRoot`, `windir`, `SystemDrive`, `ComSpec`, `PATHEXT`, `ProgramData`, `ALLUSERSPROFILE`, `ProgramFiles` and the other program folders, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `HOMEDRIVE`, `HOMEPATH`: docker loads its plugins from `%ProgramData%` and `%ProgramFiles%`, node Windows' own code from `%SystemRoot%`) and `GODEBUG` (whose `execerrdot=0` makes docker start a credential helper from the current directory) into the cage as `--env NAME=value`, and drop `HOME`, `USERPROFILE` and `MCPCAGE_HOME`. `protect` names each such variable and counts a caged entry that still has one as running on the host. An entry's `PATH` stays, and must stay within the user's own `PATH`: `protect` names each other directory, and each relative or empty one, and does not count the entry as caged; so too for a `COPILOT_HOME` or `XDG_CONFIG_HOME` set to another place than the user's, with which `run` would look elsewhere for the client configurations it refuses to mount. VS Code adds the variables of an entry's `envFile` to that environment: `protect` reads that file as it reads `env`, and does not count as caged an entry whose `envFile` sets such a variable or cannot be read; `wrap` and `--fix` keep the `envFile` and say that its variables reach mcpcage. `wrap` and `--fix` check each entry they are about to write as `protect` will, and leave one that would still not count as caged as it is, with the reason, instead of writing it and calling it caged. The home directory whose places are never mounted is the account's own, from the system's user database, as well as the one `HOME` names, and a relative `MCPCAGE_HOME` is made absolute, so it is never mounted either. |
| A server entry whose `env` chooses code for a program that docker or npm starts | `CLOUDSDK_PYTHON` naming a script, with the user's docker configured for gcr.io through gcloud's credential helper (as `gcloud auth configure-docker` leaves it); `PYTHONPATH` and `PYTHONWARNINGS`, an `AWS_CONFIG_FILE` with a `credential_process`, `SSH_ASKPASS` for an `ssh://` `DOCKER_HOST`, `BUILDX_CONFIG`, `CONTAINERS_CONF` behind podman's `docker` shim, `GIT_SSH_COMMAND` | docker passes its environment to the programs it starts: its credential helpers (any program, often a script; the classic builder asks every one at every build, BuildKit the one of each registry it pulls from), its plugins, ssh, podman; npm passes its own to git and node. No list of such variables is complete, so mcpcage gives docker and npm an environment made of names instead of a copy of its own: the `PATH` of their install places (on Windows also Windows' places, from Windows), the variables `wrap` moves out of an entry's `env`, which are the user's own since an entry that still sets one is not counted as caged (`DOCKER_HOST`, `DOCKER_CONFIG`, `HOME`, `npm_config_*`, `NODE_EXTRA_CA_CERTS`...), and `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TMPDIR`, `SSH_AUTH_SOCK` and the proxy variables, whose values name no program; names are compared without case on Windows. Every other docker command (`version`, `build`, `pull`, `image inspect`...) and npm get nothing else. `docker run` also gets the variables named with `--env NAME`, because docker reads their values from its environment; it starts the local image by its ID with `--pull never`, so no credential helper runs. |
| A uvx entry, or uv settings, that choose where uvx takes its packages from | `UV_INDEX_URL` or `--index-url` naming a private index, a `uv.toml` with an `[[index]]` table, a git source, `--with-editable`, an `env` `HOME` or `APPDATA` pointing uvx at a `uv.toml` the entry's author wrote | The cage builds from PyPI's wheels only, and would build packages of the same names from PyPI: a dependency confusion the user did not ask for, or another server than the one uvx runs. So an entry whose flags, variables or source take uvx elsewhere than PyPI, read a file on the host or build from source, and an entry the user's or the system's `uv.toml` (or one an entry's `HOME`, `XDG_CONFIG_HOME`, `XDG_CONFIG_DIRS`, `APPDATA`, `USERPROFILE`, `SYSTEMDRIVE` or `PROGRAMDATA` points to) names an index for, or changes what uvx installs in (`resolution`, `prerelease`, `exclude-newer`, `dependency-metadata`, `no-binary`, `allow-insecure-host`...), is not caged: `protect` says why, `wrap` and `--fix` leave it, and `run` refuses it at every start, so a caged entry whose settings change later stops, and is reported as "cannot start". A settings file that is there and cannot be read counts as one that names an index. Refusals name the flag or variable, never its value. The `.vscode/mcp.json` of a cloned repository may hold an `envFile`: its variables count as the entry's `env`. |
| A configuration entry that names a path on another machine | in a cloned repository's `.vscode/mcp.json`, an `envFile`, a `command`, a `PATH` directory, an argument or an `APPDATA` written as `\\attacker\share\...` | On Windows looking at such a path connects to that host over SMB and authenticates with the user's session (NTLM), which hands the host the user's NTLM response; on macOS a path under `/net/<host>` mounts that host over NFS where the automounter's `-hosts` map is on. mcpcage tells such a path by its text alone, after the variables it fills in (on Windows any path that starts with two slashes or backslashes, in any mix; on macOS one under `/net/<host>`), and never looks at it: in `protect`, `--fix`, `wrap`, `--inspect` and `run`, for the `envFile`, the `command` and a caged entry's node and `cli.js`, the directories of its `PATH`, its mount and argument paths, the `.git` file in a mounted folder, and the uv settings an entry's variables point to, a variable whose value names a host without a share (`\\host`) included. Such an entry is not counted as caged, `wrap` and `--fix` leave it, and `run` refuses such a mount or settings path. Only the user's own AppData folder, where Windows' folder redirection puts it on a share, is read, as every program of the session reads it, and only from the user's own environment and registry, never from an entry's. |
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
3. **Build time and run time.** Building the image needs the npm registry, or PyPI for a server
   started with `uvx`; running it does not. Packages are fetched once, recorded by integrity hash
   and reused from the lockfile.
4. **What a Python server's build trusts.** PyPI's index, for what it serves at the first resolve
   (as the first install of an npm package trusts npm's registry): every later build installs the
   same files, checked against the hashes of the lock. uv's image
   `ghcr.io/astral-sh/uv:0.13.7-python3.13-trixie-slim`, uv's own binary
   (`ghcr.io/astral-sh/uv:0.13.7`) and the distroless `cc-debian13` bases, pinned by digest in
   `runtime/bases.Dockerfile`; and the CPython builds uv installs, which uv checks against the
   sha256 it ships with. The resolve (`uv pip compile --no-build`, metadata only) runs in a
   `docker run` hardened as the cage is (read-only root with a 256 MB `noexec` `/tmp`, user 65532,
   no capabilities, no new privileges, 128 processes, 1 GB of memory) but with the network on for
   PyPI, no host file mounted, none of the entry's variables and no uv settings read. mcpcage checks
   uv's answer before it keeps it: only pins, each with its sha256 hashes, the server at the release
   chosen, no index, URL, path or editable line; a lock kept in the store is checked again the same
   way before each build. The install runs one `uv pip sync --require-hashes --no-build` into an
   empty virtual environment, after which Python runs in the build only as `python -I -S`, so no
   `.pth` file of a package runs there. The runtime image has the Python and the environment only,
   no shell, no uv and no pip, runs as 65532, and starts with the same `docker run` as an npx
   server: no network, a read-only root.
5. **The report and the secrets it finds.** `protect` names the environment variables, headers
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
  programs on the PATH and where they are installed (`~/.local/bin`, `~/.npm`, uv's and pipx's
  directories, `/usr/local`...): a server that needs one is left uncaged, with the reason, and the
  report names the path. `mcpcage run` refuses such a `--mount` unless `--allow-sensitive-mount` is given; with it, the server can
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
  `.mcp.json`, at any depth except under `node_modules`) stay read-only, because git and editors run
  the commands they name as soon as the project is open; so does the repository a `.git` file points
  to. They are looked for in the directory Docker mounts: a mount's path is read as Docker reads it,
  each `..` taking away the name written before it, so `/x/link/../app` is `/x/app` even where `link`
  is a symlink, from whose target the system would take the `..`. `node_modules` is left out on
  purpose: a setting there would have to exist before the server
  starts, and no package runner drops one there (npm strips `.git` from a tarball, git tracks no path
  with a `.git` component); the server can make a new `.git` anywhere in a writable mount regardless
  (below); git on the host uses the nearest `.git` above the working directory, never one under
  `node_modules`, and VS Code's repository scan ignores `node_modules` and goes one level deep by
  default; and walking a real `node_modules` (tens of thousands of entries) would pass the entry
  limit, refusing an ordinary project, or slow every start. The directories that
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
- **Servers not started with `npx` or `uvx`.** `uv run`, `pipx run`, `node`, `bun` or a binary run
  on the host as before; `protect` reports them as not caged and cannot fix them yet.
- **The Docker daemon itself.** Whoever controls it controls the containers. It can also put an
  image of its choosing under a tag mcpcage uses: a PyPI server's image is tagged
  `mcpcage/<id>:<hash>`, the hash being that of its lock and Dockerfile, and a local image already
  under that tag is reused, whatever produced it. (An npm server's image is reused only when its
  ID is the one mcpcage recorded when it built it.)
- **What stays in a server entry's `env`.** `PATH` stays, because it is often what lets the client
  find `node`. mcpcage runs `docker` from its usual install places (the `PATH` is searched only when
  none has it) and `npm` from next to the `node` that runs mcpcage, each with a `PATH` of those
  places only, and on Windows with Windows' places (`ProgramData`, `ProgramFiles`, `SystemRoot`,
  `APPDATA`, the home directory...) from Windows itself, its registry and the account, never from
  mcpcage's environment, and `NoDefaultCurrentDirectoryInExePath` set; but the client finds that
  `node`, and a shim such as pnpm's finds `dirname`, `sed` and `uname`, through the entry's `PATH`.
  So `protect` accepts an entry's `PATH` only when each of its directories is one of the user's own
  `PATH`, compared as they resolve, without case on macOS and Windows: an entry whose `PATH` has
  another directory, or a relative or empty one, is named and not counted as caged, and `wrap` and
  `--fix` leave such an entry as it is, for the user to check or remove that `PATH`, since they
  cannot know which one was meant. Run from a temporary place
  (`npx`, `pnpm dlx`, `yarn dlx`, `bunx`), mcpcage leaves out of the user's own `PATH` what the
  runner put first on it: the directories in a temporary place, every `node_modules/.bin` and npm's
  `node-gyp-bin`. They are not the user's, and a look-alike mcpcage in a project's
  `node_modules/.bin` would otherwise be taken for the installed one, and written by `--fix`.
  Within the user's own directories the order can differ, so an
  entry can pick one of the user's programs over another of the same name; and `run`, which refuses
  to mount the directories of the `PATH` it is started with, does not check those of the user's that
  the entry's `PATH` leaves out (the report still names such a `--mount`). `COPILOT_HOME` and
  `XDG_CONFIG_HOME` stay too: an entry that sets one to another place than the user's is named and
  not counted as caged, because `run` would look there for the client configurations it refuses to
  mount. On Windows `APPDATA` and `LOCALAPPDATA` move into the cage with Windows' other places,
  and an `env` that sets one variable under two spellings (`Path` and `PATH`) is named and not
  counted as caged: Windows takes them for one variable, and a client gives only one of the two
  values, which one depending on the client (Node keeps the first in sorted order).
  An `envFile` stays as well, since VS Code loads it: `protect` reads it where it can name it
  (`${workspaceFolder}` only in a project's own configuration) and calls any other unknown, which
  keeps the entry from counting as caged. A value
  moved into `--env NAME=value` is written in the arguments, so it shows in the machine's process
  list while the server runs.
- **What `docker run` is given, and what docker and npm are not.** docker reads the value of each
  `--env NAME` from its own environment, so `docker run` has the variables named so, and so does
  what it starts. It pulls nothing and so runs no credential helper; but the `ssh` of an `ssh://`
  `DOCKER_HOST`, podman behind a `docker` shim and a CLI plugin that the user's docker
  configuration hooks to `docker run` still start, and an entry that names `--env SSH_ASKPASS` or
  `--env CONTAINERS_CONF` gives them its values. The other way round, a credential helper that
  needs a variable mcpcage leaves out does not get it: the secretservice helper of Linux desktops finds the session bus through
  `DBUS_SESSION_BUS_ADDRESS` (whose `unixexec:` addresses start a program) or `XDG_RUNTIME_DIR`,
  and `docker pull` or a BuildKit build that asks it may then fail.
- **What a Python server's settings checks leave out.** mcpcage reads uv's settings as uv 0.13.7
  does, with a line scan rather than a TOML parser, and errs toward leaving a server uncaged. Known
  gaps and differences:
  - On Linux an uncaged uvx entry whose `env` sets `XDG_CONFIG_HOME` to another value than the
    user's is reported with what it asks PyPI for and counted on the summary line that points to
    `protect --fix`; `--fix` then leaves it, because the variable also moves where VS Code keeps its
    configuration, which `run` refuses to mount.
  - On Windows, when the user's own AppData folder is redirected to a share that cannot be reached,
    every uvx entry is reported as one whose uv settings "could not be read" and is not caged,
    while uv would likely read no settings there. This fails closed.
  - A symlink or a junction on a local disk that points at a share is not seen by the network path
    test, which reads the path's text only, and is looked at.
  - On a case-sensitive APFS volume, a separate program named `UVX` (or `NPX`) would be read as uvx
    (or npx), since mcpcage compares those names without case on macOS.
  - `https-proxy` in a `uv.toml` is not refused: a proxy only tunnels TLS, and the packages are
    checked by their hashes. `--exclude-newer` years 0000 to 0099 are refused although uv takes
    them, which is stricter, and fails closed.
  - uv's global Python pin (`uv python pin --global`) is not read: the cage uses its own default,
    3.13 raised when the server needs it, or the version `--python` or `UV_PYTHON` names, so uvx on
    the host may run the server on another Python.
- **A killed build output thread.** mcpcage shows what `docker build` and `docker pull` print
  through a worker thread. If that thread is killed where no handler runs (terminated, out of
  memory), docker keeps running until it ends on its own; mcpcage notices within 30 to 45 seconds
  and stops with an error.
- **`--no-sandbox`.** It keeps pinning and audit but provides no isolation at all. `protect` counts
  such entries as exposed.
- **A `.cmd`/`.bat` mcpcage entry whose arguments cmd re-reads.** On Windows an entry that starts
  mcpcage through npm's `mcpcage.cmd`, as mcpcage 0.5.0's `--fix` wrote it, whose arguments hold a
  character `cmd.exe` reads (`&`, `|`, `<`, `>`, `^`, `%`, `!`, a quote, parentheses, a control
  character) runs a command on the host: a client that can start a `.cmd` (the MCP SDK's cross-spawn)
  makes `cmd.exe` re-read the shim's `%*` (CVE-2024-27980), so a quote and an `&` in an argument
  start another command before mcpcage runs. Such an entry is exactly what 0.5.0's `--fix` produced
  from a SANDWORM-poisoned `npx` entry whose server arguments held `cmd` metacharacters. `protect`
  counts it as running on the host, not as a plain `.cmd` entry, and `--fix` gives it `node.exe` with
  `cli.js`, which hands each argument to the server whole, so the injection reaches no shell.
- **Configuration files mcpcage will not rewrite.** A file with comments (VS Code's `mcp.json`) is
  left for the user to edit by hand, and `~/.claude.json` is left alone while Claude Code is
  running, because Claude Code rewrites it while it runs. `protect` prints the exact command to
  put in the file instead.

## Assurance case

Why mcpcage meets its security requirements, in four parts: the threat model ([Assets](#assets) and
[Adversaries in scope](#adversaries-in-scope)), the [trust boundaries](#trust-boundaries), and the
two sections below, on how the code applies secure design principles and how it counters common
implementation weaknesses. What it does not defend against is in
[Out of scope, and residual risks](#out-of-scope-and-residual-risks). Each pointer names the file
and the function that does the work; the tests for it are in `test/`, and the property-based tests
(`test/*.fuzz.test.ts`) throw generated input at the parts that read untrusted data.

### Secure design principles

The principles of Saltzer and Schroeder, and defense in depth.

- **Least privilege.** A server gets only what it is given: no network, a read-only root, no
  capabilities, no new privileges, user 65532, 128 processes, 512 MB of memory and 1 CPU by
  default, and only `HOME=/tmp` and the variables named with `--env` (`runArgs` in
  [src/sandbox.ts](src/sandbox.ts)). The images it runs have no shell and no package manager
  (`dockerfile` in src/sandbox.ts, `pypiDockerfile` in [src/pypi.ts](src/pypi.ts)). The docker and
  npm that mcpcage starts on the host get an environment built from names known to be safe, not a
  copy of mcpcage's own (`trustedEnv` in src/sandbox.ts). mcpcage's store is readable by the user
  only: directories 0700, files 0600 (`writeJson` in [src/pinstore.ts](src/pinstore.ts), `AuditLog`
  in [src/audit.ts](src/audit.ts)).
- **Fail-safe defaults.** What is not allowed explicitly is refused. The network is off unless
  `--allow-net` (`runArgs`). A mount is read-only unless it ends in `:rw` (`mountPath` in
  src/sandbox.ts), and a sensitive one is refused unless `--allow-sensitive-mount` (`parseRun` in
  [src/cli.ts](src/cli.ts), `sensitivePath` in [src/sensitive.ts](src/sensitive.ts)). Without Docker
  the server does not start, rather than run on the host (`prepareSandbox` in src/sandbox.ts). A
  request from the server other than `ping` and `roots/list` gets an error unless
  `--allow-server-requests` (`serverRequest` in `runProxy`, [src/proxy.ts](src/proxy.ts)). A new or
  changed tool blocks the listing and locks the session (`blockChanged` in `runProxy`). Where a
  check cannot be made, the answer is no: `protect` exits 1 for a configuration file it could not
  check, and uv settings that cannot be read count as settings that name another index
  ([Adversaries in scope](#adversaries-in-scope)).
- **Complete mediation.** Every message between client and server passes through the proxy, which
  decides on each one (`runProxy`). Every `tools/call`, a call sent as a notification included, is
  checked against the approved manifest under its exact name (`own` in
  [src/manifest.ts](src/manifest.ts)); every page of `tools/list` is compared with the pin; every
  line from the server is kept only if it is JSON-RPC that answers a request the client is waiting
  for, a notification or an allowed request (`fromServerLine` and `fromServer` in `runProxy`). The
  checks on mounts and uv settings run at every start, not only when an entry is written
  (`parseRun`, `withSettingsReadOnly` and `prepareSandbox`).
- **Economy of mechanism.** No runtime dependencies: package.json has no `dependencies`. A change to
  a tool is found by one comparison, of the SHA-256 of the canonical JSON of everything the model
  reads about it (`toolFingerprint` in src/manifest.ts, `canonicalJson` in
  [src/canonical.ts](src/canonical.ts)). The block comes from that comparison, not from the rules.
  Every stored hash names its algorithm (`sha256:<hex>`, `digest` and `digestMatches` in
  src/canonical.ts), so moving off SHA-256 changes one constant and leaves existing pins and audit
  logs readable; a hash naming an unknown algorithm matches nothing.
- **Open design.** Nothing depends on a secret. The source is public, the rules are fixed and
  published ([README.md](README.md#how-it-works), [src/suspicious.ts](src/suspicious.ts)), and the
  audit chain uses plain SHA-256 without a key (`AuditLog`), whose limit is stated under
  "Deleting the audit log" above.
- **Separation of privilege.** A new or changed tool takes two steps: the proxy saves it as pending,
  and only a person running `mcpcage approve` adds it to the pin, after a confirmation unless
  `--yes` (`savePending` and `approvePending` in src/pinstore.ts, `approve` in src/cli.ts).
  `protect --fix` asks for the word `yes` before it writes (`protect` in src/cli.ts). A release
  takes two steps too: the workflow stages it on npm, and npm serves it only once the maintainer
  approves it with two-factor authentication ([CONTRIBUTING.md](CONTRIBUTING.md#releasing)).
- **Least common mechanism.** Each session of a server runs in its own container, with a random
  name, removed on exit (`--rm` and `--name` in `runArgs`). Each server has its own directories for
  pins and audit logs (`serverDir` and `auditDir` in [src/paths.ts](src/paths.ts)), and no cage gets
  mcpcage's store (`sensitivePath`).
- **Psychological acceptability.** One command finds and cages the servers of every client
  (`protect --fix`), with the plan printed first. What a server wrote is shown with every invisible
  character spelled out, so the reviewer reads what the model reads (`terminalSafe` in
  [src/terminal.ts](src/terminal.ts)), and each sign of hidden instructions comes with one sentence
  for a non-expert (src/suspicious.ts).
- **Defense in depth.** The cage limits what a server reaches, the pin blocks changed definitions,
  the rules point at signs of hidden instructions, and the audit log records what happened. One
  failing does not leave the user open: a package malicious from the start passes the pin, which
  trusts its first listing, but not the cage. Single checks are doubled where a mistake would be
  costly: a server id must be a plain name (`checkServerId`) and the directory it leads to is
  checked again to be inside the store (`inStore`, both in src/paths.ts); a configuration file's
  type is checked before it is opened and again, with its size, on what was opened (`readConfigFile`
  in [src/clients.ts](src/clients.ts)).

### Common weaknesses

The [2024 CWE Top 25](https://cwe.mitre.org/top25/archive/2024/2024_top25_list.html), each with what
mcpcage does against it, or why it does not apply. mcpcage is a TypeScript program for Node.js with
no native code, no web interface, no database and no network listener. CodeQL with the
`security-extended` queries analyses every push to `main`, every pull request and the code once a
week ([codeql workflow](.github/workflows/codeql.yml)).

| Rank | Weakness | Applies | What mcpcage does |
|---|---|---|---|
| 1 | CWE-79 Cross-site scripting | No | mcpcage makes no web pages. The terminal's equivalent, a server's text with escape sequences that rewrite what the user reads, is countered: everything a server wrote is printed through `terminalSafe` (src/terminal.ts), which spells out control, format and invisible characters. |
| 2 | CWE-787 Out-of-bounds write | No | JavaScript on Node.js is memory-safe, and mcpcage has no native addons and no runtime dependencies that could bring one. |
| 3 | CWE-89 SQL injection | No | There is no database: pins, pending changes and audit logs are JSON files. |
| 4 | CWE-352 Cross-site request forgery | No | mcpcage serves no HTTP and listens on no port; the client talks to it over stdio. |
| 5 | CWE-22 Path traversal | Yes | A server id names a directory of the store: it must be a plain name (`checkServerId`), and the directory is checked again to be inside the store (`inStore`, src/paths.ts), so `--id ../../x` is refused. A mount is resolved as Docker resolves it, `..` included, before it is checked (`hostMount`, src/sandbox.ts), and `sensitivePath` (src/sensitive.ts) resolves `~`, `..` and symlinks before it decides whether a path would undo the cage. See "What you mount or allow" and "Hard links" under [Out of scope, and residual risks](#out-of-scope-and-residual-risks). |
| 6 | CWE-125 Out-of-bounds read | No | As CWE-787. |
| 7 | CWE-78 OS command injection | Yes | Every program mcpcage starts is spawned with an array of arguments and no shell (`runProxy` in src/proxy.ts, `docker` in src/sandbox.ts, `runNpm` in [src/npm-scripts.ts](src/npm-scripts.ts), `listTools` in [src/inspect.ts](src/inspect.ts)). On Windows, where a batch file starts only through `cmd.exe`, one is refused as the host command (`onHost`, src/cli.ts), and npm and npx run as the node that runs mcpcage with npm's own scripts (`npmProgram`, `npxProgram` in src/sandbox.ts). An entry whose arguments `cmd.exe` would read again is reported (`cmdWouldRead` in [src/launch.ts](src/launch.ts)); see "A `.cmd`/`.bat` mcpcage entry whose arguments cmd re-reads" above. In the Dockerfiles mcpcage writes, the npm package is shell-quoted (`shellQuote` in `prepareNpmImage`, src/sandbox.ts) and every `RUN` of a PyPI image is in exec form (`pypiDockerfile`). A command line printed for the user to paste is quoted for the shell, or not offered (`pasteable` in [src/protect.ts](src/protect.ts)). |
| 8 | CWE-416 Use after free | No | As CWE-787. |
| 9 | CWE-862 Missing authorization | Yes | A tool call reaches the server only if the tool is in the approved manifest; before anything is approved, every call is refused (`runProxy`). A request from the server to run the model or to question the user needs `--allow-server-requests` (`serverRequest`). |
| 10 | CWE-434 Unrestricted upload of a dangerous file | No | mcpcage takes no uploads. A server writes on the host only in a mount given as writable: see "Writable mounts" above. |
| 11 | CWE-94 Code injection | Yes | Nothing a server or a configuration sends is evaluated: there is no `eval`, `new Function` or `vm` on input. Install scripts never run (`--ignore-scripts` in `prepareNpmImage`); a PyPI package is installed from wheels only, and Python runs in the build only as `python -I -S`, so no `.pth` file runs (`pypiDockerfile`). `wrap` and `protect --fix` move the variables that would make mcpcage, node, docker or npm load code on the host (`NODE_OPTIONS`, `LD_PRELOAD`, `BASH_ENV`...) into the cage (`hostVariable` in [src/config.ts](src/config.ts)), and docker and npm get an environment of safe names only (`trustedEnv`); see the rows on `env` in [Adversaries in scope](#adversaries-in-scope). |
| 12 | CWE-20 Improper input validation | Yes | What a server sends is checked by its shape before it is used: JSON-RPC (`parseValues` and `isJsonRpc` in src/proxy.ts), a tool list (`isToolList` in src/manifest.ts), and the lock uv writes, where only pins with their hashes pass (`checkLock` in src/pypi.ts). Options are parsed strictly (`parseArgs` with `strict: true` in `parseRun`), and `--memory` and `--cpus` must be positive. The property-based tests throw generated input at these readers. |
| 13 | CWE-77 Command injection | Yes | Besides CWE-78: the arguments of `docker run` are separate items of an array, and a mount path with a comma, which would add options to Docker's `--mount` value, is refused (`hostMount`). npx and uvx flags that mcpcage does not know are refused, not passed on (`parseLaunch` and `parseUvx` in src/launch.ts). |
| 14 | CWE-287 Improper authentication | No | mcpcage has no accounts or logins: it runs as the user who started it ([trust boundary](#trust-boundaries) 1). Releases are published without a stored npm token, through the release job's OIDC token, and each version needs the maintainer's two-factor approval. |
| 15 | CWE-269 Improper privilege management | Yes | The server runs as user 65532 with every capability dropped and `no-new-privileges` (`runArgs`); the images mcpcage builds set that user themselves (`dockerfile`, `pypiDockerfile`). mcpcage needs no privilege beyond the user's access to Docker. |
| 16 | CWE-502 Deserialization of untrusted data | Yes | Untrusted data is read only with `JSON.parse`, into plain values. Keys a server chooses are stored in objects without a prototype (`sortKeys` in src/canonical.ts, `pinTools` in src/manifest.ts) and looked up as own properties only (`own`), so a tool or key named `__proto__` or `constructor` neither changes a prototype (CWE-1321) nor matches an inherited property. |
| 17 | CWE-200 Exposure of sensitive information | Yes | The audit log records a call's tool, the SHA-256 of its arguments and their keys, never their values, and of a result only success and size (`runProxy`, `AuditLog`). `protect` names the secrets it finds in configurations and never prints their values (`secretNames` and `looksLikeSecret` in src/protect.ts). A server gets none of the host's environment except the variables named for it (`runArgs`). |
| 18 | CWE-863 Incorrect authorization | Yes | A call passes only for a tool approved under that very name, which must be a string and is looked up as an own property (`own`), and only while the session is not locked (`runProxy`). Trust on first use covers the first listing only: a later page, or a page for a cursor the server did not issue in that listing, is compared with the pin, and no page replaces an approved definition (`checkFirstListing` and `checkTools` in src/manifest.ts). |
| 19 | CWE-918 Server-side request forgery | Partly | mcpcage fetches nothing from an address a server chooses: it reaches the npm registry and PyPI only, through npm, uv and docker, to build images and look up install scripts, and a caged server has no network unless `--allow-net`. The nearest risk is a path in a configuration that names another machine, which on Windows hands that host the user's NTLM response when looked at: such a path is told by its text and never opened (`networkPath` in [src/network-path.ts](src/network-path.ts)); see the row on paths on another machine in [Adversaries in scope](#adversaries-in-scope). |
| 20 | CWE-119 Memory buffer bounds | No | As CWE-787. |
| 21 | CWE-476 NULL pointer dereference | Partly | There are no pointers. Reading a property of `null` or `undefined`, the nearest error, is caught at compile time by TypeScript's `strict` and `noUncheckedIndexedAccess` ([tsconfig.json](tsconfig.json)), and input from a server is checked by its shape first (CWE-20). |
| 22 | CWE-798 Hard-coded credentials | No | The code holds no credentials, and the [release workflow](.github/workflows/release.yml) publishes with npm trusted publishing, without a stored token. |
| 23 | CWE-190 Integer overflow | No | JavaScript numbers are exact up to 2^53, and the sizes mcpcage counts (bytes of a line, tools, levels of nesting) stay far below that. |
| 24 | CWE-400 Uncontrolled resource consumption | Yes | A line from a server is never held past 16 MiB (`LineSplitter` and `MAX_LINE_BYTES` in [src/lines.ts](src/lines.ts)). A listing of more than 10,000 tools, or nested more than 256 levels deep, is refused before anything walks it (`MAX_TOOLS`, `MAX_DEPTH` and `nestedDeeperThan` in src/manifest.ts). The rules stop after 20,000 strings or 32 Mi characters (`scanWithinBudget` in src/suspicious.ts). mcpcage stops reading the server while the client is behind (`toClient` in `runProxy`), queues at most 1 MiB of log lines (`boundedLog` in src/terminal.ts) and reads configuration files of up to 16 MiB (`readConfigFile`). The container has memory, CPU and process limits (`runArgs`). The audit log has no rate limit: see "The rate of log entries" above. |
| 25 | CWE-306 Missing authentication for a critical function | No | mcpcage offers no function over a network: the client that started it is the only party on its stdin, and the user at the terminal approves changes ([trust boundary](#trust-boundaries) 1). |

Three weaknesses outside the Top 25 matter here too:

- **CWE-367, time of check to time of use.** A configuration file is checked again on the opened
  descriptor (`readConfigFile`). A rewritten configuration is written to a new temporary file and
  renamed over the old one, and its backup is created with a flag that fails if the name exists
  (`replaceFile` and `createBackup` in src/config.ts). The race that remains between two cages is
  "Two cages writing in one directory" above.
- **CWE-117, log injection.** Each line a server writes to its stderr reaches the client's log after
  the server's id in brackets, with control characters spelled out, so it cannot pass for a line of
  mcpcage's (`relay` in `runProxy`).
- **CWE-494, code downloaded without an integrity check.** An npm server is rebuilt from its
  lockfile with `npm ci`, which checks every integrity hash (`prepareNpmImage`); a PyPI server is
  installed with `uv pip sync --require-hashes` (`pypiDockerfile`); and every base image must be
  pinned by digest, or mcpcage refuses to start (`readBases` in src/sandbox.ts).
