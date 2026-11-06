#!/usr/bin/env node
// The compatibility run: each MCP server of servers.json started through `mcpcage run`, as a client
// would start it, with the cage's defaults, then asked to initialize, to list its tools and, where
// servers.json names one, to answer one harmless call. It is not part of the unit suite: it needs
// Docker, and the network to build each image from npm or PyPI. `npm run compat` builds mcpcage first.
//
//   node test/compat/run.mjs [--only name,name] [--runner npx|uvx] [--out dir] [--system label] [--keep-images]
//
// --runner keeps the servers started with that runner (npx when servers.json names none); with
// --only, those of the named ones.
//
// It writes <out>/compat.json and <out>/compat.md (default out: compat-out), and what each build and
// each start wrote on stderr in <out>/logs, and prints the table.
// Every server gets an image of its own under the id compat-<name>, so nothing of the user's is
// reused or removed; the images it built are removed unless --keep-images, each server's once it is
// checked, so that a run needs room for one server's images, not for all of them (on a Mac with
// 6.7 GB free for Docker, the 29 PyPI servers ran out of space at the 23rd), and whatever is left
// at the end. Its folders, mcpcage's store included (MCPCAGE_HOME), live in one temporary folder in
// the home directory, because Colima and Docker Desktop share the home directory with their VM by
// default, and are removed at the end too.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = join(root, "dist", "cli.js");
const mcpcageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const BUILD_TIMEOUT_MS = 20 * 60_000;
// A server's first start in the cage has one CPU: some take seconds just to load their code.
const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    runner: { type: "string" },
    out: { type: "string", default: "compat-out" },
    system: { type: "string" },
    "keep-images": { type: "boolean", default: false },
  },
  strict: true,
});

const RUNNERS = ["npx", "uvx"];
const all = JSON.parse(readFileSync(join(here, "servers.json"), "utf8")).servers;
// Each server's id, its images and its logs are named after it: two rows of one name would share them.
const twice = all.map((server) => server.name).filter((name, index, names) => names.indexOf(name) !== index);
if (twice.length > 0) fail(`servers.json names ${[...new Set(twice)].join(", ")} more than once`);
const badRunner = all.filter((server) => !RUNNERS.includes(runnerOf(server)));
if (badRunner.length > 0) fail(`servers.json: ${badRunner.map((server) => server.name).join(", ")} has a runner other than ${RUNNERS.join(" or ")}`);
if (values.runner !== undefined && !RUNNERS.includes(values.runner)) fail(`--runner: give ${RUNNERS.join(" or ")}`);
const wanted = values.only?.split(",").map((name) => name.trim()).filter(Boolean);
const unknown = (wanted ?? []).filter((name) => !all.some((server) => server.name === name));
if (unknown.length > 0) fail(`--only: no server named ${unknown.join(", ")} in servers.json`);
const servers = all.filter((server) => (wanted === undefined || wanted.includes(server.name)) && (values.runner === undefined || runnerOf(server) === values.runner));
if (servers.length === 0) fail(`no server of ${wanted === undefined ? "servers.json" : "--only"} is started with ${values.runner}`);

const docker = dockerInfo();
if (!docker.ok) fail(`Docker is not available: ${docker.error}`);
try {
  readFileSync(cli);
} catch {
  fail(`${cli} is missing: run \`npm run build\` first (\`npm run compat\` does)`);
}

const system = values.system ?? defaultSystem(docker);
const out = resolve(values.out);
const logs = join(out, "logs");
rmSync(logs, { recursive: true, force: true });
mkdirSync(logs, { recursive: true });
const work = mkdtempSync(join(homedir(), "compat-"));
const store = join(work, "store");
const imagesBefore = new Set(images());
const results = [];
const removed = [];
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

