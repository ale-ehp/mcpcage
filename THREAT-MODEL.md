# Threat model

mcpcage protects the person running an MCP client from the MCP servers that client starts.

## Assets

- Files in the user's home directory: SSH keys, cloud credentials, source code, documents.
- Secrets in the environment of the client process.
- The integrity of what the model is told about each tool (descriptions and schemas), because the
  model acts on it.
- A trustworthy record of what each server was asked to do.

## Adversaries in scope

| Adversary | Example | What mcpcage does |
|---|---|---|
| A malicious package from the start | a lookalike of a popular server | It runs in a container with no network, no home directory, a read-only filesystem, no capabilities and a nonroot user. Install scripts never run. |
| A trusted package that turns malicious in an update (rug pull) | postmark-mcp after fifteen clean releases | The lockfile keeps the approved version until `--rebuild`. When the update arrives, changed tool definitions block the session until a human approves them. |
| Tool poisoning through descriptions | hidden instructions in a tool description | Every description and schema is fingerprinted; a change is shown by `mcpcage diff` and blocked until approved. The first manifest is trusted unless `--strict` is used. |
| A server that pollutes stdout | logs or binary output on the JSON-RPC channel | Non-JSON lines are dropped and recorded. |
| A server that asks to call tools outside its manifest | a call routed to a tool the user never saw | Calls to tools that are not approved never reach the server. |
| Someone editing the audit trail after the fact | removing the record of a call | The hash chain makes edits, reordering and deletions inside a file detectable. |

## Trust boundaries

1. **Client and mcpcage, same user.** mcpcage trusts the client and the configuration it is given.
   Anyone who can edit the client configuration can remove mcpcage from it.
2. **mcpcage and the container.** The server's process, files and network live behind Docker's
   isolation. mcpcage only parses newline-delimited JSON from it and never executes what it sends.
3. **Build time and run time.** Building the image needs the npm registry; running it does not.
   Packages are fetched once, recorded by integrity hash and reused from the lockfile.

## Out of scope, and residual risks

- **Container escapes.** mcpcage relies on Docker and the kernel. A kernel or runtime vulnerability
  can break the isolation. gVisor or microVM runtimes are on the roadmap for stronger isolation.
- **What you mount or allow.** A server given `--mount ~/.ssh` or `--allow-net` can use them.
  Mounts are read-only unless `:rw` is written explicitly.
- **Misuse of granted capabilities.** A filesystem server with a writable mount can still
  overwrite files in that mount when asked to; mcpcage records the call but does not judge it.
- **Prompt injection through tool results.** Data a tool returns can still steer the model. The
  cage limits what a misled model can reach through that server, not what it decides.
- **Trust on first use.** The first manifest is trusted. If the package was malicious from the
  start, the cage is the protection, not the pin. `--strict` requires an explicit review instead.
- **Deleting the audit log.** The chain proves that a file was not altered, not that it still
  exists. Shipping entries to an external store is not implemented yet.
- **Prompts and resources.** Their descriptions are not pinned yet.
- **Remote MCP servers.** Nothing runs locally to cage; they are out of scope.
- **The Docker daemon itself.** Whoever controls it controls the containers.
- **`--no-sandbox`.** It keeps pinning and audit but provides no isolation at all.
