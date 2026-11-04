#!/usr/bin/env node
// Tries to break out of its cage, one tool per attack. Each tool reports what happened instead of
// throwing, so a test can tell which defense stopped it. Under mcpcage every attack must fail.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const MiB = 1024 * 1024;
const FORK_LIMIT = 400;

const answer = (report) => ({ content: [{ type: "text", text: JSON.stringify(report) }] });

/** A file of this container's cgroup (v2) as the server sees it, or the error code. */
function cgroup(name) {
  try {
    return readFileSync(join("/sys/fs/cgroup", name), "utf8").trim();
  } catch (error) {
    return error.code;
  }
}

// Whether a new file can be created in `dir`, as in the probe server: the name is random and an
// existing file is never written through; the file is removed after.
function canWrite(dir) {
  const file = join(dir, `abuse-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(file, "abuse", { flag: "wx" });
  } catch (error) {
    return error.code;
  }
  rmSync(file, { force: true });
  return true;
}

/** What canAppend adds at the end of a file, so a test can find it there. */
const APPENDED = "# appended by mcpcage-abuse\n";

// Whether a line can be added at the end of an existing file, as a server would add a command to a
// repository's configuration; a missing file is not created.
function canAppend(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND);
    writeSync(fd, APPENDED);
    return true;
  } catch (error) {
    return error.code;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Whether `path` could be renamed to `<path>.moved`, or the error code. */
function moveAside(path) {
  try {
    renameSync(path, `${path}.moved`);
    return true;
  } catch (error) {
    return error.code;
  }
}

/** What createFile writes, so a test can find it. */
const CREATED = "# written by mcpcage-abuse\n";

// Whether `file` could be written, created with the directories it needs or replaced, as a server
// would put a repository configuration of its own where the user's was.
function createFile(file) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, CREATED);
    return true;
  } catch (error) {
    return error.code;
  }
}

/** The exit code of `file --version`, or the error code when it cannot be started. */
function run(file) {
  const result = spawnSync(file, ["--version"], { stdio: "ignore", timeout: 10_000 });
  return result.error ? result.error.code : result.status;
}

/**
 * Copies a native program into /tmp, makes it executable and runs it, as a server would with a binary
 * it brought along. The program is Docker's init, which every cage has because mcpcage starts its
 * containers with --init. Started from where Docker put it, it runs: a refusal in /tmp comes from the mount.
 */
function execFromTmp() {
  const program = "/sbin/docker-init";
  const copy = join("/tmp", `abuse-${randomBytes(8).toString("hex")}`);
  const report = { program, inPlace: run(program), copiedToTmp: false, madeExecutable: false, fromTmp: null };
  try {
    copyFileSync(program, copy);
    report.copiedToTmp = true;
    chmodSync(copy, 0o755);
    report.madeExecutable = true;
    report.fromTmp = run(copy);
  } catch (error) {
    report.error = error.code;
  } finally {
    rmSync(copy, { force: true });
  }
  return report;
}

/** The capability sets, the no_new_privs flag and the seccomp mode from /proc/self/status. */
function privileges() {
  const wanted = /^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp)$/;
  return Object.fromEntries(
    readFileSync("/proc/self/status", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .filter(([key]) => wanted.test(key))
      .map(([key, value]) => [key, value.trim()]),
  );
}

/** The names of the variables of process `pid`, or the error code when they cannot be read. */
function environOf(pid) {
  try {
    const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
    return entries.map((entry) => entry.split("=")[0]).sort();
  } catch (error) {
    return error.code;
  }
}

/** "reachable (what came back)", or "blocked (the error code)", as the probe server reports its network. */
async function attempt(action) {
  try {
    return `reachable (${await action()})`;
  } catch (error) {
    return `blocked (${error.cause?.code ?? error.code ?? error.name})`;
  }
}

function tcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 4000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(`connected to ${host}:${port}`);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    });
    socket.once("error", reject);
  });
}

const server = new McpServer({ name: "mcpcage-abuse", version: "1.0.0" });

server.registerTool(
  "write_outside",
  {
    description:
      "Try to create a file in /, /usr, /etc, this server's code, the home directory, /tmp and the given paths, add a line to the given existing files, then run a program from /tmp.",
    inputSchema: { paths: z.array(z.string()).optional(), files: z.array(z.string()).optional() },
  },
  async ({ paths = [], files = [] }) => {
    // The home directory of the user in /etc/passwd: in the cage HOME points at /tmp instead.
    const home = userInfo().homedir;
    const dirs = ["/", "/usr", "/etc", here, home, "/tmp", ...paths];
    return answer({
      ownCode: here,
      home,
      writes: Object.fromEntries(dirs.map((dir) => [dir, canWrite(dir)])),
      appends: Object.fromEntries(files.map((file) => [file, canAppend(file)])),
      exec: execFromTmp(),
    });
  },
);

server.registerTool(
  "move_aside",
  {
    description: "Rename each given path to <path>.moved, in order, then write each given file, creating the directories it needs.",
    inputSchema: { paths: z.array(z.string()).optional(), files: z.array(z.string()).optional() },
  },
  async ({ paths = [], files = [] }) =>
    answer({
      renames: Object.fromEntries(paths.map((path) => [path, moveAside(path)])),
      creates: Object.fromEntries(files.map((file) => [file, createFile(file)])),
    }),
);

server.registerTool("fork_bomb", { description: `Start child processes as fast as possible, up to ${FORK_LIMIT}, then kill them.` }, async () => {
  const started = Date.now();
  const before = cgroup("pids.current");
  const children = [];
  const running = () => children.filter((child) => child.exitCode === null && child.signalCode === null);
  let failure = null;
  let runningAtFailure = null;
  let atFailure = null;
  for (let n = 0; n < FORK_LIMIT; n++) {
    let child;
    try {
      // A whole Node.js each time: the image has no other program to start, apart from the init.
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    } catch (error) {
      failure = { code: error.code, syscall: error.syscall };
    }
    // Node reports EAGAIN as an "error" event on the next tick, and the child has no pid. Without a
    // listener, that event would end this server.
    child?.on("error", (error) => {
      failure ??= { code: error.code, syscall: error.syscall };
    });
    if (child?.pid === undefined) {
      runningAtFailure = running().length;
      atFailure = cgroup("pids.current");
      break;
    }
    children.push(child);
  }
  // A child that started but could not create its own threads ends by itself: give them a second.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const endedOnTheirOwn = {};
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) continue;
    const how = child.signalCode ?? `code ${child.exitCode}`;
    endedOnTheirOwn[how] = (endedOnTheirOwn[how] ?? 0) + 1;
  }
  const survivors = running();
  await Promise.all(
    survivors.map(
      (child) =>
        new Promise((resolve) => {
          child.once("exit", resolve);
          child.kill("SIGKILL");
        }),
    ),
  );
  return answer({
    limit: FORK_LIMIT,
    spawned: children.length,
    runningAtFailure,
    failure,
    endedOnTheirOwn,
    killed: survivors.length,
    pids: { max: cgroup("pids.max"), before, atFailure, after: cgroup("pids.current"), events: cgroup("pids.events") },
    ms: Date.now() - started,
  });
});

server.registerTool("eat_memory", { description: "Allocate memory in 64 MiB steps up to 1 GiB, and hold it." }, async () => {
  const held = [];
  for (let step = 1; step <= 16; step++) {
    // A Buffer lives outside V8's heap, whose own limit (about half of the container's memory) would
    // stop the server first. Filling it makes every page resident, so all of it counts in the cgroup.
    held.push(Buffer.alloc(64 * MiB, step));
    const current = Math.round(Number(cgroup("memory.current")) / MiB);
    process.stderr.write(`abuse-server: eat_memory holds ${step * 64} MiB (cgroup memory.current ${current} MiB)\n`);
  }
  return answer({ heldMiB: held.length * 64, memoryMax: cgroup("memory.max") });
});

server.registerTool("environment", { description: "Report the environment, user, privileges and limits this server runs with." }, async () =>
  answer({
    env: Object.keys(process.env).sort(),
    uid: process.getuid(),
    gid: process.getgid(),
    groups: process.getgroups(),
    dockerSocket: Object.fromEntries(["/var/run/docker.sock", "/run/docker.sock"].map((path) => [path, existsSync(path)])),
    privileges: privileges(),
    pid1: { command: readFileSync("/proc/1/comm", "utf8").trim(), environ: environOf(1) },
    cgroup: Object.fromEntries(["pids.max", "memory.max", "memory.swap.max"].map((name) => [name, cgroup(name)])),
  }),
);

server.registerTool("network", { description: "Try to reach the internet: resolve a name two ways, connect to an address, fetch a page." }, async () =>
  answer({
    interfaces: Object.keys(networkInterfaces()).sort(),
    // getaddrinfo, the way most programs resolve a name, and c-ares, which asks the nameservers itself.
    lookup: await attempt(async () => (await dns.lookup("example.com")).address),
    resolve: await attempt(async () => (await dns.resolve4("example.com")).join(", ")),
    // An address needs no name resolved first.
    tcp: await attempt(() => tcp("1.1.1.1", 443)),
    https: await attempt(async () => `HTTP ${(await fetch("https://example.com", { signal: AbortSignal.timeout(4000) })).status}`),
  }),
);

await server.connect(new StdioServerTransport());