try {
  for (const [index, server] of servers.entries()) {
    if (interrupted) break;
    const result = await check(server);
    results.push(result);
    progress(`[${index + 1}/${servers.length}] ${server.name}: ${summary(result)}`);
    if (!values["keep-images"]) removed.push(...removeImages([server]));
  }
} finally {
  // What a server's own removal could not take, or that of a server an interrupted run left.
  if (!values["keep-images"]) removed.push(...removeImages(servers));
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  const report = {
    mcpcage: mcpcageVersion,
    date: new Date().toISOString(),
    system,
    platform: `${process.platform} ${release()} ${process.arch}`,
    node: process.version,
    docker: `${docker.version} (${docker.os})`,
    imagesRemoved: removed.length,
    results,
  };
  writeFileSync(join(out, "compat.json"), `${JSON.stringify(report, null, 2)}\n`);
  const table = markdown(report);
  writeFileSync(join(out, "compat.md"), table);
  process.stdout.write(table);
  progress(`results in ${join(out, "compat.json")} and compat.md; ${removed.length} images removed`);
  const unexpected = results.filter((result) => result.status !== result.expected);
  if (unexpected.length > 0) {
    progress(`not as expected: ${unexpected.map((result) => `${result.name} (${result.status}, expected ${result.expected})`).join(", ")}`);
    process.exitCode = 1;
  }
}

/** One server: its image built, then started in the cage; on a failure, started again with --allow-net. */
async function check(server) {
  const id = idOf(server);
  const dir = join(work, server.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hello.txt"), "hello from the mcpcage compatibility run\n");
  for (const [file, content] of Object.entries(server.files ?? {})) writeFileSync(join(dir, file), content);
  const fill = (text) => text.replaceAll("{dir}", dir).replaceAll("{base}", basename(dir));
  const line = commandLine(server, fill);
  const own = ["--id", id, ...(server.mounts ?? []).flatMap((mount) => ["--mount", fill(mount)])];
  for (const name of Object.keys(server.env ?? {})) own.push("--env", name);
  const env = { ...process.env, MCPCAGE_HOME: store, ...(server.env ?? {}) };
  const result = { name: server.name, runner: runnerOf(server), package: server.package, expected: server.expected ?? "ok", command: redact(line.join(" ")), env: Object.keys(server.env ?? {}), notes: server.notes ?? "" };

  const build = await prepare(server, [...own, "--", ...line], env);
  result.buildSeconds = seconds(build.ms);
  if (!build.ok) {
    return { ...result, status: "build fails", reason: build.reason, output: build.output };
  }
  result.version = build.version;

  const caged = await start(server, [...own, "--", ...line], env, fill);
  result.cage = caged;
  if (caged.ok) return { ...result, status: "ok" };
  const withNet = await start(server, ["--allow-net", ...own, "--", ...line], env, fill);
  result.withNet = withNet;
  return { ...result, status: withNet.ok ? "needs network" : "fails" };
}

function runnerOf(server) {
  return server.runner ?? "npx";
}

/**
 * The command line a client starts the server with, as servers.json describes it: `npx <npx flags>
 * <package> <args>`, `uvx <uvx flags> <package> <args>`, or `uvx <uvx flags> --from <package>
 * <command> <args>` for a package whose program has another name. On Windows, the row's own line
 * where its README writes another one for Windows (`cmd /c uvx ...`, `uv tool run --from ... x.exe`).
 */
function commandLine(server, fill) {
  if (process.platform === "win32" && server.windows !== undefined) return server.windows.map(fill);
  const args = (server.args ?? []).map(fill);
  if (runnerOf(server) === "npx") return ["npx", ...(server.npx ?? ["-y"]), server.package, ...args];
  const flags = server.uvx ?? [];
  return server.command === undefined ? ["uvx", ...flags, server.package, ...args] : ["uvx", ...flags, "--from", server.package, server.command, ...args];
}

/** The program a uvx row starts: its command, or the name its package is written with, as uvx takes it. */
function uvxCommand(server) {
  return server.command ?? /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(server.package)?.[0];
}

/** `mcpcage prepare`: builds and pins the image, as wrap and protect --fix do before a client starts it. */
async function prepare(server, args, env) {
  const started = Date.now();
  const { status, stdout, stderr, timedOut } = await collect(process.execPath, [cli, "prepare", ...args], env, BUILD_TIMEOUT_MS);
  const ms = Date.now() - started;
  writeFileSync(join(logs, `${server.name}-build.log`), redact(`${stderr}\n${stdout}`));
  const output = tail(redact(`${stderr}\n${stdout}`), 40);
  if (timedOut) return { ok: false, ms, reason: `the build took more than ${BUILD_TIMEOUT_MS / 60_000} minutes`, output };
  if (status !== 0) return { ok: false, ms, reason: firstError(output) ?? `mcpcage prepare exited with ${status}`, output };
  // `<id>: <package>@<version> -> <image>`
  const version = /: (?:@[^/\s]+\/)?[^@\s]+@(\S+) ->/.exec(stdout)?.[1];
  return { ok: true, ms, version, output };
}

/** `mcpcage run` with a real MCP client: initialize, tools/list and the server's harmless call. */
async function start(server, args, env, fill) {
  const attempt = { allowNet: args.includes("--allow-net"), ok: false };
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "run", ...args], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    if (stderr.length < 1_048_576) stderr += chunk.toString();
  });
  const client = new Client({ name: "mcpcage-compat", version: mcpcageVersion });
  let phase = "initialize";
  let started = Date.now();
  try {
    await client.connect(transport, { timeout: START_TIMEOUT_MS });
    attempt.startSeconds = seconds(Date.now() - started);
    const info = client.getServerVersion();
    attempt.serverInfo = info ? `${info.name} ${info.version}` : undefined;
    phase = "tools/list";
    started = Date.now();
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: REQUEST_TIMEOUT_MS });
      tools.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    attempt.listSeconds = seconds(Date.now() - started);
    attempt.tools = tools.length;
    attempt.toolNames = tools;
    if (server.call) {
      phase = `tools/call ${server.call.tool}`;
      started = Date.now();
      const answer = await client.callTool({ name: server.call.tool, arguments: server.call.arguments ?? {} }, undefined, { timeout: REQUEST_TIMEOUT_MS });
      attempt.callSeconds = seconds(Date.now() - started);
      const text = (answer.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      attempt.call = { tool: server.call.tool, isError: answer.isError === true, text: tail(redact(text), 10) };
      if (answer.isError) throw new Error(`${server.call.tool} answered with an error: ${oneLine(text)}`);
      const expect = server.call.expect === undefined ? undefined : fill(server.call.expect);
      if (expect !== undefined && !text.includes(expect)) throw new Error(`${server.call.tool} did not answer with ${JSON.stringify(redact(expect))}: ${oneLine(text)}`);
    }
    attempt.ok = true;
  } catch (error) {
    attempt.phase = phase;
    attempt.reason = redact(oneLine(error instanceof Error ? error.message : String(error)));
  } finally {
    await client.close().catch(() => {});
    const lines = tail(redact(stderr), Number.POSITIVE_INFINITY);
    writeFileSync(join(logs, `${server.name}-${attempt.allowNet ? "net" : "cage"}.log`), `${lines.join("\n")}\n`);
    if (!attempt.ok) attempt.why = why(lines, idOf(server));
    attempt.stderr = lines.length > 40 ? [...lines.slice(0, 10), `... ${lines.length - 40} lines ...`, ...lines.slice(-30)] : lines;
    attempt.leftover = await leftoverContainers(idOf(server));
  }
  return attempt;
}

