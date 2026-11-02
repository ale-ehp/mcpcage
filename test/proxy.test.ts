import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connectFake, freshHome, mcpcage } from "./helpers.js";

const BLOCKED = -32001;

function auditEntries(home: string): Array<{ event: string } & Record<string, unknown>> {
  const dir = join(home, "audit", "notes");
  return readdirSync(dir)
    .sort()
    .flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
}

function auditEvents(home: string): string[] {
  return auditEntries(home).map((entry) => entry.event);
}

/** The block message is one stderr write that ends with this line; wait for it before reading stderr. */
async function blockLogged(session: { stderr: () => string }) {
  await vi.waitFor(() => expect(session.stderr()).toContain("`mcpcage approve notes`"));
}

async function firstSession(home: string) {
  const session = await connectFake(home, "v1");
  const { tools } = await session.client.listTools();
  await session.close();
  return tools;
}

describe("trust on first use", () => {
  it("passes the first manifest through, pins it and records every call", async () => {
    const home = freshHome();
    const session = await connectFake(home, "v1");
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["add_note", "list_notes"]);

    const result = await session.client.callTool({ name: "add_note", arguments: { text: "hello" } });
    expect(result.content).toEqual([{ type: "text", text: "saved note 1" }]);
    await session.close();

    const pin = JSON.parse(readFileSync(join(home, "servers", "notes", "pin.json"), "utf8"));
    expect(Object.keys(pin.tools).sort()).toEqual(["add_note", "list_notes"]);
    expect(auditEvents(home)).toEqual(expect.arrayContaining(["start", "sandbox", "pinned", "call", "call-result", "stop"]));
  });

  it("verifies an unchanged manifest on the next start", async () => {
    const home = freshHome();
    await firstSession(home);
    const session = await connectFake(home, "v1");
    expect((await session.client.listTools()).tools).toHaveLength(2);
    await session.close();
    expect(auditEvents(home)).toContain("list-verified");
  });
});

describe("rug-pull protection", () => {
  it("blocks a manifest whose description changed and locks the session", async () => {
    const home = freshHome();
    await firstSession(home);

    const session = await connectFake(home, "poisoned");
    await expect(session.client.listTools()).rejects.toMatchObject({ code: BLOCKED });
    // Even a client that cached the old list cannot call into the changed server.
    await expect(session.client.callTool({ name: "add_note", arguments: { text: "x" } })).rejects.toMatchObject({ code: BLOCKED });
    expect(session.stderr()).toContain('tool "add_note" changed since it was approved');
    await session.close();

    const diff = mcpcage(home, "diff", "notes");
    expect(diff.code).toBe(1);
    expect(diff.stdout).toContain("description:");
    expect(diff.stdout).toContain("read ~/.ssh/id_rsa");
    expect(auditEvents(home)).toEqual(expect.arrayContaining(["list-blocked", "call-blocked"]));
  });

  it("blocks a tool that was never approved", async () => {
    const home = freshHome();
    await firstSession(home);
    const session = await connectFake(home, "extra");
    await expect(session.client.listTools()).rejects.toMatchObject({ code: BLOCKED });
    await session.close();
    expect(mcpcage(home, "diff", "notes").stdout).toContain('+ new tool "export_notes"');
  });

  it("accepts the change after `mcpcage approve`", async () => {
    const home = freshHome();
    await firstSession(home);
    const blocked = await connectFake(home, "poisoned");
    await expect(blocked.client.listTools()).rejects.toMatchObject({ code: BLOCKED });
    await blocked.close();

    expect(mcpcage(home, "approve", "notes", "--yes").code).toBe(0);
    const session = await connectFake(home, "poisoned");
    expect((await session.client.listTools()).tools).toHaveLength(2);
    await session.close();
    expect(mcpcage(home, "diff", "notes").code).toBe(0);
  });

  it("explains why the change looks dangerous, in the log, in diff and in approve", async () => {
    const home = freshHome();
    await firstSession(home);
    const session = await connectFake(home, "poisoned");
    await expect(session.client.listTools()).rejects.toMatchObject({
      code: BLOCKED,
      message: expect.stringContaining("3 high-severity signs of hidden instructions. Run `mcpcage diff notes`"),
    });
    await blockLogged(session);
    await session.close();

    const diff = mcpcage(home, "diff", "notes");
    for (const output of [session.stderr(), diff.stdout]) {
      for (const rule of ["hidden-tag", "sensitive-path", "conceal-from-user"]) expect(output).toContain(rule);
      expect(output).toContain('3 high-severity signs of hidden instructions in "add_note"');
    }
    expect(auditEntries(home).find((entry) => entry.event === "list-blocked")).toMatchObject({ suspicious: { high: 3, medium: 2, low: 0 } });

    const approved = mcpcage(home, "approve", "notes", "--yes");
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain("WARNING: 3 high-severity signs of hidden instructions. Approve only if you have read the full definitions.");
  });

  it("still blocks a harmless rewording, without raising the alarm", async () => {
    const home = freshHome();
    await firstSession(home);
    const session = await connectFake(home, "reworded");
    const error = await session.client.listTools().catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: BLOCKED });
    expect(error.message).not.toContain("high-severity");
    await blockLogged(session);
    await session.close();

    const diff = mcpcage(home, "diff", "notes");
    expect(diff.stdout).toContain("Add a note to the notebook and return its number.");
    for (const output of [session.stderr(), diff.stdout]) {
      expect(output).toContain('tool "add_note" changed since it was approved');
      expect(output).not.toContain("HIGH");
      expect(output).not.toContain("high-severity");
    }
    expect(auditEntries(home).find((entry) => entry.event === "list-blocked")).toMatchObject({ suspicious: { high: 0, medium: 0, low: 0 } });
    expect(mcpcage(home, "approve", "notes", "--yes").stdout).not.toContain("WARNING");
  });

  it("refuses a call to a tool outside the manifest before it reaches the server", async () => {
    const home = freshHome();
    const session = await connectFake(home, "v1");
    await session.client.listTools();
    await expect(session.client.callTool({ name: "delete_everything", arguments: {} })).rejects.toMatchObject({ code: BLOCKED });
    await session.close();
    expect(auditEvents(home)).toContain("call-blocked");
  });
});

