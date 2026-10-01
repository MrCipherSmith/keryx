// The shell-side client's own rules: where it will send the shell token, and
// what it does when another shell takes its session over.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { RemoteClient, type ClientStatus } from "./client";
import { endpointPath } from "./endpoint";
import { makeRig, type Rig } from "./remote.http.test-helpers";
import { until } from "./remote.test-helpers";
import { mintShellToken } from "./shell-token";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function scratchDir(): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-remote-client-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "config");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("where the shell token may go", () => {
  for (const address of ["10.0.0.5", "192.168.1.20", "0.0.0.0", "example.invalid", "::ffff:8.8.8.8", "127.0.0.1.evil.test"]) {
    test(`an endpoint file naming ${address} is refused before any request is made`, async () => {
      const dir = scratchDir();
      expect(mintShellToken(dir).ok).toBe(true);
      writeOwnerOnlyFileAtomic(endpointPath(dir), `${JSON.stringify({ address, port: 4455, pid: process.pid })}\n`);
      const calls: string[] = [];
      const statuses: ClientStatus[] = [];
      const client = new RemoteClient({
        sessionId: "sess-cl-0001",
        project: "/work/app",
        dir,
        onLine: () => undefined,
        onStatus: (status) => statuses.push(status),
        fetchImpl: ((input: RequestInfo | URL) => {
          calls.push(String(input));
          return Promise.reject(new Error("the client reached for the network"));
        }) as typeof fetch,
      });
      cleanups.push(() => client.drop());

      const result = await client.start();
      expect(result).toMatchObject({ ok: false, code: "non-loopback-endpoint", retrying: false });
      expect(calls).toEqual([]);
      expect(client.connected).toBe(false);
      expect(await client.reply("hello")).toBe(false);
      expect(await client.requestApproval("run it?", 200)).toBe("deny");
      expect(calls).toEqual([]);
    });
  }

  test("loopback literals, v4 and v6, are accepted by the rule", async () => {
    const dir = scratchDir();
    expect(mintShellToken(dir).ok).toBe(true);
    for (const address of ["127.0.0.1", "127.0.0.2", "::1", "[::1]"]) {
      writeOwnerOnlyFileAtomic(endpointPath(dir), `${JSON.stringify({ address, port: 4455, pid: process.pid })}\n`);
      const urls: string[] = [];
      const client = new RemoteClient({
        sessionId: "sess-cl-0002",
        project: "/work/app",
        dir,
        onLine: () => undefined,
        fetchImpl: ((input: RequestInfo | URL) => {
          urls.push(String(input));
          return Promise.reject(new Error("refused on purpose"));
        }) as typeof fetch,
        backoff: { initialMs: 1, maxMs: 1 },
        sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
      });
      const result = await client.start();
      // The loopback rule let it through to an attempt; the attempt failed for another reason and keeps retrying.
      expect({ address, retrying: result.ok ? false : result.retrying }).toEqual({ address, retrying: true });
      expect(urls[0]?.startsWith("http://")).toBe(true);
      expect(urls[0]).toContain("/v1/remote/register");
      await client.drop();
    }
  });
});

describe("a session taken over by another shell", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("the older client is told, stops, and does not fight for the stream", async () => {
    rig = makeRig();
    await rig.startServe();
    const olderStatuses: ClientStatus[] = [];
    const newerStatuses: ClientStatus[] = [];
    const older = rig.makeClient({ sessionId: "sess-cl-0003", project: "/work/app", name: "release", onLine: () => undefined, onStatus: (s) => olderStatuses.push(s) });
    expect((await older.start()).ok).toBe(true);
    await until(() => older.connected, "the older client to connect");

    const newer = rig.makeClient({ sessionId: "sess-cl-0003", project: "/work/app", name: "release", onLine: () => undefined, onStatus: (s) => newerStatuses.push(s) });
    expect((await newer.start()).ok).toBe(true);
    await until(() => newer.connected, "the newer client to connect");

    await until(() => olderStatuses.some((status) => status.state === "stopped"), "the older client to stop");
    expect(olderStatuses.find((status) => status.state === "stopped")?.reason).toContain("replaced this one");
    expect(older.connected).toBe(false);

    // Give a reconnect loop every chance to steal the stream back: it must not.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(newer.connected).toBe(true);
    expect(newerStatuses.some((status) => status.state === "stopped")).toBe(false);
  });

  test("a stopped client does not answer approvals with allow", async () => {
    rig = makeRig();
    await rig.startServe();
    const client = rig.makeClient({ sessionId: "sess-cl-0004", project: "/work/app", onLine: () => undefined });
    expect((await client.start()).ok).toBe(true);
    await client.close();
    expect(await client.requestApproval("run it?", 200)).toBe("deny");
    expect(await client.reply("late")).toBe(false);
  });

  test("a second start on the same client is refused, not a second loop", async () => {
    rig = makeRig();
    await rig.startServe();
    const client = rig.makeClient({ sessionId: "sess-cl-0005", project: "/work/app", onLine: () => undefined });
    expect((await client.start()).ok).toBe(true);
    expect(await client.start()).toMatchObject({ ok: false, code: "already-started" });
  });
});