/** Containers of `id` still there once the client closed: the cage runs with --rm, so none should be. */
async function leftoverContainers(id) {
  for (let i = 0; i < 20; i++) {
    const ids = dockerOut(["ps", "-a", "-q", "--filter", `label=mcpcage.server=${id}`]).split("\n").filter(Boolean);
    if (ids.length === 0) return 0;
    if (i === 19) {
      dockerOut(["rm", "-f", ...ids]);
      return ids.length;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return 0;
}

/**
 * The images this run built for `checked`, some of its servers: those labeled with one of their
 * ids and, with Docker's classic builder, the image of the install stage that each build leaves
 * untagged and unlabeled. An npm build's is told by the npm install of its package; a PyPI build's
 * by its last step, which checks that the venv has the server's program and names it
 * (`/app/venv/bin/python -I -S -c <check> <command>`, see pypiDockerfile): the steps before it are
 * the same in every PyPI build, and come from Docker's build cache when an older build made them.
 * Then, for the classic builder, the intermediate images each of them was built from, up to the
 * first one that has a name: a base pulled for the build (node, the distroless images) is kept, as
 * the resolve image uv runs in is. Only images that were not there before the run are removed,
 * children first and with --no-prune: Docker's own pruning of parents could take an older build's
 * image with them.
 */
function removeImages(checked) {
  const mine = new Set(checked.map((server) => idOf(server)));
  const installs = checked.filter((server) => runnerOf(server) === "npx").map((server) => `npm install --ignore-scripts --omit=dev ${server.package}@latest`);
  const commands = checked.filter((server) => runnerOf(server) === "uvx").map((server) => ` ${uvxCommand(server)}`);
  const created = new Set(images().filter((image) => !imagesBefore.has(image)));
  const built = [...created].filter((image) => {
    const label = dockerOut(["image", "inspect", "--format", '{{index .Config.Labels "mcpcage.server"}}', image]).trim();
    if (mine.has(label)) return true;
    if (label !== "" && label !== "<no value>") return false;
    const history = dockerOut(["history", "--no-trunc", "--format", "{{.CreatedBy}}", image]);
    if (installs.some((install) => history.includes(install))) return true;
    return history.split("\n").some((step) => step.startsWith("/app/venv/bin/python -I -S -c ") && commands.some((command) => step.trimEnd().endsWith(command)));
  });
  // Each image's parents, as far as they are new too and have no name.
  const remove = new Set(built);
  for (const image of built) {
    let parent = dockerOut(["image", "inspect", "--format", "{{.Parent}}", image]).trim();
    while (parent && created.has(parent) && !remove.has(parent) && !named(parent)) {
      remove.add(parent);
      parent = dockerOut(["image", "inspect", "--format", "{{.Parent}}", parent]).trim();
    }
  }
  // Children first: a child is newer than its parent. A second pass takes a parent made in the
  // same instant as its child.
  const made = new Map([...remove].map((image) => [image, Date.parse(dockerOut(["image", "inspect", "--format", "{{.Created}}", image]).trim()) || 0]));
  let left = [...remove].sort((a, b) => made.get(b) - made.get(a));
  const removed = [];
  for (let pass = 0; pass < 2 && left.length > 0; pass++) {
    left = left.filter((image) => {
      if (spawnSync("docker", ["rmi", "--no-prune", image], { encoding: "utf8" }).status !== 0) return true;
      removed.push(image);
      return false;
    });
  }
  return removed;
}

function images() {
  return dockerOut(["images", "-a", "-q", "--no-trunc"]).split("\n").filter(Boolean);
}

/** Whether an image has a tag or a digest name: a base that was pulled, not a step of a build. */
function named(image) {
  return dockerOut(["image", "inspect", "--format", "{{len .RepoTags}} {{len .RepoDigests}}", image]).trim() !== "0 0";
}

function dockerOut(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function dockerInfo() {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}|{{.Server.Os}}"], { encoding: "utf8" });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: result.stderr.trim() };
  const [version, os] = result.stdout.trim().split("|");
  const name = spawnSync("docker", ["info", "--format", "{{.OperatingSystem}}"], { encoding: "utf8" }).stdout?.trim() ?? "";
  return { ok: true, version, os: name || os };
}

function defaultSystem(info) {
  const os = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] ?? process.platform;
  return `${os}, Docker ${info.version} (${info.os})`;
}

/** Runs a program to its end, or kills it after `limit` ms. */
function collect(command, args, env, limit) {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-65_536)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-65_536)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limit);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr, timedOut });
    });
  });
}

