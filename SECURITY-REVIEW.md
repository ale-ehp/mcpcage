# Security review

This document records a review of mcpcage's security: what was looked at, how, what was found, and what
was changed. It is the record the OpenSSF Best Practices gold criterion `security_review` asks for.

| | |
|---|---|
| Date | 8 November 2026 |
| Version reviewed | 0.7.1 (`main` at commit 88745dd, after pull requests #24 and #25) |
| Reviewer | Claude, an AI model made by Anthropic, working in the repository at the maintainer's request |
| Requested and accepted by | Alessandro Veneziano, the maintainer |
| Kind | Internal review by reading the code; no one outside the project took part |

## Scope and method

The review checked the claims of [THREAT-MODEL.md](THREAT-MODEL.md) against the code at the places
where untrusted data or authority crosses a boundary. Each claim below was read in the code and
compared with the sentence in the threat model that makes it.

Reviewed:

- `src/proxy.ts`: the proxy between client and server (`runProxy`, `fromServerLine`, `fromServer`,
  `isJsonRpc`, `parse`, the audit calls).
- `src/audit.ts`, `src/canonical.ts`: the hash chain and the digests.
- `src/manifest.ts`, `src/pinstore.ts`: pinning, comparison, the store's reads and writes.
- `src/sandbox.ts`: `runArgs` (the `docker run` command), `dockerfile`, the build's install step, the
  checks on mount paths.
- `src/launch.ts`: the reading of `npx` command lines and package specs.
- `src/paths.ts`: the check of server ids and of paths inside the store.

Not reviewed in this pass: `src/protect.ts` and `src/config.ts` (the rewriting of client
configurations), `src/pypi.ts` and `src/uv-settings.ts` (the Python build and uv settings),
`src/suspicious.ts` (the rules), `src/inspect.ts`, `src/windows-places.ts`, the Windows-specific
paths, the release workflow, and the container images. Nothing was run against a real Docker daemon
or a hostile server; the existing tests and property-based tests were not extended for this review.

## What was checked, and the result

| Claim in the threat model | Where | Result |
|---|---|---|
| The server gets no network, a read-only root, no capabilities, no new privileges, 128 processes, a memory and CPU limit, no IPC, user 65532, and nothing is pulled at run time | `runArgs` | Holds. Each option is in the command; the network is `none` unless `--allow-net`, and `--pull never` is passed. |
| A mount is read-only unless `:rw` is written, and a path with a comma cannot add fields to `--mount` | `mountPath`, the checks near `source.includes(",")` | Holds. Paths with commas are refused in each place that builds a `--mount` value. |
| An environment variable name cannot become a docker option | `runArgs` | Holds. Each is passed as the separate argument after `-e`, so a name that starts with `-` is a value, not an option. |
| A package spec cannot add options to `npm install` | `parseLaunch`, `splitPackageSpec`, the install step | Holds. Every leading word that starts with `-` is either a known flag or an error, so the spec cannot start with one, and the spec is shell-quoted in the Dockerfile. |
| A call to a tool that is not approved never reaches the server, a notification included | `runProxy`, client side | Holds. The check runs for every `tools/call`, with or without an id, and looks the name up with `own`, so `__proto__` and `constructor` find nothing. |
| An argument nested too deep cannot crash the proxy | `nestedDeeperThan` and its uses | Holds for what the server sends. Ids of requests from the server are checked to be a string or a number before anything records them (`isJsonRpc`); unsolicited ids and results are measured before they are written. |
| Only JSON-RPC by shape, answering something the client waits for, reaches the client | `fromServerLine`, `fromServer` | Holds. |
| A tool named `__proto__` or `constructor`, or a key of that name, cannot hide a change | `canonicalJson`, `pinTools`, `own` | Holds. The sorted copy has no prototype, and the pin is built without one. |
| The audit chain detects edits, reordering and deletions inside a file | `AuditLog`, `verifyAuditFile`, `digestMatches` | Holds, and an unknown algorithm name or a wrong length fails closed. The limits the threat model states (cut at the end, whole file replaced, hashes not keyed) are real. |
| The store is readable by the user only | `writeJson`, `AuditLog` | Holds for the modes set when a directory or file is created. A file or directory that already existed keeps its own mode; the store lives in the user's own directory, so this needs the same user. |
| The audit log holds hashes of arguments, not the arguments | the `call` entry | Holds. |

## Findings

No defect was found in the code reviewed that lets a server escape the cage, run a call to an
unapproved tool, crash or stall the proxy, or alter the audit chain undetected.

Three behaviors that the threat model did not state were found. None is a change in code; each is now
written down under "Out of scope, and residual risks" in THREAT-MODEL.md:

1. **`_meta` is not part of a tool's fingerprint.** It is left out on purpose (`toolFingerprint`),
   because the specification does not have the model read it. A change there is not blocked. A client
   that does use `_meta` is outside what the pin protects.
2. **Notifications from the server pass unread.** They are checked for shape and size only. The
   rules that look for hidden instructions read tool results, not notifications, so text in a logging
   notification reaches a client that shows it.
3. **mcpcage does not restrict where npm takes a package from.** `npx` entries naming a git URL or
   GitHub shorthand are handed to `npm install` in the build like a registry name. The build runs with
   scripts disabled and the server runs in the cage, but the registry's integrity guarantees are those
   of npm for that source.

## Limits of this review

- It was done by an AI model by reading code, in one session. It can miss what a person with a
  different method would find, and it did not run an attack.
- It was requested by the project's only maintainer, and no one independent of the project took part.
- Most of the code was not read in this pass (see "Not reviewed").
- The container images, the release workflow and Docker itself were not examined.

## Next review

A further review is due when the proxy, the sandbox or the rewriting of configurations changes in a
larger way, and at the latest in November 2027. The files not covered here are first in line. A
review by someone outside the project would add what this one cannot.
