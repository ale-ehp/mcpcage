# Compatibility

Does the MCP server you use run in mcpcage's cage? This page lists the 24 MCP servers started with
`npx` that npm counts the most downloads for, and the 39 Python MCP servers started with `uvx`
that PyPI counts the most downloads for, and what each one did when started through `mcpcage run`
with the cage's defaults: no network, a read-only root, user 65532, no folder of yours unless it is
mounted.

The npx servers were tested with mcpcage 0.6.1 and the two fixes this run found (see [What the run
found in mcpcage](#what-the-run-found-in-mcpcage)), on 2026-11-04 (UTC):

- **macOS**: macOS 15.6.1 on Apple silicon, Colima 0.10.3, Docker 29.5.2 (classic builder,
  containerd image store), Node 26.8.
- **Windows**: Windows 10 Enterprise LTSC 21H2 (x64), Docker Desktop 4.49.0 (engine 28.5.1,
  BuildKit), Node 24.15.
- **Linux**: Ubuntu 24.04.5 on GitHub's ubuntu-latest runner, Docker 28.0.4, Node 22.23, with
  mcpcage 0.6.3, on 2026-11-05 (UTC), by the [compat workflow](../.github/workflows/compat.yml),
  which runs the same list every week, and by hand, and puts its table in the job's summary. Run by
  hand again on 2026-11-06 with the Python servers, on Ubuntu 26.04.1 by then, it gave the expected
  result for all 24 again, some in newer versions (two of them with more tools than the table says).

The Python servers were tested with the code of mcpcage 0.7.0, not released yet, on 2026-11-06
(UTC):

- **macOS**: macOS 15.6.1 on Apple silicon, Colima 0.10.3, Docker 29.5.2 (classic builder),
  Node 26.8.
- **Windows**: Windows 10 Enterprise LTSC 21H2 (x64), Docker Desktop 4.49.0 (engine 28.5.1,
  BuildKit), Node 24.15, for 9 of the 39 (see [Windows](#windows)).
- **Linux**: Ubuntu 26.04.1 (x64) on GitHub's ubuntu-latest runner, Docker 29.4.2, Node 22.23, by
  the compat workflow, run by hand on all 63 servers.

To run it yourself, with Docker and the network:

```bash
npm ci
npm run compat                               # all 63: about 15 minutes on GitHub's Linux runner
npm run compat -- --runner npx               # the 24 npx servers: about 10 minutes on the Mac, 30 on the Windows PC
npm run compat -- --runner uvx               # the 39 Python servers: about 27 minutes on the Mac
npm run compat -- --only filesystem,memory   # some of them
```

The list and how each server is started are in [test/compat/servers.json](../test/compat/servers.json),
the runner is [test/compat/run.mjs](../test/compat/run.mjs). It writes `compat-out/compat.json`,
`compat-out/compat.md` and each build's and start's stderr in `compat-out/logs`, removes the images
it built, each server's once it is checked (unless `--keep-images`), and its temporary folder, and
exits 1 when a result is not the one servers.json expects.

## What a result means

- **ok**: the image was built, from npm with install scripts disabled, or for a Python server from
  PyPI wheels only, each checked against its hash, with nothing built from source; and in the cage,
  through mcpcage's proxy, the server answered `initialize`, listed its tools, and answered the one
  call named in the notes, where there is one.
- **needs network**: it fails in the cage as it is, and works with `--allow-net`. The runner tries
  every failure again with `--allow-net` and keeps both results.
- **fails**: it fails in the cage, and with `--allow-net` too.
- **build fails**: mcpcage refuses to build its image: a package it needs has no wheel on PyPI, or
  none for the machine's architecture, or the release needs a version of a package that PyPI does
  not have. The reason is uv's, quoted in mcpcage's message (see [wheels only](#wheels-only)).

A listed tool is not a working tool. Most of these servers call a web service, and in the cage,
without `--allow-net` and a real key, those calls fail: that is the cage doing its job. What cannot
work in the cage at all is in the notes.

## Results

### npx servers

| Package | Downloads, last week | Version tested | macOS, Colima | Windows, Docker Desktop | Linux | Notes |
|---|---:|---|---|---|---|---|
| `@playwright/mcp` | 10,188,231 | 0.0.84 | ok, 25 tools | ok, 25 tools | ok, 25 tools | Its browser tools fail: no browser in the cage ([browsers](#browsers-and-shells)) |
| `@modelcontextprotocol/server-pdf` | 2,278,311 | 2.0.4 | ok, 9 tools | ok, 9 tools | ok, 9 tools | Started as its README writes it, `npx -y --silent ... --stdio`, which 0.6.1 refused ([fix](#what-the-run-found-in-mcpcage)); call: `list_pdfs` |
| `chrome-devtools-mcp` | 1,876,272 | 1.12.0 | ok, 32 tools | ok, 32 tools | ok, 32 tools | Its tools fail: no Chrome in the cage ([browsers](#browsers-and-shells)) |
| `@modelcontextprotocol/server-filesystem` | 1,294,151 | 2.2.0 | ok, 16 tools | ok, 16 tools | ok, 16 tools | A folder mounted read-only; call: `list_allowed_directories`, which names it (on Windows at `/c/Users/...`) |
| `mcp-remote` | 1,260,396 | 0.16.0 | needs network: with it, 3 tools | needs network: with it, 3 tools | needs network: with it, 3 tools | A bridge to a remote server, here DeepWiki's, which needs no key ([network](#network)) |
| `@upstash/context7-mcp` | 741,246 | 4.5.0 | ok, 2 tools | ok, 2 tools | ok, 2 tools | Its calls fetch documentation: they need `--allow-net` |
| `@wonderwhy-er/desktop-commander` | 724,305 | 0.3.1 | ok, 25 tools | ok, 25 tools | ok, 25 tools | Call: `get_config`. Its commands fail: no shell in the cage ([shells](#browsers-and-shells)) |
| `@notionhq/notion-mcp-server` | 387,210 | 2.6.1 | ok, 24 tools | ok, 24 tools | ok, 24 tools | Starts without a token |
| `@modelcontextprotocol/server-everything` | 315,517 | 2.2.1 | ok, 16 tools | ok, 16 tools | ok, 16 tools | Call: `echo` |
| `@modelcontextprotocol/server-memory` | 297,809 | 2.1.0 | ok, 9 tools | ok, 9 tools | ok, 9 tools | Call: `read_graph`. To write, it needs `MEMORY_FILE_PATH` in a writable mount ([writing](#writing)) |
| `hostinger-api-mcp` | 278,207 | 3.28.5 (Linux: 3.30.1) | ok, 3 tools | ok, 3 tools | ok, 3 tools | Starts without a token |
| `@sentry/mcp-server` | 237,679 | 0.42.0 | ok, 9 tools | ok, 9 tools | ok, 9 tools | Dummy `SENTRY_ACCESS_TOKEN`: refuses to start without one ([keys](#keys)) |
| `@zereight/mcp-gitlab` | 226,163 | 2.3.21 | ok, 40 tools | ok, 40 tools | ok, 40 tools | Dummy `GITLAB_PERSONAL_ACCESS_TOKEN` ([keys](#keys)) |
| `@pandacss/mcp` | 224,180 | 2.5.0 | ok, 12 tools | ok, 12 tools | ok, 12 tools | Given `--cwd` and a mounted folder with a `panda.config.mjs` ([working directory](#working-directory)); call: `get_config` |
| `@supabase/mcp-server-supabase` | 205,830 | 0.15.0 | needs network: with it, 19 tools | needs network: with it, 19 tools | needs network: with it, 19 tools | Dummy `SUPABASE_ACCESS_TOKEN` ([keys](#keys)); `--read-only` |
| `@modelcontextprotocol/server-github` | 189,189 | 2025.4.8 | ok, 26 tools | ok, 26 tools | ok, 26 tools | Archived reference server; starts without a token |
| `mongodb-mcp-server` | 186,455 | 3.2.2 | ok, 18 tools | ok, 18 tools | ok, 18 tools | `--readOnly`; starts without a connection string |
| `@modelcontextprotocol/server-slack` | 185,396 | 2025.4.25 | ok, 8 tools | ok, 8 tools | ok, 8 tools | Archived reference server; dummy `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID` ([keys](#keys)) |
| `@modelcontextprotocol/server-sequential-thinking` | 183,170 | 2.1.1 | ok, 1 tool | ok, 1 tool | ok, 1 tool | Call: `sequentialthinking` |
| `@azure/mcp` | 161,645 | 4.0.0-beta.5 | ok, 73 tools | ok, 73 tools | ok, 73 tools | `server start`, with `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` ([.NET](#net)) |
| `figma-developer-mcp` | 159,735 | 0.13.2 | ok, 2 tools | ok, 2 tools | ok, 2 tools | `--stdio`; dummy `FIGMA_API_KEY` ([keys](#keys)) |
| `next-devtools-mcp` | 159,006 | 0.4.0 | ok, 4 tools | ok, 4 tools | ok, 4 tools | Started with no key or setting |
| `@modelcontextprotocol/server-postgres` | 155,598 | 0.6.2 | ok, 1 tool | ok, 1 tool | ok, 1 tool | Archived reference server; given a database URL it cannot reach, it connects only to answer a query |
| `firecrawl-mcp` | 147,462 | 3.37.0 | ok, 26 tools | ok, 26 tools | ok, 26 tools | Starts without a key |

Downloads are npm's for 2026-10-28 to 2026-11-03. The version tested is the one npm's `latest`
gave on the day; the weekly run tests whatever `latest` is then. The three systems gave the same
results, with the same number of tools. The versions were the same too, except for
`hostinger-api-mcp`, whose `latest` was 3.30.1 by the day of the Linux run.

### Python servers

| Package | Downloads, 30 days | Version tested | macOS, Colima | Windows, Docker Desktop | Linux | Notes |
|---|---:|---|---|---|---|---|
| `mcp-for-blender` | 2,390,716 | 2.2.7 | ok, 9 tools | ok, 9 tools | ok, 9 tools | Its tools drive Blender on your machine, out of the cage's reach ([programs](#browsers-and-shells)); on Windows `cmd /c uvx mcp-for-blender`, as its README writes it ([Windows](#windows)) |
| `mcp-proxy-for-aws-cli` | 200,428 | 1.8.0 | needs network: with it, 8 tools | not run | needs network: with it, 8 tools | The uvx distribution of `mcp-proxy-for-aws` (1,560,583); `@latest`, with the AWS endpoint and `--region` of its README; dummy AWS credentials ([keys](#keys), [network](#network)) |
| `mcp-server-fetch` | 983,614 | 2026.11.4 | ok, 1 tool | not run | ok, 1 tool | Reference server; fetching a page needs `--allow-net` |
| `mcp-atlassian` | 846,838 | 0.23.1 | ok, 63 tools | not run | ok, 63 tools | Dummy Jira site and token: without them it lists no tools ([keys](#keys)) |
| `mcp-server-time` | 696,661 | 2026.11.4 | ok, 3 tools | ok, 3 tools | ok, 3 tools | Reference server; call: `get_current_time` for `Europe/Rome` |
| `postgres-mcp` | 682,825 | 0.3.0 | build fails | not run | build fails | Needs `pglast` 7.2.0, which PyPI does not have ([wheels only](#wheels-only)); its README starts it with `uv run` or `pipx`, run here as `uvx` |
| `mcp-proxy` | 568,849 | 0.14.0 | needs network: with it, 3 tools | not run | needs network: with it, 3 tools | A bridge to a remote server, here DeepWiki's, with `--transport streamablehttp` ([network](#network)); its README installs it with `uv tool install`, run here as `uvx` |
| `lean-lsp-mcp` | 528,117 | 0.33.0 | ok, 22 tools | not run | ok, 22 tools | Its tools need Lean, which the cage does not have ([programs](#browsers-and-shells)) |
| `mcp-grafana` | 513,836 | 2.2.0 | ok, 80 tools | not run | ok, 80 tools | Starts without a Grafana URL or token |
| `awslabs.aws-api-mcp-server` | 391,453 | 1.6.0 | needs network: with it, 2 tools | needs network: with it, 2 tools | needs network: with it, 2 tools | `@latest`, with `AWS_REGION`; fetches from AWS as it starts ([network](#network)) |
| `mcp-server-git` | 353,845 | 2026.11.4 | ok, 14 tools | not run | ok, 14 tools | Reference server; `GIT_PYTHON_REFRESH=quiet`, no `--repository`; its tools need git, which the cage does not have ([git](#git)) |
| `mcp-server-appwrite` | 338,578 | 2.4.2 | fails | not run | fails | As its self-hosted guide writes it; dummy project id and key, which it checks against Appwrite's API as it starts ([keys](#keys)) |
| `opensearch-mcp-server-py` | 310,725 | 0.12.0 | ok, 5 tools | not run | ok, 5 tools | Starts without a cluster: its tools take the cluster's URL on each call ([network](#network)) |
| `awslabs.aws-documentation-mcp-server` | 308,979 | 1.2.4 | ok, 5 tools | ok, 5 tools | ok, 5 tools | `@latest`; its tools fetch AWS's documentation: they need `--allow-net` |
| `mcpforunityserver` | 307,766 | 10.3.0 | ok, 48 tools | ok, 48 tools | ok, 48 tools | `uvx --from mcpforunityserver mcp-for-unity --transport stdio`, as its README writes it; its tools need the Unity Editor ([programs](#browsers-and-shells)) |
| `workspace-mcp` | 297,613 | 2.3.0 | ok, 43 tools | not run | ok, 43 tools | `--tool-tier core`; starts without Google OAuth credentials |
| `chroma-mcp` | 296,543 | 0.2.6 | fails | not run | fails | Stops on an `ImportError` from pydantic, outside mcpcage too ([upstream failures](#upstream-failures)) |
| `mcp-clickhouse` | 292,152 | 0.7.0 | ok, 3 tools | not run | ok, 3 tools | Its README starts it with `uv run --with` and `--python 3.12`, run here as plain `uvx`; starts without a ClickHouse server |
| `blender-mcp` | 269,807 | 2.0.0 | ok, 9 tools | not run | ok, 9 tools | The old name of `mcp-for-blender`, which it depends on and starts |
| `excel-mcp-server` | 255,098 | 2.2.6 | ok, 46 tools | not run | ok, 46 tools | `stdio --allow-dir` with a folder, mounted read-only |
| `langsmith-mcp-server` | 194,471 | 0.1.1 | ok, 15 tools | not run | ok, 15 tools | Starts without a LangSmith key |
| `awslabs.cloudwatch-mcp-server` | 186,262 | 0.3.1 | ok, 19 tools | ok, 19 tools | ok, 19 tools | `@latest`; starts without AWS credentials |
| `serena-agent` | 170,843 | 2.1.0 | build fails | not run | build fails | `uvx --python 3.13 --from serena-agent serena start-mcp-server`, as its README installs it with `uv tool install -p 3.13`; a dependency, `proxy-tools`, has no wheel ([wheels only](#wheels-only)) |
| `awslabs.aws-pricing-mcp-server` | 155,518 | 1.1.1 | ok, 9 tools | ok, 9 tools | ok, 9 tools | `@latest`; starts without AWS credentials |
| `jcodemunch-mcp` | 138,479 | 1.108.419 | ok, 6 tools | not run | ok, 6 tools | Started with no key or setting |
| `pagerduty-mcp` | 138,363 | 1.1.0 | ok, 101 tools | not run | ok, 101 tools | `--enable-write-tools`; dummy `PAGERDUTY_USER_API_KEY` ([keys](#keys)); slow to start in the cage ([network](#network)) |
| `analytics-mcp` | 130,629 | 1.0.0 | ok, 9 tools | not run | ok, 9 tools | Its README starts it with `pipx run`, run here as `uvx`; starts without Google credentials |
| `logfire-mcp` | 126,216 | 0.9.0 | fails | not run | fails | Archived; `@latest`, as its 0.8.0 README wrote it; stops on an import that logfire 5.4.0 does not have, outside mcpcage too ([upstream failures](#upstream-failures)) |
| `dbt-mcp` | 119,420 | 2.10.1 | build fails | not run | build fails | A dependency, `uuid` 1.30, has no wheel on PyPI ([wheels only](#wheels-only)) |
| `mcp-google-sheets` | 118,812 | 0.6.3 | fails | not run | fails | `@latest`; stops as it starts on an import that mcp 2.x removed, outside mcpcage too ([upstream failures](#upstream-failures)) |
| `duckduckgo-mcp-server` | 118,393 | 0.7.0 | ok, 3 tools | not run | ok, 3 tools | `--with duckduckgo-mcp-server[browser]`, as its README writes it for its browser backends, all from wheels |
| `awslabs.billing-cost-management-mcp-server` | 117,508 | 0.0.44 | ok, 50 tools | ok, 50 tools | ok, 50 tools | `@latest`, with `FASTMCP_LOG_FILE` in `/tmp`: it writes a log next to its code otherwise ([writing](#writing)) |
| `awslabs.aws-iac-mcp-server` | 111,347 | 1.0.26 | build fails | ok, 8 tools | ok, 8 tools | `@latest`; a dependency, `guardpycfn`, has no wheel for Linux on ARM, which the cage is on Apple silicon ([wheels only](#wheels-only)) |
| `markitdown-mcp` | 102,379 | 0.0.1a8 | ok, 1 tool | not run | ok, 1 tool | A pre-release, the only kind it has, which plain `uvx markitdown-mcp` resolved to; its README installs it with `pip`, run here as `uvx` |
| `elevenlabs-mcp` | 97,277 | 0.12.2 | ok, 27 tools | not run | ok, 27 tools | Dummy `ELEVENLABS_API_KEY` ([keys](#keys)) |
| `falcon-mcp` | 96,459 | 0.20.2 | fails | not run | fails | Plain `uvx`, since mcpcage refuses its README's `--env-file`; dummy credentials, which it checks against CrowdStrike's API as it starts ([keys](#keys)) |
| `serper-mcp-server` | 96,283 | 0.0.10 | fails | not run | fails | Stops as it starts with mcp 2.3.0, outside mcpcage too ([upstream failures](#upstream-failures)) |
| `freecad-mcp` | 94,384 | 0.1.28 | ok, 17 tools | not run | ok, 17 tools | Its tools drive FreeCAD on your machine, out of the cage's reach ([programs](#browsers-and-shells)) |
| `arxiv-mcp-server` | 88,803 | 0.8.2 | ok, 19 tools | not run | ok, 19 tools | `--python 3.11`, as its README says to when a client keeps an older environment |

Downloads are PyPI's over 30 days, as [hugovk/top-pypi-packages](https://hugovk.github.io/top-pypi-packages/)
gives them in its list of 2026-11-01, from PyPI's download dataset. The version tested is the newest
PyPI gave on the day; for the four that do not build on the Mac, it is the one uv resolved, which
its reason names. The weekly run tests whatever is newest then. Windows ran 9 of the 39. Where they
ran, the systems gave the same results, with the same versions and the same tools, by name, except
for `awslabs.aws-iac-mcp-server`, which builds on x86_64 and not on Apple silicon (see [wheels
only](#wheels-only)). The Mac's images were built from arm64 wheels, the Linux runner's from x64
ones.

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

A Python server's image has Python and the packages of its lock, nothing else either. Some drive a
desktop program on your machine through its add-on or plugin, out of the cage's reach:

- `mcp-for-blender` and `blender-mcp` drive Blender: in the cage they log
  `Failed to connect to Blender: [Errno 111] Connection refused` and list their 9 tools.
- `freecad-mcp` drives FreeCAD: it logs
  `Could not connect to FreeCAD on startup: Failed to connect to FreeCAD ([Errno 111] Connection refused)`
  and lists its 17 tools.
- `mcpforunityserver` drives the Unity Editor, and lists its 48 tools.

`lean-lsp-mcp` needs Lean, which the image does not have either; it lists its 22 tools.

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

`awslabs.billing-cost-management-mcp-server` writes its log next to its own code too, and started
as its README writes it, it stops in the cage on
`OSError: [Errno 30] Read-only file system: '/app/venv/lib/python3.13/site-packages/awslabs/logs'`.
Its code writes the log to the file `FASTMCP_LOG_FILE` names instead, a variable its README does not
document. The run gives it `FASTMCP_LOG_FILE=/tmp/billing-cost-management-mcp-server.log`, a file in
the cage's `/tmp`, and it starts and lists 50 tools.

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

Five of the Python servers refuse to start without a key too. Started in the cage without one, each
said, with `--allow-net` as without:

| Package | What it says |
|---|---|
| `mcp-proxy-for-aws-cli` | `No AWS credentials available. Configure credentials or use --skip-auth to send unsigned requests.` |
| `mcp-server-appwrite` | `APPWRITE_PROJECT_ID and APPWRITE_API_KEY must be set in environment variables` |
| `pagerduty-mcp` | `RuntimeError: An API key is required to call the PagerDuty API.` |
| `elevenlabs-mcp` | `ValueError: ELEVENLABS_API_KEY environment variable is required` |
| `falcon-mcp` | `Falcon API credentials not provided. Either pass client_id and client_secret parameters or set FALCON_CLIENT_ID and FALCON_CLIENT_SECRET environment variables.` |

The run gives them dummy values the same way. With them, `pagerduty-mcp` and `elevenlabs-mcp` start
and list their tools, and `mcp-proxy-for-aws-cli` does with `--allow-net` ([network](#network)).
The other two check the credentials against their service as they start, so a dummy one is not
enough:

- `mcp-server-appwrite` probes Appwrite's API, at `cloud.appwrite.io` when no endpoint is given,
  and stops on `Appwrite startup validation failed during the minimal startup probe`: in the cage
  after `Failed to resolve 'cloud.appwrite.io'`, with `--allow-net` after Appwrite answers
  `code=401, type=api_key_invalid`.
- `falcon-mcp` asks CrowdStrike's API for a token and stops on
  `Failed to authenticate with the Falcon API`: in the cage with HTTP 500, after
  `Failed to resolve 'api.crowdstrike.com'`, and with `--allow-net` with HTTP 401.

Both stop the same way when uvx runs them with the dummy values in a plain container with the
network, outside mcpcage. With real credentials and `--allow-net`, neither was tested.

`falcon-mcp`'s README starts it as `uvx --env-file /path/to/.env falcon-mcp`, which mcpcage refuses:
`uvx --env-file: reads a file on your machine, which the cage does not read when it builds`. Give
the variables by name instead, with `--env FALCON_CLIENT_ID --env FALCON_CLIENT_SECRET` and their
values in the entry's `env`, as the run does.

`mcp-atlassian` starts without its settings and lists 0 tools; given a dummy site, user and token
(`JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`), it lists 63. `mcp-grafana`,
`opensearch-mcp-server-py`, `workspace-mcp`, `langsmith-mcp-server`, `mcp-clickhouse`,
`analytics-mcp`, and AWS's CloudWatch and pricing servers start without one.

### Network

- `mcp-remote` connects to the remote server as it starts. In the cage it stops on
  `[7] Connection error: TypeError: fetch failed`, caused by
  `getaddrinfo EAI_AGAIN mcp.deepwiki.com`, and mcpcage says
  `the server exited (code 1) with 1 request unanswered`. With `--allow-net` it passes on
  DeepWiki's 3 tools. A bridge to a remote server is the network by design: caging it keeps it
  away from your files, not from the network.
- `mcp-proxy` is the same kind of bridge, here to DeepWiki's server with
  `--transport streamablehttp`. In the cage it stops on
  `httpx.ConnectError: [Errno -3] Temporary failure in name resolution`, and mcpcage says
  `the server exited (code 1) with 1 request unanswered`. With `--allow-net` it passes on
  DeepWiki's 3 tools.
- `@supabase/mcp-server-supabase` asks Supabase's API to answer `tools/list`, which in the cage
  answers `MCP error -32603: fetch failed`. With `--allow-net` it lists 19 tools, with a dummy
  token.
- `mcp-proxy-for-aws-cli` is a bridge too: it signs requests (SigV4) to AWS's remote MCP server.
  In the cage, `initialize` answers `MCP error -32602: Invalid request parameters`, and the server
  logs `Initialize failed in middleware.` and
  `httpx.ConnectError: [Errno -3] Temporary failure in name resolution`. With `--allow-net` and
  dummy credentials it lists 8 tools.
- `awslabs.aws-api-mcp-server` fetches AWS's service reference as it starts. In the cage it stops
  on `RuntimeError: Error retrieving the service reference document`, caused by
  `Failed to resolve 'servicereference.us-east-1.amazonaws.com' ([Errno -3] Temporary failure in name resolution)`,
  and mcpcage says `the server exited (code 1) with 1 request unanswered`. With `--allow-net` it
  lists 2 tools.
- `pagerduty-mcp` asks PagerDuty's API for its user as it starts
  (`GET https://api.pagerduty.com/users/me`). In the cage it tries three times
  (`retrying in 3 seconds`, then 6 and 12), logs `Failed to initialize user`, and goes on: it
  answered `initialize` after 21.9 seconds on the Mac and 23.5 on Linux, and listed its 101 tools.
- `opensearch-mcp-server-py` tries to fetch from `raw.githubusercontent.com` as it starts, and
  writes the failure on stdout, where only MCP messages belong:
  `Error generating tools: Cannot connect to host raw.githubusercontent.com:443 ssl:default [Temporary failure in name resolution]`.
  mcpcage drops the line and says so (`mcpcage: dropped output from the server that is not JSON-RPC`),
  and the server lists 5 tools. The runner tries `--allow-net` only after a failure, so whether it
  lists more with the network, this run does not say.

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

### Wheels only

For a Python server, mcpcage resolves the package and everything it needs into a lock, each package
with its hash, and builds the image from that lock with `uv pip sync --require-hashes --no-build`:
wheels only, so no package's code runs while the image is built. The image's Python is the one uv
installs, 3.13 unless the line asks for another (`arxiv-mcp-server` was run with `--python 3.11`). A
server that cannot be installed that way is refused before Docker builds anything, and mcpcage
quotes uv's reason. Three of the 39 are refused on the Mac and on Linux alike, and one on the Mac
only:

| Package | Version | uv's reason |
|---|---|---|
| `postgres-mcp` | 0.3.0 | `Because there is no version of pglast==7.2.0 and postgres-mcp>=0.3.0 depends on pglast==7.2.0, we can conclude that postgres-mcp>=0.3.0 cannot be used.` |
| `serena-agent` | 2.1.0 | `Because proxy-tools==0.1.0 has no usable wheels and only proxy-tools==0.1.0 is available, we can conclude that all versions of proxy-tools cannot be used.` `pywebview` 6.2 depends on `proxy-tools`, and `serena-agent` 2.1.0 on `pywebview` 6.2. |
| `dbt-mcp` | 2.10.1 | `Because uuid==1.30 has no usable wheels and all versions of dbtlabs-vortex depend on uuid==1.30, we can conclude that all versions of dbtlabs-vortex cannot be used.` `dbt-mcp` 2.10.1 depends on `dbtlabs-vortex`. |
| `awslabs.aws-iac-mcp-server` | 1.0.26 | On Apple silicon: `Because guardpycfn==0.1.0 has no usable wheels and awslabs-aws-iac-mcp-server>=1.0.26 depends on guardpycfn==0.1.0, we can conclude that awslabs-aws-iac-mcp-server>=1.0.26 cannot be used.` |

Each message starts with
`mcpcage: <package> cannot be installed from PyPI wheels on Python 3.13 for Linux on ARM (linux/arm64), and the cage never builds a package from source:`
on the Mac (`for Linux on x86_64 (linux/amd64)` on an x86_64 machine),
and for the last three uv adds
``hint: Wheels are required for `proxy-tools` because building from source is disabled for all packages (i.e., with `--no-build`)``
(with `uuid` for `dbt-mcp`, `guardpycfn` for `awslabs.aws-iac-mcp-server`).

A wheel can exist for one machine and not another. `guardpycfn` 0.1.0 ships three wheels, for
Linux on x86_64 (manylinux), macOS on arm64 and Windows on amd64, and none for Linux on ARM, which
is what the cage is on Apple silicon: Docker runs Linux containers there, on ARM. So mcpcage refuses
`awslabs.aws-iac-mcp-server` on the Mac, and builds it on the Linux runner and the Windows PC, both
x86_64, where it lists 8 tools. mcpcage's message names the platform the wheels were looked for,
`on Python 3.13 for Linux on ARM (linux/arm64)` on the Mac, so that the refusal says another
machine may run the server.

There is nothing to set in mcpcage for these: `--allow-net` does not help, since no image is built,
and the cage does not build from source. `serena-agent` and `dbt-mcp` will run caged once the
package without a wheel publishes one, or they stop needing it; `postgres-mcp`, once a release needs
a `pglast` that PyPI has; `awslabs.aws-iac-mcp-server` runs caged on x86_64 today, and on Apple
silicon once `guardpycfn` ships a wheel for Linux on ARM.

### Upstream failures

Four servers stop as they start, in the cage and with `--allow-net`, and stop the same way when uvx
runs them in a plain container with the network, outside mcpcage:

- `chroma-mcp` 0.2.6 stops on
  `ImportError: cannot import name 'eval_type_backport' from 'pydantic._internal._typing_extra'`,
  raised where the `mcp` package it installs imports it from pydantic.
- `mcp-google-sheets` 0.6.3 stops on
  `ModuleNotFoundError: No module named 'mcp.server.fastmcp'. This is mcp 2.x, where FastMCP was renamed to MCPServer`:
  it imports `mcp.server.fastmcp`, and its requirements let uv install mcp 2.x, which removed it.
- `logfire-mcp` 0.9.0, archived, stops on
  `ModuleNotFoundError: No module named 'logfire.experimental.query_client'`: its requirement
  `logfire>=3.7.1` lets uv install logfire 5.4.0, which does not have it. It stops before it reads a
  token, so the run gives it none.
- `serper-mcp-server` 0.0.10 stops on
  `AttributeError: 'Server' object has no attribute 'list_tools'`: its requirement `mcp>=1.6.0`
  lets uv install mcp 2.3.0, whose `Server` has no `list_tools`. It stops before it reads a key, so
  the run gives it none.

In each, mcpcage then says `the server exited (code 1) with 1 request unanswered`. They are for
their maintainers to fix: nothing in the cage changes them.

### Git

`mcp-server-git` works through GitPython, which runs the `git` program, and the cage's image has
none. Started without a setting for that, it stops on
`ImportError: Failed to initialize: Bad git executable.` The run sets `GIT_PYTHON_REFRESH=quiet`,
which lets the server start without git: it lists its 14 tools, which need git, so they cannot work
in the cage. It is started without `--repository`: given the run's folder, which is not a Git
repository, it stops on `is not a valid Git repository`.

### Windows

All 24 gave on Windows what they gave on macOS. A mounted folder is at its place in the Linux
container, `C:\Users\me\x` at `/c/Users/me/x`: that is the folder `list_allowed_directories`
names, and the path the model has to use (see [Windows](../README.md#windows) in the README).

Nine of the Python servers were run on Windows, seven of them with the line their README writes
for Windows:

- `cmd /c uvx mcp-for-blender`
- `uvx --from awslabs.aws-api-mcp-server@latest awslabs.aws-api-mcp-server.exe`, and the same for
  `awslabs.aws-pricing-mcp-server` and `awslabs.billing-cost-management-mcp-server`
- `uv tool run --from awslabs.aws-documentation-mcp-server@latest awslabs.aws-documentation-mcp-server.exe`,
  and the same for `awslabs.cloudwatch-mcp-server` and `awslabs.aws-iac-mcp-server`

and `uvx mcp-server-time` and `uvx --from mcpforunityserver mcp-for-unity --transport stdio` as on
the other systems. mcpcage cages each of these forms, and all nine gave what they gave on Linux:
the same versions, results and tools. On macOS too, except `awslabs.aws-iac-mcp-server`, which
does not build there ([wheels only](#wheels-only)).

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
the list; fetch, git and time are Python packages started with `uvx`, and are in the
[Python list](#python-servers). Three archived ones are still downloaded more than 150,000 times a
week, and are in the list: github, slack and postgres.

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

## How the 39 were chosen

The evidence:

- **PyPI's downloads** over 30 days for the 15,000 most downloaded projects, from
  [hugovk/top-pypi-packages](https://hugovk.github.io/top-pypi-packages/)
  (`top-pypi-packages-30-days.min.json`, updated 2026-11-01), which takes them from PyPI's download
  dataset. The 15,000th has 63,584.
- **The 77 of them with `mcp` in their name**, and each one's README, read for how it is started:
  PyPI's, or the project's own pages where PyPI's says less.

The list holds every one of them whose purpose is an MCP server started over stdio with `uvx`, or
with a command the run starts as `uvx`, in the order of its downloads, down to `arxiv-mcp-server`
(88,803). Where the README starts its server with `uv run`, `uv tool install`, `pip install` or
`pipx`, the run starts it with `uvx`, and the notes say so. `mcp-proxy-for-aws-cli` (200,428) is the
uvx distribution of `mcp-proxy-for-aws` (1,560,583), and stands in its place. `serena-agent`, whose
name does not say mcp, is in the list too, and so are the reference servers fetch, time and git.

Left out:

| Package | Downloads | Why |
|---|---:|---|
| `mcp`, `mcp-types`, `fastmcp`, `fastmcp-slim`, `langchain-mcp-adapters`, `fastapi-mcp`, `opentelemetry-instrumentation-mcp`, `openai-mcp-extensions`, `fastmcp-tasks`, `django-mcp-server`, `fastmcp-extensions`, `arcade-mcp-server`, `uipath-mcp`, `mcpadapt`, `mcp-use` | 293 M, 111 M, 60.9 M, 56.5 M, 7.20 M, 5.52 M, 2.16 M, 1.59 M, 957 k, 344 k, 180 k, 164 k, 153 k, 115 k, 72.8 k | Libraries and SDKs, not servers to start |
| `semgrep`, `browser-use`, `graphiti-core` | 23.2 M, 7.24 M, 873 k | Programs whose downloads do not count MCP use, as `shadcn` and `firebase-tools` for npm |
| `mcpo` | 2,119,536 | Serves MCP servers as an OpenAPI HTTP server |
| `databricks-mcp` | 974,005 | "MCP helpers for Databricks", as it describes itself |
| `ha-mcp` | 372,566 | Its README calls local stdio "not recommended", and documents uvx for its HTTP mode |
| `cisco-ai-mcp-scanner` | 208,287 | A scanner, not a server |
| `ha-mcp-dev` | 169,352 | A development build of `ha-mcp` (9.1.1.dev3378), left out for the same reason |
| `openinference-instrumentation-mcp` | 148,720 | A library: "Python auto-instrumentation library for MCP's python SDK" |
| `fast-agent-mcp` | 119,115 | An agent framework and CLI: `uvx fast-agent-mcp@latest -x` starts an interactive session, not an MCP server |
| `fastmcp-dishka` | 109,614 | A library: "Integration package for using dishka dependency injection with FastMCP tools, resources, and prompts" |
| `prometheus-mcp-server` | 100,216 | Docker only: every client setup in its README runs `ghcr.io/pab1it0/prometheus-mcp-server:latest` with `docker run`, and uv appears only for development |
| `llama-index-tools-mcp` | 90,485 | A client library: "This tool connects to MCP Servers and allows an Agent to call the tools provided by MCP Servers" |
| `windows-mcp` | 90,220 | Controls the Windows desktop: Windows only, out of a Linux container's reach |

Below the line: `awslabs.redshift-mcp-server` (87,941), `tilt-mcp` (79,994) and
`astro-airflow-mcp` (76,335).

## What the run found in mcpcage

The npx run found two problems, fixed in 0.6.2, each with a test that fails without the fix:

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

The Python run found two things to change in the runner, not in mcpcage. run.mjs kept every image
it built until the end of the run, and the first full run of the uvx rows on the Mac, 29 then,
filled Docker's disk: five builds failed, from the 23rd server on, on uv's
`No space left on device (os error 28)`. The runner now removes each server's images once it is
checked. And `awslabs.aws-iac-mcp-server` gives a different result by machine (see [wheels
only](#wheels-only)), so a row of servers.json can now give its expected result for each Docker
engine architecture, amd64 and arm64.

Not fixed, for later:

- **With Docker's classic builder, each build leaves untagged images behind.** Colima without
  buildx uses the classic builder, which keeps every step of both stages as an image: a run of the
  24 npm servers with `--keep-images` left 216 new images on the Mac, 9 per build, of which only the
  final one is tagged and labeled `mcpcage.server`, so a cleanup by that label misses the others.
  A PyPI build, in three stages, does the same: removing what it built, the run of the first 29 uvx
  rows on the Mac removed 309 images for its 26 builds. The install stage holds the whole npm tree,
  or Python and the server's virtual environment, and nothing in mcpcage removes them, after a
  `--rebuild` either. With BuildKit (Docker Desktop, Docker on Linux with buildx) a build leaves
  only its final image, and a cache that `docker builder prune` empties.
- **With Docker's classic builder, a failed build leaves its container behind.** mcpcage's
  `docker build` does not pass `--force-rm`, so when a step fails, the classic builder keeps that
  step's stopped container and the images it holds, for npm and PyPI builds alike. The five builds
  that ran out of disk on the Mac left theirs.
