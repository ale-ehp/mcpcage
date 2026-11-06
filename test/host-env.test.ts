import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dockerProgram, npmProgram, prepareSandbox, runArgs, type SandboxOptions } from "../src/sandbox.js";
import { onWindows } from "./fake-programs.js";

// A client starts mcpcage with its own environment plus the entry's `env`. docker passes its
// environment to what it starts: credential helpers (gcloud's is a shell script that runs
// "$CLOUDSDK_PYTHON"), its plugins, ssh, podman behind a `docker` shim; npm to git and to node. An
// entry's CLOUDSDK_PYTHON ran on the host at `docker build` while protect called the entry caged.
// What mcpcage starts is looked at here, never run: spawnSync answers as Docker and npm would, and
// so does streamSafely, which starts docker build from a worker thread, where no mock reaches.
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const fs = await import("node:fs");
  const spawnSync = ((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    // The reg.exe asked for Windows' places runs with no environment at all (see windowsSources).
    if (!file.endsWith("reg.exe")) spawned.push({ file, args, env: options.env ?? {} });
    let stdout = "";
    if (args[0] === "version") stdout = "28.5.1\n";
    else if (args[0] === "image" && args[1] === "inspect") stdout = "sha256:0123456789ab\n";
    else if (args[0] === "create") stdout = "container\n";
    else if (args[0] === "cp") fs.writeFileSync(args[2]!, args[2]!.endsWith("package-lock.json") ? '{"packages":{}}' : '{"dependencies":{}}');
    else if (args.includes("pack")) stdout = '[{"filename":"local-server-1.0.0.tgz"}]';
    return { pid: 0, output: [], status: 0, signal: null, stdout, stderr: "" };
  }) as unknown as typeof original.spawnSync;
  return { ...original, spawnSync };
});
vi.mock("../src/terminal.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/terminal.js")>();
  const streamSafely = (file: string, args: string[], env: NodeJS.ProcessEnv) => {
    spawned.push({ file, args, env });
    return { status: 0 };
  };
  return { ...original, streamSafely };
});

/** Variables that choose code for a program that docker or npm starts, as an entry's `env` can set them, unreported. */
const CHOOSE_CODE: Record<string, string> = {
  // gcloud's credential helper runs "$CLOUDSDK_PYTHON".
  CLOUDSDK_PYTHON: "/tmp/x/evil.sh",
  // Python started with -S still imports through them.
  PYTHONPATH: "/tmp/x",
  PYTHONWARNINGS: "ignore::evil.Warning",
  // A profile there can name a credential_process, which the ecr-login helper runs.
  AWS_CONFIG_FILE: "/tmp/x/aws-config",
  // ssh, for an ssh:// DOCKER_HOST, runs the askpass program.
  SSH_ASKPASS: "/tmp/x/evil.sh",
  SSH_ASKPASS_REQUIRE: "force",
  // buildx's builders and their configuration.
  BUILDX_CONFIG: "/tmp/x/buildx",
  BUILDX_BUILDER: "evil",
  // git, which npm runs for a git dependency.
  GIT_SSH_COMMAND: "/tmp/x/evil.sh",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "/tmp/x/evil.sh",
  // podman's containers.conf, behind a `docker` that is podman's shim, names programs it runs.
  XDG_CONFIG_HOME: "/tmp/x",
  CONTAINERS_CONF: "/tmp/x/containers.conf",
  // ssh runs a ProxyCommand with it, and a D-Bus address can start a program (unixexec:).
  SHELL: "/tmp/x/evil.sh",
  DBUS_SESSION_BUS_ADDRESS: "unixexec:path=/tmp/x/evil.sh",
  // And whatever else the client has, a credential of its own among them.
  MCPCAGE_TEST_API_KEY: "not-for-docker",
};

/** Variables an entry cannot set without protect reporting it as acting on the host, so the user's own here, and the basics. */
const KEPT: Record<string, string> = {
  DOCKER_HOST: "unix:///var/run/docker.sock",
  DOCKER_CONFIG: "/home/me/.docker",
  DOCKER_CONTEXT: "colima",
  HOME: "/home/me",
  npm_config_registry: "https://registry.example/",
  NODE_EXTRA_CA_CERTS: "/home/me/ca.pem",
  HTTPS_PROXY: "http://proxy.example:3128",
  no_proxy: "localhost",
  SSH_AUTH_SOCK: "/tmp/x/agent.sock",
  LANG: "en_US.UTF-8",
  USER: "me",
};

