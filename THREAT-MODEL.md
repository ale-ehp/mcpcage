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
| A trusted package that turns malicious in an update (rug pull) | postmark-mcp after fifteen clean releases | The lockfile keeps the approved version until `--rebuild`. When the update arrives, changed tool definitions block the session until a human approves them. |
| Tool poisoning through descriptions | hidden instructions in a tool description | Every description and schema is fingerprinted; a change is shown by `mcpcage diff` and blocked until approved. Fixed rules point at the signs of hidden instructions (privileged tags, "ignore previous instructions", "do not tell the user", secret files, invisible characters, orders about other tools) so the reviewer does not have to find them alone. The first manifest is trusted unless `--strict` is used. |
| Instructions hidden in invisible characters | zero-width text, Unicode Tags, bidi controls, variation selectors in a description | The same rules report them as high-severity signs, decode Unicode Tags to the text they spell, and show every invisible character as `[U+XXXX]`, so what the reviewer reads is what the model reads. |
| A server that pollutes stdout | logs or binary output on the JSON-RPC channel | Non-JSON lines are dropped and recorded. |
| A server that asks to call tools outside its manifest | a call routed to a tool the user never saw | Calls to tools that are not approved never reach the server. |
| A server written into a client configuration without the user's knowledge | SANDWORM_MODE adding entries to Claude Code, Cursor and Windsurf configs | `mcpcage protect` reads every configuration file the clients document and lists each server with how it starts, what it can reach and whether it is caged; `--fix` cages the npx ones. |
| Someone editing the audit trail after the fact | removing the record of a call | The hash chain makes edits, reordering and deletions inside a file detectable. |

## Trust boundaries

1. **Client and mcpcage, same user.** mcpcage trusts the client and the configuration it is given.
   Anyone who can edit the client configuration can remove mcpcage from it. `mcpcage protect`
   reads those configurations and, only with `--fix` and a confirmation, rewrites the server
   entries of a file after writing a backup next to it; everything else in the file is kept.
2. **mcpcage and the container.** The server's process, files and network live behind Docker's
   isolation. mcpcage only parses newline-delimited JSON from it and never executes what it sends.
   `--inspect` starts a server in the same cage, with its path arguments mounted read-only, only to
   read its tool list.
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
  paths a server is configured with read-write, because the server is expected to work there, but
  never the whole disk, the home directory or a directory with credentials or system files
  (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `/etc`, the Docker socket, mcpcage's own
  `~/.mcpcage`...): a server that needs one is left uncaged, with the reason, and the report names
  the path. `mcpcage run` refuses such a `--mount` unless `--allow-sensitive-mount` is given; with
  it, the server can use that path like any other.
- **Sensitive paths during `protect --inspect`.** To list a server's tools, `--inspect` mounts its
  path arguments read-only, without network, the sensitive ones included. In that time a server
  could copy what it reads there into its tool descriptions or its error output, and the report
  prints parts of both.
- **Misuse of granted capabilities.** A filesystem server with a writable mount can still
  overwrite files in that mount when asked to; mcpcage records the call but does not judge it.
- **Prompt injection through tool results.** Data a tool returns can still steer the model. The
  cage limits what a misled model can reach through that server, not what it decides.
- **The highlighter is a set of fixed rules, not a verdict.** A paraphrased instruction can avoid
  every rule, and a legitimate description can trip one. The block comes from the pin, which sees
  any change; the rules only explain what they recognize. They are deliberately not a model: an
  attacker can tune a text against a classifier, and the same text must give the same answer
  every time.
- **Trust on first use.** The first manifest is trusted. If the package was malicious from the
  start, the cage is the protection, not the pin. `--strict` requires an explicit review instead,
  and `protect --inspect` shows the signs in a server's tools before you approve anything.
- **Deleting the audit log.** The chain proves that a file was not altered, not that it still
  exists. Shipping entries to an external store is not implemented yet.
- **Prompts and resources.** Their descriptions are not pinned yet.
- **Remote MCP servers.** Nothing runs locally to cage; they are out of scope. `protect` lists
  them and reports credentials written in clear text in their headers.
- **Servers not started with `npx`.** `uvx`, `node`, `bun` or a binary run on the host as before;
  `protect` reports them as not caged and cannot fix them yet.
- **The Docker daemon itself.** Whoever controls it controls the containers.
- **`--no-sandbox`.** It keeps pinning and audit but provides no isolation at all. `protect` counts
  such entries as exposed.
- **Configuration files mcpcage will not rewrite.** A file with comments (VS Code's `mcp.json`) is
  left for the user to edit by hand, and `~/.claude.json` is left alone while Claude Code is
  running, because Claude Code rewrites it while it runs. `protect` prints the exact command to
  put in the file instead.
