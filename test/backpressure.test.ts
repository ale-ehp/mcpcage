// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Alessandro Veneziano
import type { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit.js";
import { runProxy } from "../src/proxy.js";
import { freshHome, hostileServer } from "./helpers.js";

// The proxy runs in this process, so the server it starts can be looked at: spawn is wrapped to keep it.
const started = vi.hoisted(() => [] as ChildProcess[]);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args);
    started.push(child);
    return child;
  }) as typeof original.spawn;
  return { ...original, spawn };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a client that reads slower than the server writes", () => {
  it("makes mcpcage stop reading the server until the client catches up", async () => {
    vi.stubEnv("MCPCAGE_HOME", freshHome());
    // The client takes nothing until it is told to. Its buffer holds 1 KiB, so the first line fills it.
    let reading = false;
    const waiting: Array<() => void> = [];
    let received = 0;
    const output = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (reading) done();
        else waiting.push(done);
      },
    });
    const logged: string[] = [];
    const exit = runProxy({
      serverId: "chatty",
      command: process.execPath,
      args: [hostileServer, "notify-flood"],
      strict: false,
      allowServerRequests: false,
      audit: new AuditLog("chatty", "backpressure"),
      input: new PassThrough(),
      output,
      log: (line) => logged.push(line),
    });
    const server = started.at(-1)!;

    // The server has 8 MiB to send. mcpcage stops reading it and holds only what one read brought in.
    await vi.waitFor(() => expect(server.stdout!.isPaused()).toBe(true), { timeout: 10_000 });
    const held = output.writableLength;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(output.writableLength).toBe(held);
    expect(held).toBeLessThan(256 * 1024);

    // The client catches up: mcpcage reads the server again and every byte gets through.
    reading = true;
    waiting.shift()!();
    expect(await exit).toBe(0);
    await vi.waitFor(() => expect(received).toBe(8 * 1024 * 1024), { timeout: 10_000 });
    expect(server.stdout!.isPaused()).toBe(false);
    expect(logged).toEqual([]);
  });
});