/**
 * The line of a failed start that says why: the server's first line that reads like an error, or its
 * last one. The server's lines come after its id in brackets (see the proxy), mcpcage's do not.
 */
function why(lines, id) {
  const prefix = `[${id}] `;
  const own = lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length).replace(/\[U\+001B\]\[[0-9;]*m/g, "").trim()).filter(Boolean);
  return own.find((line) => /error|required|please|cannot|can't|missing|not set|not found|denied|EROFS|EACCES|ENOENT|EAI_AGAIN|ECONNREFUSED|unhandled/i.test(line)) ?? own.at(-1) ?? lines.at(-1);
}

/**
 * The line of a failed build that says why: npm's error, or mcpcage's own, which for a PyPI server
 * uv finds no solution for quotes uv's reason. When mcpcage says only that docker build failed, the
 * build's line that says why: uv's `error:` in the install stage, or the check that found no such
 * program in the package.
 */
function firstError(lines) {
  const npm = lines.find((line) => /npm (error|ERR!)/.test(line) && !/A complete log|^\s*npm error\s*$/.test(line));
  if (npm !== undefined) return npm;
  const own = lines.findLast((line) => /^mcpcage:/.test(line));
  if (own === undefined || !/^mcpcage: docker build failed/.test(own)) return own;
  // The classic builder colors what a step writes on stderr.
  const plain = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
  return plain.find((line) => /(?:^|\s)error: |no \S+ in the package; it has: /.test(line)) ?? own;
}