let top: string;
beforeEach(() => {
  spawned.length = 0;
  top = mkdtempSync(join(tmpdir(), "mcpcage-host-env-"));
  // Nothing of the environment the tests run in, which npm and vitest fill (npm_config_*, NODE_ENV):
  // only what each test sets, the PATH, the temporary directory, Windows' own directory and vitest's.
  for (const name of Object.keys(process.env)) {
    if (!/^(?:PATH|TMPDIR|TMP|TEMP|SystemRoot|windir)$/i.test(name) && !/^_*VITEST/i.test(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("MCPCAGE_HOME", join(top, "cage"));
  vi.stubEnv("TMPDIR", top);
  for (const [name, value] of Object.entries({ ...CHOOSE_CODE, ...KEPT })) vi.stubEnv(name, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The names of `env` that are neither KEPT nor PATH nor TMPDIR nor MCPCAGE_HOME, nor among `also`. */
function beyondKept(env: NodeJS.ProcessEnv, also: string[] = []): string[] {
  return Object.keys(env).filter((name) => !(name in KEPT) && !["PATH", "TMPDIR", "MCPCAGE_HOME", ...also].includes(name));
}

/** What every program mcpcage runs on the host for its own work must not be given. */
function expectNone(env: NodeJS.ProcessEnv, label: string) {
  expect(Object.keys(env).filter((name) => name in CHOOSE_CODE), label).toEqual([]);
}

const options = (more: Partial<SandboxOptions>): SandboxOptions => ({
  serverId: "env", spec: { kind: "image", image: "example/server:1", args: [] }, mounts: [], env: [],
  allowNet: false, memory: "512m", cpus: "1", keepImageUser: false, rebuild: false, log: () => {}, ...more,
});

describe.skipIf(process.platform === "win32")("the environment of docker and npm on macOS and Linux", () => {
  it("holds the user's own variables and the basics, and nothing that chooses code for what they start", () => {
    for (const program of [dockerProgram()!, npmProgram()!]) {
      expectNone(program.env, program.file);
      for (const [name, value] of Object.entries(KEPT)) expect(program.env[name], `${program.file} ${name}`).toBe(value);
      expect(program.env.TMPDIR).toBe(top);
      expect(beyondKept(program.env), program.file).toEqual([]);
      // The PATH is the trusted places, as before.
      expect(program.env.PATH?.split(delimiter)).toContain("/usr/bin");
      expect(program.env.PATH).not.toBe(process.env.PATH);
    }
  });

  it("leaves out GODEBUG, which an entry may set unreported where it does not matter to docker", () => {
    vi.stubEnv("GODEBUG", "execerrdot=0");
    for (const program of [dockerProgram()!, npmProgram()!]) expect(program.env.GODEBUG, program.file).toBeUndefined();
  });

  it("keeps a DOCKER_HOST of any kind: an entry that sets one other than a local socket is reported", () => {
    for (const host of ["tcp://192.0.2.1:2376", "ssh://me@192.0.2.1"]) {
      vi.stubEnv("DOCKER_HOST", host);
      expect(dockerProgram()!.env.DOCKER_HOST).toBe(host);
    }
  });

  it("gives `docker run`, and it alone, the variables the server is given by name", () => {
    vi.stubEnv("FORWARDED_TOKEN", "for-the-server");
    // The way the entry was caged: `run --env CLOUDSDK_PYTHON` with CLOUDSDK_PYTHON in its env.
    const prepared = prepareSandbox(options({ env: ["FORWARDED_TOKEN", "CLOUDSDK_PYTHON", "INLINE=value", "PATH", "NOT_SET"] }));
    expect(prepared.env.FORWARDED_TOKEN).toBe("for-the-server");
    expect(prepared.env.CLOUDSDK_PYTHON).toBe(CHOOSE_CODE.CLOUDSDK_PYTHON);
    expect(beyondKept(prepared.env, ["FORWARDED_TOKEN", "CLOUDSDK_PYTHON"])).toEqual([]);
    expect(prepared.env.PATH).toBe(dockerProgram()!.env.PATH);
    // docker version and docker image inspect ran before it, with none of them.
    expect(spawned.map((call) => call.args[0])).toEqual(["version", "image", "image", "image"]);
    for (const call of spawned) {
      expectNone(call.env, call.args.join(" "));
      expect(call.env.FORWARDED_TOKEN, call.args.join(" ")).toBeUndefined();
    }
  });

  it("gives `docker run` a variable named __proto__ like any other, as its own", () => {
    vi.stubEnv("__proto__", "for-the-server");
    const env = prepareSandbox(options({ env: ["__proto__"] })).env;
    expect(Object.hasOwn(env, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(env, "__proto__")?.value).toBe("for-the-server");
  });

  it("gives docker build, create, cp and npm pack none of them, nor what the server is given by name", () => {
    vi.stubEnv("FORWARDED_TOKEN", "for-the-server");
    const pkg = join(top, "local-server");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), '{"name": "local-server", "version": "1.0.0"}');
    const spec = { kind: "npm" as const, packageName: "", localPath: pkg, args: [] };
    prepareSandbox(options({ serverId: "local", spec, env: ["FORWARDED_TOKEN", "CLOUDSDK_PYTHON"] }));
    const ran = spawned.map((call) => (call.args.includes("pack") ? "npm pack" : `docker ${call.args[0]}`));
    for (const step of ["docker version", "npm pack", "docker build", "docker create", "docker cp", "docker rm"]) expect(ran).toContain(step);
    for (const call of spawned) {
      expectNone(call.env, call.args.join(" "));
      expect(call.env.FORWARDED_TOKEN, call.args.join(" ")).toBeUndefined();
      expect(beyondKept(call.env), call.args.join(" ")).toEqual([]);
    }
  });
});

describe("the environment of docker and npm on Windows", () => {
  it("compares names without case, keeps one spelling of each, and gives `docker run` the server's by name", () => {
    const bin = join(top, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker.exe"), "");
    const node = join(top, "nodejs", "node.exe");
    mkdirSync(join(top, "nodejs", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(top, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"), "");
    vi.stubEnv("PATH", bin);
    // As a client could spell them; on Windows itself one spelling of each is all there is.
    vi.stubEnv("CloudSdk_Python", "C:\\x\\evil.cmd");
    vi.stubEnv("PythonPath", "C:\\x");
    vi.stubEnv("Docker_Config", "C:\\Users\\me\\.docker");
    vi.stubEnv("Npm_Config_Registry", "https://registry.example/");
    vi.stubEnv("Ssh_Auth_Sock", "\\\\.\\pipe\\openssh-ssh-agent");
    vi.stubEnv("Forwarded_Token", "for-the-server");
    vi.stubEnv("GODEBUG", "execerrdot=0");
    if (process.platform !== "win32") vi.stubEnv("https_proxy", "http://other.example:3128");
    for (const program of [onWindows(() => dockerProgram())!, onWindows(() => npmProgram(), node)!]) {
      const env = program.env;
      expect(Object.keys(env).filter((name) => /^(?:cloudsdk_python|pythonpath|forwarded_token)$/i.test(name)), program.file).toEqual([]);
      expectNone(env, program.file);
      for (const name of ["Docker_Config", "Npm_Config_Registry", "Ssh_Auth_Sock"]) {
        expect(Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase()), `${program.file} ${name}`).toHaveLength(1);
      }
      // GODEBUG is one of the user's own on Windows, where an entry that sets it is reported.
      expect(env.GODEBUG).toBe("execerrdot=0");
      expect(Object.keys(env).filter((name) => name.toUpperCase() === "HTTPS_PROXY")).toHaveLength(1);
      expect(Object.keys(env).filter((name) => name.toUpperCase() === "PATH")).toEqual(["PATH"]);
    }
    const prepared = onWindows(() => prepareSandbox(options({ env: ["FORWARDED_TOKEN", "PATH", "TEMP"] })));
    expect(Object.keys(prepared.env).filter((name) => name.toUpperCase() === "FORWARDED_TOKEN")).toHaveLength(1);
    expect(Object.entries(prepared.env).find(([name]) => name.toUpperCase() === "FORWARDED_TOKEN")?.[1]).toBe("for-the-server");
    expect(Object.keys(prepared.env).filter((name) => /^(?:cloudsdk_python|pythonpath)$/i.test(name))).toEqual([]);
    // PATH and Windows' places stay as mcpcage sets them; runArgs gives the server mcpcage's values.
    expect(prepared.env.PATH).toBe(bin);
  });
});

describe("the cage's `docker run`", () => {
  it("pulls nothing: the image is a local one, given by its ID", () => {
    const args = runArgs(options({ env: ["FORWARDED_TOKEN"] }), "sha256:0123456789ab");
    const pull = args.indexOf("--pull");
    expect(pull).toBeGreaterThan(0);
    expect(args[pull + 1]).toBe("never");
    expect(pull).toBeLessThan(args.indexOf("sha256:0123456789ab"));
  });
});
