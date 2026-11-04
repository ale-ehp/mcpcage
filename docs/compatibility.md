# Compatibility

Does the MCP server you use run in mcpcage's cage? This page lists the 24 MCP servers started with
`npx` that npm counts the most downloads for, and what each one did when started through
`mcpcage run` with the cage's defaults: no network, a read-only root, user 65532, no folder of
yours unless it is mounted.

Tested with mcpcage 0.6.1 and the two fixes this run found (see [What the run found in
mcpcage](#what-the-run-found-in-mcpcage)), on 2026-11-04 (UTC):

- **macOS**: macOS 15.6.1 on Apple silicon, Colima 0.10.3, Docker 29.5.2 (classic builder,
  containerd image store), Node 26.8.
- **Windows**: Windows 10 Enterprise LTSC 21H2 (x64), Docker Desktop 4.49.0 (engine 28.5.1,
  BuildKit), Node 24.15.
- **Linux**: the [compat workflow](../.github/workflows/compat.yml) runs the same list on
  ubuntu-latest every week, and by hand, and puts its table in the job's summary.

To run it yourself, with Docker and the network:

```bash
npm ci
npm run compat                               # all of them: about 10 minutes on the Mac, 30 on the Windows PC
npm run compat -- --only filesystem,memory   # some of them
```

The list and how each server is started are in [test/compat/servers.json](../test/compat/servers.json),
the runner is [test/compat/run.mjs](../test/compat/run.mjs). It writes `compat-out/compat.json`,
`compat-out/compat.md` and each build's and start's stderr in `compat-out/logs`, removes the images
it built (unless `--keep-images`) and its temporary folder, and exits 1 when a result is not the
one servers.json expects.

## What a result means

- **ok**: the image was built from npm with install scripts disabled, and in the cage, through
  mcpcage's proxy, the server answered `initialize`, listed its tools, and answered the one call
  named in the notes, where there is one.
- **needs network**: it fails in the cage as it is, and works with `--allow-net`. The runner tries
  every failure again with `--allow-net` and keeps both results.

A listed tool is not a working tool. Most of these servers call a web service, and in the cage,
without `--allow-net` and a real key, those calls fail: that is the cage doing its job. What cannot
work in the cage at all is in the notes.

## Results

| Package | Downloads, last week | Version tested | macOS, Colima | Windows, Docker Desktop | Linux | Notes |
|---|---:|---|---|---|---|---|
| `@playwright/mcp` | 10,188,231 | 0.0.84 | ok, 25 tools | ok, 25 tools | see the compat workflow | Its browser tools fail: no browser in the cage ([browsers](#browsers-and-shells)) |
| `@modelcontextprotocol/server-pdf` | 2,278,311 | 2.0.4 | ok, 9 tools | ok, 9 tools | see the compat workflow | Started as its README writes it, `npx -y --silent ... --stdio`, which 0.6.1 refused ([fix](#what-the-run-found-in-mcpcage)); call: `list_pdfs` |
| `chrome-devtools-mcp` | 1,876,272 | 1.12.0 | ok, 32 tools | ok, 32 tools | see the compat workflow | Its tools fail: no Chrome in the cage ([browsers](#browsers-and-shells)) |
| `@modelcontextprotocol/server-filesystem` | 1,294,151 | 2.2.0 | ok, 16 tools | ok, 16 tools | see the compat workflow | A folder mounted read-only; call: `list_allowed_directories`, which names it (on Windows at `/c/Users/...`) |
| `mcp-remote` | 1,260,396 | 0.16.0 | needs network: with it, 3 tools | needs network: with it, 3 tools | see the compat workflow | A bridge to a remote server, here DeepWiki's, which needs no key ([network](#network)) |
| `@upstash/context7-mcp` | 741,246 | 4.5.0 | ok, 2 tools | ok, 2 tools | see the compat workflow | Its calls fetch documentation: they need `--allow-net` |
| `@wonderwhy-er/desktop-commander` | 724,305 | 0.3.1 | ok, 25 tools | ok, 25 tools | see the compat workflow | Call: `get_config`. Its commands fail: no shell in the cage ([shells](#browsers-and-shells)) |
| `@notionhq/notion-mcp-server` | 387,210 | 2.6.1 | ok, 24 tools | ok, 24 tools | see the compat workflow | Starts without a token |
| `@modelcontextprotocol/server-everything` | 315,517 | 2.2.1 | ok, 16 tools | ok, 16 tools | see the compat workflow | Call: `echo` |
| `@modelcontextprotocol/server-memory` | 297,809 | 2.1.0 | ok, 9 tools | ok, 9 tools | see the compat workflow | Call: `read_graph`. To write, it needs `MEMORY_FILE_PATH` in a writable mount ([writing](#writing)) |
| `hostinger-api-mcp` | 278,207 | 3.28.5 | ok, 3 tools | ok, 3 tools | see the compat workflow | Starts without a token |
| `@sentry/mcp-server` | 237,679 | 0.42.0 | ok, 9 tools | ok, 9 tools | see the compat workflow | Dummy `SENTRY_ACCESS_TOKEN`: refuses to start without one ([keys](#keys)) |
| `@zereight/mcp-gitlab` | 226,163 | 2.3.21 | ok, 40 tools | ok, 40 tools | see the compat workflow | Dummy `GITLAB_PERSONAL_ACCESS_TOKEN` ([keys](#keys)) |
| `@pandacss/mcp` | 224,180 | 2.5.0 | ok, 12 tools | ok, 12 tools | see the compat workflow | Given `--cwd` and a mounted folder with a `panda.config.mjs` ([working directory](#working-directory)); call: `get_config` |
| `@supabase/mcp-server-supabase` | 205,830 | 0.15.0 | needs network: with it, 19 tools | needs network: with it, 19 tools | see the compat workflow | Dummy `SUPABASE_ACCESS_TOKEN` ([keys](#keys)); `--read-only` |
| `@modelcontextprotocol/server-github` | 189,189 | 2025.4.8 | ok, 26 tools | ok, 26 tools | see the compat workflow | Archived reference server; starts without a token |
| `mongodb-mcp-server` | 186,455 | 3.2.2 | ok, 18 tools | ok, 18 tools | see the compat workflow | `--readOnly`; starts without a connection string |
| `@modelcontextprotocol/server-slack` | 185,396 | 2025.4.25 | ok, 8 tools | ok, 8 tools | see the compat workflow | Archived reference server; dummy `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID` ([keys](#keys)) |
| `@modelcontextprotocol/server-sequential-thinking` | 183,170 | 2.1.1 | ok, 1 tool | ok, 1 tool | see the compat workflow | Call: `sequentialthinking` |
| `@azure/mcp` | 161,645 | 4.0.0-beta.5 | ok, 73 tools | ok, 73 tools | see the compat workflow | `server start`, with `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` ([.NET](#net)) |
| `figma-developer-mcp` | 159,735 | 0.13.2 | ok, 2 tools | ok, 2 tools | see the compat workflow | `--stdio`; dummy `FIGMA_API_KEY` ([keys](#keys)) |
| `next-devtools-mcp` | 159,006 | 0.4.0 | ok, 4 tools | ok, 4 tools | see the compat workflow | |
| `@modelcontextprotocol/server-postgres` | 155,598 | 0.6.2 | ok, 1 tool | ok, 1 tool | see the compat workflow | Archived reference server; given a database URL it cannot reach, it connects only to answer a query |
| `firecrawl-mcp` | 147,462 | 3.37.0 | ok, 26 tools | ok, 26 tools | see the compat workflow | Starts without a key |

Downloads are npm's for 2026-10-28 to 2026-11-03. The version tested is the one npm's `latest`
gave on the day; the weekly run tests whatever `latest` is then. The two systems gave the same
results and the same versions.

## Notes

### Browsers and shells

The image mcpcage builds has Node and the package, nothing else: no shell, no browser, and with
install scripts disabled and no network, nothing can be fetched when the server runs. So:

- `@playwright/mcp` lists its tools, and `browser_navigate` to `about:blank` answers
  `Error: async initializeServer: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome`
  and `Run "npx playwright install chrome"`.
- `chrome-devtools-mcp` lists its tools, and `new_page` answers
  `Could not find Google Chrome executable for channel 'stable' at: /opt/google/chrome/chrome.`
- `@wonderwhy-er/desktop-commander` lists its tools, and `start_process` with `echo hello` answers
  `Error: Failed to get process ID. The command could not be executed.` Its file tools work on
  mounted folders.

### Writing

`@modelcontextprotocol/server-memory` keeps its graph next to its own code, which is read-only in
the cage: `create_entities` answers
`EROFS: read-only file system, open '/app/node_modules/@modelcontextprotocol/server-memory/dist/memory.jsonl.lock'`.
Give it a file in a writable mount, and it writes there (checked on the Mac):

```json
{
  "command": "mcpcage",
  "args": ["run", "--mount", "/Users/me/memory:rw", "--env", "MEMORY_FILE_PATH", "--", "npx", "-y", "@modelcontextprotocol/server-memory"],
  "env": { "MEMORY_FILE_PATH": "/Users/me/memory/memory.jsonl" }
}
```

### Keys

Five servers refuse to start without a key, in the cage or not. Started without one outside the
cage, in a plain `node:22-bookworm-slim` container with the network:

| Package | What it says |
|---|---|
| `@sentry/mcp-server` | `Error: No access token was provided.` |
| `@zereight/mcp-gitlab` | `GITLAB_PERSONAL_ACCESS_TOKEN environment variable is not set` |
| `@supabase/mcp-server-supabase` | `Please provide a personal access token (PAT) with the --access-token flag or set the SUPABASE_ACCESS_TOKEN environment variable` |
| `@modelcontextprotocol/server-slack` | `Please set SLACK_BOT_TOKEN and SLACK_TEAM_ID environment variables` |
| `figma-developer-mcp` | `Either FIGMA_API_KEY or FIGMA_OAUTH_TOKEN is required (via CLI argument or .env file)` |

The run gives each a dummy value, by name (`--env NAME`), so the value never appears in the
arguments; with it, each starts and lists its tools. Notion, Hostinger, Firecrawl, GitHub, MongoDB
and Context7 start without one.

### Network

- `mcp-remote` connects to the remote server as it starts. In the cage it stops on
  `[7] Connection error: TypeError: fetch failed`, caused by
  `getaddrinfo EAI_AGAIN mcp.deepwiki.com`, and mcpcage says
  `the server exited (code 1) with 1 request unanswered`. With `--allow-net` it passes on
  DeepWiki's 3 tools. A bridge to a remote server is the network by design: caging it keeps it
  away from your files, not from the network.
- `@supabase/mcp-server-supabase` asks Supabase's API to answer `tools/list`, which in the cage
  answers `MCP error -32603: fetch failed`. With `--allow-net` it lists 19 tools, with a dummy
  token.

### Working directory

Under `npx`, a server runs in the client's working directory. In the cage it runs in the image's
`/app`, and sees only what is mounted. `@pandacss/mcp` reads the Panda project of its working
directory, and without one stops on
``PandaError: Cannot find config file `panda.config.{ts,js,mjs,mts}`. Did you forget to run `panda init`?``,
in the cage and outside it alike. It takes `--cwd`: give it the project and mount the project.

### .NET

`@azure/mcp` is a .NET program, which needs the system's ICU library. Neither the cage's image
(distroless) nor `node:22-bookworm-slim` has it, and in both it stops on
`Couldn't find a valid ICU package installed on the system.` With
`DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` it runs without ICU: in the cage it starts and lists 73
tools; in `node:22-bookworm-slim` it then stops on `No usable version of libssl was found`.

### Windows

All 24 gave on Windows what they gave on macOS. A mounted folder is at its place in the Linux
container, `C:\Users\me\x` at `/c/Users/me/x`: that is the folder `list_allowed_directories`
names, and the path the model has to use (see [Windows](../README.md#windows) in the README).

## How the 24 were chosen

The evidence, gathered on 2026-11-04:

- **npm's downloads**, from `https://api.npmjs.org/downloads/point/last-week/<package>`, for the
  week 2026-10-28 to 2026-11-03.
- **The official MCP Registry**, `https://registry.modelcontextprotocol.io/v0/servers`, read whole:
  56,766 entries (one per version of a server), which name 14,729 npm packages.
- **npm's search** for `keywords:mcp`, `keywords:mcp-server`, `keywords:modelcontextprotocol`,
  `keywords:model-context-protocol`, `mcp server` and `mcp`: 8,061 packages with their weekly
  downloads, to find popular servers the registry does not list.
- **The [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) README**: its
  reference servers and the archived ones.

The list holds every npm package whose purpose is an MCP server started over stdio with
`npx -y <package>`, in the order of its downloads, down to `firecrawl-mcp` (147,462). Of the
reference servers, everything, filesystem, memory and sequential-thinking are npm packages and in
the list; fetch, git and time are Python packages started with `uvx`, which mcpcage does not cage
yet. Three archived ones are still downloaded more than 150,000 times a week, and are in the list:
github, slack and postgres.

Left out:

| Package | Downloads | Why |
|---|---:|---|
| `shadcn` | 17,253,807 | A CLI that adds UI components; `shadcn mcp` is one of its commands, and its downloads do not count MCP use |
| `firebase-tools` | 4,626,429 | Firebase's CLI, same: `firebase mcp` |
| `@storybook/addon-mcp` | 3,482,577 | A Storybook addon, served by Storybook's dev server over HTTP, not started with npx |
| `@storybook/mcp` | 2,761,305 | A library with no program to run: npx cannot start it |
| `color-space`, `telnyx`, `e2e`, `rea-agents` | 1.23 M, 740 k, 648 k, 520 k (npm search) | Listed in the registry, but a color library, an API SDK, a testing SDK and a reverse engineering CLI, whose downloads do not count MCP use |
| `snyk` | 796,877 | Snyk's CLI, same as Firebase's: `snyk mcp` |
| `agent-device` | 684,875 | A CLI first ("a CLI, MCP server, and typed Node.js API"), which drives apps on devices and simulators through adb and simctl on your machine, out of a Linux container's reach |
| `@swmansion/argent` | 226,085 | Drives the iOS Simulator and Android emulators on your machine, same |
| `@hostinger/mcp` | 200,508 | The same code as `hostinger-api-mcp`, tested under that name |

Below the line: `@azure-devops/mcp` (146,490), `xcodebuildmcp` (135,695, which needs Xcode on
macOS) and `@sap-ux/fiori-mcp-server` (128,468).

## What the run found in mcpcage

Fixed in this change, each with a test that fails without the fix:

- **`npx --silent` was refused.** `@modelcontextprotocol/server-pdf`'s README configures
  `npx -y --silent @modelcontextprotocol/server-pdf --stdio`, and mcpcage 0.6.1 answered
  `mcpcage: unsupported npx flag --silent`; `wrap` and `protect --fix` left such an entry uncaged.
  `-s` and `--silent` only set npm's log level, like `-q` and `--quiet`, which were accepted.
- **A fresh install could come from Docker's build cache.** A build that resolves a package, for a
  new server or with `--rebuild`, writes the same Dockerfile and copies the same files every time,
  so `npm install <package>@latest` came from whatever an earlier build of that package had left in
  the cache. On the Mac a new server-filesystem got 2.1.0, from a build made hours before, while
  npm's latest was 2.2.0. Those builds now pass `--no-cache`; a build from the pinned lockfile still
  uses the cache.

Not fixed, for later:

- **With Docker's classic builder, each build leaves 8 untagged images behind.** Colima without
  buildx uses the classic builder, which keeps every step of both stages as an image: a run of the
  24 servers with `--keep-images` left 216 new images on the Mac, 9 per build, of which only the
  final one is tagged and labeled `mcpcage.server`, so a cleanup by that label misses the others.
  The install stage holds the whole npm tree, and nothing in mcpcage removes them, after a
  `--rebuild` either. With BuildKit (Docker Desktop, Docker on Linux with buildx) a build leaves
  only its final image, and a cache that `docker builder prune` empties.