function markdown(report) {
  const rows = report.results.map((result) => {
    const attempt = result.cage?.ok ? result.cage : result.withNet?.ok ? result.withNet : result.cage;
    const tools = attempt?.tools ?? "";
    const start = attempt?.startSeconds === undefined ? "" : `${attempt.startSeconds} s`;
    return `| ${result.name} | \`${result.package}\` | ${result.version ?? ""} | ${result.status} | ${tools} | ${result.buildSeconds} s | ${start} | ${cell(note(result))} |`;
  });
  return [
    `### mcpcage ${report.mcpcage} on ${report.system}`,
    "",
    `${report.date.slice(0, 10)}, Node ${report.node}, ${report.platform}.`,
    "",
    "| Server | Package | Version | Result | Tools | Build | Start | Notes |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** What the table says about a result: servers.json's notes, the variables it was given, why it failed. */
function note(result) {
  const parts = result.notes ? [result.notes.replace(/\.$/, "")] : [];
  if (result.env.length > 0) parts.push(`--env ${result.env.join(", ")}`);
  const failed = (attempt) => `${attempt.phase}: ${attempt.reason}${attempt.why === undefined || attempt.reason.includes(attempt.why) ? "" : ` (${attempt.why})`}`;
  if (result.status === "build fails") parts.push(result.reason);
  else if (result.cage && !result.cage.ok) parts.push(`in the cage: ${failed(result.cage)}`);
  if (result.withNet && !result.withNet.ok) parts.push(`with --allow-net: ${failed(result.withNet)}`);
  const leftover = (result.cage?.leftover ?? 0) + (result.withNet?.leftover ?? 0);
  if (leftover > 0) parts.push(`${leftover} container(s) left running after the client closed`);
  return parts.join("; ");
}

/**
 * A server's text as one cell of a Markdown table: `|` escaped so that it does not end the cell, and
 * `\` escaped before it, or the `\` of a text such as `a\|b` became part of the escape and was lost.
 */
function cell(text) {
  const line = text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return line.length > 600 ? `${line.slice(0, 597)}...` : line;
}

function summary(result) {
  const attempt = result.cage?.ok ? result.cage : result.withNet?.ok ? result.withNet : undefined;
  const tools = attempt ? `, ${attempt.tools} tools` : "";
  return `${result.status}${tools} (build ${result.buildSeconds} s)${result.status === "ok" ? "" : `: ${note(result)}`}`;
}

/** The user's home directory, as the host and as the cage on Windows spell it, written ~. */
function redact(text) {
  const home = homedir();
  let out = text.split(home).join("~");
  if (process.platform === "win32") {
    const inCage = `/${home[0].toLowerCase()}${home.slice(2).replace(/\\/g, "/")}`;
    out = out.split(inCage).join("~").split(home.replace(/\\/g, "/")).join("~");
  }
  return out;
}

function idOf(server) {
  return `compat-${server.name}`;
}

function tail(text, count) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").slice(-count);
}

function oneLine(text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 400 ? `${line.slice(0, 397)}...` : line;
}

function seconds(ms) {
  return Math.round(ms / 100) / 10;
}

function progress(message) {
  process.stderr.write(`compat: ${message}\n`);
}

function fail(message) {
  progress(message);
  process.exit(2);
}
