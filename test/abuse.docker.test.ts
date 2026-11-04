// Runs only with `npm run test:docker`: starts test/fixtures/abuse-server in its cage, where it tries to
// write where it should not, run a program it brought, fork without end, eat all the memory, look for
// a way out in its environment and reach the network. Every attack must fail the way the cage
// promises, and mcpcage must come through each one.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { dockerAvailable } from "../src/sandbox.js";
import { cli, connect, freshHome, mcpcage, root } from "./helpers.js";

const abusePackage = join(root, "test", "fixtures", "abuse-server");
const docker = dockerAvailable();
const home = freshHome();
const server = ["npx", "-y", abusePackage];
const MiB = 1024 * 1024;
/** A capability set with nothing in it, as /proc/self/status shows it. */
const NO_CAPABILITIES = "0000000000000000";

interface WriteReport {
  ownCode: string;
  /** The home directory of the server's user in /etc/passwd (HOME itself points at /tmp in the cage). */
  home: string;
  /** For each directory: true when a new file could be created there, or the error code. */
  writes: Record<string, true | string>;
  /** For each existing file: true when a line could be added at its end, or the error code. */
  appends: Record<string, true | string>;
  exec: { program: string; inPlace: number | string; copiedToTmp: boolean; madeExecutable: boolean; fromTmp: number | string | null };
}

interface ForkReport {
  limit: number;
  spawned: number;
  runningAtFailure: number | null;
  failure: { code: string; syscall: string } | null;
  endedOnTheirOwn: Record<string, number>;
  killed: number;
  /** The container's pids cgroup: its limit, the count before the bomb, when spawning failed and after, and its events. */
  pids: { max: string; before: string; atFailure: string | null; after: string; events: string };
  ms: number;
}

interface EnvironmentReport {
  env: string[];
  uid: number;
  gid: number;
  groups: number[];
  dockerSocket: Record<string, boolean>;
  privileges: Record<string, string>;
  pid1: { command: string; environ: string[] | string };
  cgroup: Record<string, string>;
}

interface NetworkReport {
  interfaces: string[];
  lookup: string;
  resolve: string;
  tcp: string;
  https: string;
}

type AuditEntry = { event: string } & Record<string, unknown>;

/** Starts the abuse server in its cage, lists its tools like every MCP client does first, and calls one. */
async function call<Report>(tool: string, options: { args?: Record<string, unknown>; runArgs?: string[]; env?: Record<string, string> } = {}) {
  const session = await connect({ home, runArgs: ["--id", "abuse", ...(options.runArgs ?? [])], server, env: options.env });
  await session.client.listTools();
  const result = await session.client.callTool({ name: tool, arguments: options.args ?? {} });
  await session.close();
  return parse<Report>(result);
}

function parse<Report>(result: unknown): Report {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Report;
}

/**
 * Like connect() in helpers.ts, and it also tells how mcpcage exited, which the SDK's stdio transport
 * keeps to itself: when the server is killed, mcpcage must exit with the server's code.
 */