describe("--strict", () => {
  it("refuses an unknown server until its tools are approved", async () => {
    const home = freshHome();
    const blocked = await connectFake(home, "v1", ["--strict"]);
    await expect(blocked.client.listTools()).rejects.toMatchObject({ code: BLOCKED });
    await blocked.close();

    expect(mcpcage(home, "approve", "notes", "--yes").code).toBe(0);
    const session = await connectFake(home, "v1", ["--strict"]);
    expect((await session.client.listTools()).tools).toHaveLength(2);
    await session.close();
  });

  it("explains what it refuses", async () => {
    const home = freshHome();
    const blocked = await connectFake(home, "poisoned", ["--strict"]);
    await expect(blocked.client.listTools()).rejects.toMatchObject({ code: BLOCKED });
    await blockLogged(blocked);
    await blocked.close();
    expect(blocked.stderr()).toContain('+ new tool "add_note" was not in the approved manifest');
    expect(blocked.stderr()).toContain('3 high-severity signs of hidden instructions in "add_note"');
    expect(auditEntries(home).find((entry) => entry.event === "list-blocked")).toMatchObject({
      reason: "not-approved",
      suspicious: { high: 3, medium: 1, low: 0 },
    });
  });
});

describe("stdout hygiene", () => {
  it("drops non-JSON output from the server instead of passing it to the client", async () => {
    const home = freshHome();
    const session = await connectFake(home, "noisy");
    expect((await session.client.listTools()).tools).toHaveLength(2);
    await session.close();
    expect(auditEvents(home)).toContain("stdout-noise");
  });
});

describe("audit log", () => {
  it("is intact after normal use and reports the first tampered line", async () => {
    const home = freshHome();
    await firstSession(home);
    expect(mcpcage(home, "audit", "verify").stdout).toContain("1/1 audit logs intact");

    const dir = join(home, "audit", "notes");
    const file = join(dir, readdirSync(dir)[0]!);
    const lines = readFileSync(file, "utf8").split("\n");
    lines[2] = lines[2]!.replace(/"tools":\d+/, '"tools":99').replace('"pinned"', '"pinnned"');
    writeFileSync(file, lines.join("\n"));

    const verify = mcpcage(home, "audit", "verify");
    expect(verify.code).toBe(1);
    expect(verify.stdout).toMatch(/BROKEN .*line 3/);
  });
});