async function connectWithExit() {
  const proxy = spawn(process.execPath, [cli, "run", "--id", "abuse", "--", ...server], {
    env: { ...process.env, MCPCAGE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proxy.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // mcpcage may be gone while the client still writes; that write fails, and that is all.
  proxy.stdin.on("error", () => {});
  const exited = new Promise<number | null>((resolve) => proxy.once("exit", (code) => resolve(code)));
  const messages = new ReadBuffer();
  const transport: Transport = {
    start: async () => {
      proxy.stdout.on("data", (chunk: Buffer) => {
        messages.append(chunk);
        for (let message = messages.readMessage(); message !== null; message = messages.readMessage()) transport.onmessage?.(message);
      });
      proxy.once("close", () => transport.onclose?.());
    },
    send: async (message) => {
      proxy.stdin.write(serializeMessage(message));
    },
    close: async () => {
      proxy.stdin.end();
      await exited;
    },
  };
  const client = new Client({ name: "mcpcage-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, exited };
}

/** The entries of the abuse server's latest audit session, in order. */
function latestSession(): AuditEntry[] {
  const dir = join(home, "audit", "abuse");
  const file = readdirSync(dir).sort().at(-1)!;
  return readFileSync(join(dir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/** Now, by the Docker daemon's clock: on macOS the daemon runs in a VM whose clock can drift from the host's. */
function daemonClock(): string {
  return spawnSync("docker", ["system", "info", "--format", "{{.SystemTime}}"], { encoding: "utf8" }).stdout.trim();
}

/** What Docker recorded about the abuse server's containers between two moments of its clock: "start", "oom", "die 137"... */
function dockerEvents(since: string, until: string): string[] {
  const format = '{{.Action}}{{with index .Actor.Attributes "exitCode"}} {{.}}{{end}}';
  const events = spawnSync("docker", ["events", "--since", since, "--until", until, "--filter", "label=mcpcage.server=abuse", "--format", format], { encoding: "utf8" });
  return events.stdout.split("\n").filter(Boolean);
}

describe.skipIf(!docker.ok)("an abusive server in its cage (real Docker)", () => {
  beforeAll(() => {
    const prepared = mcpcage(home, "prepare", "--id", "abuse", "--", ...server);
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(prepared.stdout).toContain("mcpcage-abuse@1.0.0");
  }, 600_000);

  it("finds nothing to use in its environment: its own variables only, user 65532, no capabilities, no Docker socket", async () => {
    const report = await call<EnvironmentReport>("environment", {
      runArgs: ["--env", "ABUSE_ALLOWED"],
      env: { ABUSE_ALLOWED: "yes", SECRET_TOKEN: "must-not-leak" },
    });
    // HOME comes from mcpcage, HOSTNAME from Docker, PATH and SSL_CERT_FILE from the distroless base
    // image and ABUSE_ALLOWED from --env. Node.js adds none, and nothing else of mcpcage's environment gets in.
    expect(report.env).toEqual(["ABUSE_ALLOWED", "HOME", "HOSTNAME", "PATH", "SSL_CERT_FILE"]);
    expect(report.uid).toBe(65532);
    expect(report.gid).toBe(65532);
    expect(report.groups).toEqual([65532]);
    expect(report.dockerSocket).toEqual({ "/var/run/docker.sock": false, "/run/docker.sock": false });
    expect(report.privileges).toEqual({
      CapInh: NO_CAPABILITIES,
      CapPrm: NO_CAPABILITIES,
      CapEff: NO_CAPABILITIES,
      CapBnd: NO_CAPABILITIES,
      CapAmb: NO_CAPABILITIES,
      NoNewPrivs: "1",
      // A seccomp filter is in place: Docker's default profile.
      Seccomp: "2",
    });
    // PID 1 runs as the same user, so its environment can be read: it is the container's own init and
    // holds exactly the server's variables, nothing of the host.
    expect(report.pid1).toEqual({ command: "docker-init", environ: report.env });
    expect(report.cgroup).toMatchObject({ "pids.max": "128", "memory.max": String(512 * MiB) });
  }, 120_000);

  it("cannot write outside /tmp and a read-write mount, nor run a program from /tmp", async () => {
    // In the repository, which Docker on macOS can share. Both directories are open to every user, so
    // only the mount can refuse the server, which does not own them.
    const readOnly = mkdtempSync(join(root, "test", "fixtures", "abuse-ro-"));
    const writable = mkdtempSync(join(root, "test", "fixtures", "abuse-rw-"));
    chmodSync(readOnly, 0o777);
    chmodSync(writable, 0o777);
    try {
      const report = await call<WriteReport>("write_outside", {
        args: { paths: [readOnly, writable] },
        runArgs: ["--mount", readOnly, "--mount", `${writable}:rw`],
      });
      expect(report.ownCode).toBe("/app/node_modules/mcpcage-abuse");
      expect(report.home).toBe("/home/nonroot");
      // EROFS and not EACCES: the read-only filesystem refuses before file permissions are looked at.
      // The home directory belongs to the server's own user, so nothing else would stop it there.
      expect(report.writes).toEqual({
        "/": "EROFS",
        "/usr": "EROFS",
        "/etc": "EROFS",
        "/app/node_modules/mcpcage-abuse": "EROFS",
        "/home/nonroot": "EROFS",
        "/tmp": true,
        [readOnly]: "EROFS",
        [writable]: true,
      });
      // The program runs from where Docker put it. Copied to /tmp and made executable, it is refused by
      // the kernel: /tmp is mounted noexec.
      expect(report.exec).toEqual({ program: "/sbin/docker-init", inPlace: 0, copiedToTmp: true, madeExecutable: true, fromTmp: "EACCES" });
    } finally {
      rmSync(readOnly, { recursive: true, force: true });
      rmSync(writable, { recursive: true, force: true });
    }
  }, 120_000);

  it("cannot change git's or the editors' settings in a read-write mount, only the other files there", async () => {
    // A project as an editor opens it. Everything is open to every user, so only the mounts can refuse
    // the server: git would run a command written into .git/config or .git/hooks on the host.
    const project = mkdtempSync(join(root, "test", "fixtures", "abuse-project-"));
    const config = join(project, ".git", "config");
    const hooks = join(project, ".git", "hooks");
    const settings = join(project, ".vscode", "settings.json");
    const notes = join(project, "notes.md");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(join(project, ".vscode"));
    writeFileSync(config, "[core]\n\trepositoryformatversion = 0\n");
    writeFileSync(settings, "{}\n");
    writeFileSync(notes, "# Notes\n");
    for (const dir of [project, join(project, ".git"), hooks, join(project, ".vscode")]) chmodSync(dir, 0o777);
    for (const file of [config, settings, notes]) chmodSync(file, 0o666);
    try {
      const report = await call<WriteReport>("write_outside", {
        args: { paths: [hooks, project], files: [config, settings, notes] },
        runArgs: ["--mount", `${project}:rw`],
      });
      expect(report.writes).toMatchObject({ [hooks]: "EROFS", [project]: true });
      expect(report.appends).toEqual({ [config]: "EROFS", [settings]: "EROFS", [notes]: true });
      // The ordinary file changed on the host; the settings are as they were.
      expect(readFileSync(notes, "utf8")).toBe("# Notes\n# appended by mcpcage-abuse\n");
      expect(readFileSync(config, "utf8")).toBe("[core]\n\trepositoryformatversion = 0\n");
      expect(readFileSync(settings, "utf8")).toBe("{}\n");
      expect(readdirSync(hooks)).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 120_000);

  it("cannot resolve a name or reach an address without --allow-net", async () => {
    const report = await call<NetworkReport>("network");
    expect(report.interfaces).toEqual(["lo"]);
    for (const attempt of ["lookup", "resolve", "tcp", "https"] as const) expect(report[attempt], attempt).toMatch(/^blocked/);
  }, 120_000);

  it("reaches the network with --allow-net, so the attempts above can tell", async () => {
    const report = await call<NetworkReport>("network", { runArgs: ["--allow-net"] });
    for (const attempt of ["lookup", "resolve", "tcp", "https"] as const) expect(report[attempt], attempt).toMatch(/^reachable/);
  }, 120_000);

  it("is stopped at the process limit by a fork bomb of its own, then answers, and mcpcage goes on serving", async () => {
    const session = await connect({ home, runArgs: ["--id", "abuse"], server });
    await session.client.listTools();
    const report = parse<ForkReport>(await session.client.callTool({ name: "fork_bomb", arguments: {} }));
    expect(report.failure).toMatchObject({ code: "EAGAIN" });
    // The limit counts threads too, and each child is a Node.js with several of them: spawning fails
    // long before 128 children are running.
    expect(report.runningAtFailure).toBeGreaterThan(0);
    expect(report.runningAtFailure).toBeLessThan(128);
    expect(report.pids.max).toBe("128");
    // The kernel counts what the cgroup refused: the EAGAIN came from the pids limit, not from another
    // limit such as a ulimit on processes.
    expect(Number(/^max (\d+)$/.exec(report.pids.events)?.[1])).toBeGreaterThan(0);
    // Every process the bomb started is gone.
    expect(report.pids.after).toBe(report.pids.before);

    await session.client.ping();
    const after = parse<EnvironmentReport>(await session.client.callTool({ name: "environment", arguments: {} }));
    expect(after.uid).toBe(65532);
    await session.close();
    const entries = latestSession();
    expect(entries).toContainEqual(expect.objectContaining({ event: "call-result", tool: "fork_bomb", ok: true }));
    // With no child left to wait for, the server ends as soon as its input closes.
    expect(entries.at(-1)).toMatchObject({ event: "stop", code: 0 });
  }, 120_000);

  it("is killed by the memory limit before it holds 512 MiB, and mcpcage exits with its code", async () => {
    const since = daemonClock();
    const started = Date.now();
    const session = await connectWithExit();
    try {
      await session.client.listTools();
      await expect(session.client.callTool({ name: "eat_memory", arguments: {} })).rejects.toMatchObject({ code: ErrorCode.ConnectionClosed });
    } finally {
      // A server that was not killed must not stay up with its memory when the test fails.
      await session.client.close();
    }
    // docker run reports 128 + SIGKILL when the kernel kills the server, and mcpcage passes it on.
    expect(await session.exited).toBe(137);
    // The machine was never short of memory itself: everything is over in seconds.
    expect(Date.now() - started).toBeLessThan(60_000);

    // The server says how much it holds after each step of 64 MiB: it got well into its memory, and
    // never to 512 MiB. Without --memory-swap, Docker also lets a container swap as much as its memory
    // limit (memory.swap.max is 512 MiB too): where Docker's host has no swap, as in Colima's VM, the
    // 512 MiB are the whole limit, and where it has some, the server gets further and this test fails.
    const held = [...session.stderr().matchAll(/eat_memory holds (\d+) MiB/g)].map((match) => Number(match[1]));
    expect(Math.max(...held)).toBeGreaterThanOrEqual(256);
    expect(Math.max(...held)).toBeLessThan(512);
    expect(session.stderr()).toContain("mcpcage: the server exited (code 137) with 1 request unanswered");
    expect(session.stderr()).not.toMatch(/^\s+at /m);

    const entries = latestSession();
    expect(entries).toContainEqual(expect.objectContaining({ event: "call", tool: "eat_memory" }));
    expect(entries.map((entry) => entry.event)).not.toContain("call-result");
    expect(entries.at(-1)).toMatchObject({ event: "stop", code: 137, signal: null });
    // Docker's own record: the kernel killed the container for its memory. The "oom" event can reach
    // the daemon a moment after the container's exit.
    await vi.waitFor(() => expect(dockerEvents(since, daemonClock())).toEqual(expect.arrayContaining(["oom", "die 137"])), { timeout: 10_000 });

    // The next start of the server answers as before.
    expect((await call<EnvironmentReport>("environment")).uid).toBe(65532);
  }, 120_000);

  it("keeps an intact audit log of every attack", () => {
    expect(mcpcage(home, "audit", "verify", "abuse").code).toBe(0);
    const shown = mcpcage(home, "audit", "show", "abuse", "--lines", "500").stdout;
    for (const tool of ["environment", "write_outside", "network", "fork_bomb", "eat_memory"]) expect(shown).toContain(`"tool":"${tool}"`);
  });
});
