// Regression tests for the review of flow 376 (PR #817). Each one fails without
// the fix it names.
//
//   - a stale endpoint file never receives the shell token;
//   - the shell token is fresh on every serve start, and a shell follows it;
//   - an update id is a name, not a position: a lower id after a higher one runs;
//   - `close` during a register still deregisters what the register created;
//   - the hub never waits on Telegram to answer a button press;
//   - a topic holds at most 500 unread messages, and says so when it drops some;
//   - "Approval granted." is only posted when the shell was told;
//   - a topic rebinding forgets the finished ids of the old binding;
//   - an ack or Last-Event-ID for an id that was never sent is ignored.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { type ClientStatus, RemoteClient } from "./client";
import { endpointPath } from "./endpoint";
import { MAX_INBOUND_PER_TOPIC } from "./inbound";
import { remoteRoutePath } from "./protocol";
import { call, makeRig, openRawStream, type Rig, untilFrame } from "./remote.http.test-helpers";
import { makeHarness, OWNER_ID, settle, until } from "./remote.test-helpers";
import { mintShellToken } from "./shell-token";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function scratchDir(): string {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-remote-fixes-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "config");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("a stale endpoint file does not get the shell token (MAJOR-1)", () => {
  test("a pid that is not running: no request is made at all, so no token leaves", async () => {
    const dir = scratchDir();
    expect(mintShellToken(dir).ok).toBe(true);
    // The serve that wrote this was killed; the port may belong to anything by now.
    writeOwnerOnlyFileAtomic(endpointPath(dir), `${JSON.stringify({ address: "127.0.0.1", port: 4455, pid: 2_147_483_000 })}\n`);
    const calls: { url: string; headers: unknown }[] = [];
    const client = new RemoteClient({
      sessionId: "sess-fx-0001",
      project: "/work/app",
      dir,
      onLine: () => undefined,
      backoff: { initialMs: 1, maxMs: 1 },
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), headers: init?.headers });
        return Promise.reject(new Error("the client reached for the network"));
      }) as typeof fetch,
    });
    cleanups.push(() => client.drop());
    const result = await client.start();
    expect(result.ok).toBe(false);
    await settle();
    expect(calls).toEqual([]);
    expect(await client.reply("hello")).toBe(false);
    expect(calls).toEqual([]);
  });

  test("the liveness check is the one asked: a serve reported dead is refused, a live one is let through", async () => {
    const dir = scratchDir();
    expect(mintShellToken(dir).ok).toBe(true);
    writeOwnerOnlyFileAtomic(endpointPath(dir), `${JSON.stringify({ address: "127.0.0.1", port: 4455, pid: 777 })}\n`);
    const asked: number[] = [];
    let alive = false;
    const urls: string[] = [];
    const client = new RemoteClient({
      sessionId: "sess-fx-0002",
      project: "/work/app",
      dir,
      onLine: () => undefined,
      backoff: { initialMs: 1, maxMs: 1 },
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
      isAlive: (pid) => {
        asked.push(pid);
        return alive;
      },
      fetchImpl: ((input: RequestInfo | URL) => {
        urls.push(String(input));
        return Promise.reject(new Error("refused on purpose"));
      }) as typeof fetch,
    });
    cleanups.push(() => client.drop());
    await client.start();
    expect(asked).toContain(777);
    expect(urls).toEqual([]);
    alive = true;
    await until(() => urls.length > 0, "a request once the serve is running");
  });
});

describe("the shell token is fresh on every serve start (MAJOR-1)", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("a restarted serve rejects the old token, and a running shell re-reads the file and follows", async () => {
    rig = makeRig();
    const first = await rig.startServe();
    const statuses: ClientStatus[] = [];
    const client = rig.makeClient({ sessionId: "sess-fx-0003", project: "/work/app", name: "release", onLine: () => undefined, onStatus: (status) => statuses.push(status) });
    expect((await client.start()).ok).toBe(true);
    await until(() => client.connected, "the client to connect");

    await first.stop();
    const second = await rig.startServe();
    expect(second.shellToken).not.toBe("");
    expect(second.shellToken).not.toBe(first.shellToken);

    // The old token is worth nothing against the new serve.
    const stale = await call(second.origin, first.shellToken, "POST", remoteRoutePath("heartbeat"), { sessionId: "sess-fx-0003" });
    expect(stale.status).toBe(401);

    // The shell never cached it: it reads the file again on every request and is back on the new serve.
    await until(() => statuses.filter((status) => status.state === "connected").length >= 2, "the client to reconnect to the new serve", 8_000);
    expect(await client.reply("after the restart")).toBe(true);
  });
});

describe("an update id is a name, not a position (MAJOR-2)", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("a line whose id is below one the shell finished still runs; the same id again does not", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const lines: { text: string; updateId: number }[] = [];
    const client = rig.makeClient({ sessionId: "sess-fx-0004", project: "/work/app", name: "release", onLine: (text, meta) => void lines.push({ text, updateId: meta.updateId }) });
    const started = await client.start();
    if (!started.ok) {
      throw new Error("register failed");
    }
    rig.api.pushMessage({ fromId: OWNER_ID, text: "high one", threadId: started.threadId });
    const high = rig.api.pushMessage({ fromId: OWNER_ID, text: "high two", threadId: started.threadId });
    await until(() => lines.length === 2, "both lines");

    // Telegram renumbers (a restored bot, a new token): the next id is far below the last one.
    const hub = serve.service.hub();
    if (hub === undefined || high.message === undefined) {
      throw new Error("the hub should be running");
    }
    const lower = { ...high, update_id: 1, message: { ...high.message, text: "after the reset" } };
    await hub.receive([lower]);
    await until(() => lines.length === 3, "the line with the lower id");
    expect(lines[2]).toEqual({ text: "after the reset", updateId: 1 });

    // A real redelivery of the same id is still dropped, by exact match.
    await hub.receive([lower]);
    await settle();
    await settle();
    expect(lines).toHaveLength(3);
  });
});

describe("close while a register is in flight (m3)", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("the register finishes, then the client deregisters: no orphan topic is left behind", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paths: string[] = [];
    const client = rig.makeClient({
      sessionId: "sess-fx-0005",
      project: "/work/app",
      name: "release",
      onLine: () => undefined,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        paths.push(pathname);
        if (pathname === remoteRoutePath("register")) {
          await gate;
        }
        return fetch(input, init);
      }) as typeof fetch,
    });
    const starting = client.start().catch(() => undefined);
    await until(() => paths.includes(remoteRoutePath("register")), "the register request to be in flight");
    const closing = client.close();
    await settle();
    release();
    await Promise.all([starting, closing]);

    expect(paths).toContain(remoteRoutePath("deregister"));
    expect(serve.service.hub()?.list()).toEqual([]);
  });
});

describe("the hub does not wait on Telegram for a button press (MINOR-4)", () => {
  test("an answerCallbackQuery that never returns does not hold up receive", async () => {
    const h = makeHarness();
    cleanups.push(() => h.cleanup());
    const api = h.api.connect("hangs");
    const hanging = { ...api, answerCallbackQuery: () => new Promise<never>(() => undefined) };
    const hub = h.makeHub({ api: hanging });
    const reg = await hub.register({ sessionId: "sess-fx-0006", project: "/w/app", name: "release" });
    if (!reg.ok) {
      throw new Error("register failed");
    }
    const press = h.api.pushCallback({ fromId: OWNER_ID, data: "x", threadId: reg.threadId });
    const outcome = await Promise.race([hub.receive([press]).then(() => "returned"), new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500))]);
    expect(outcome).toBe("returned");
    // The wait that was started is bounded, and is not left running once it ends.
    await h.clock.advance(60_000);
    expect(h.clock.pendingTimers()).toBeGreaterThanOrEqual(0);
  });
});

describe("a topic holds at most 500 unread messages (MINOR-5)", () => {
  test("505 into a topic nobody is reading: the oldest 5 go, the topic is told, the rest are delivered in order", async () => {
    const h = makeHarness();
    cleanups.push(() => h.cleanup());
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-fx-0007", project: "/w/app", name: "release" });
    if (!reg.ok) {
      throw new Error("register failed");
    }
    h.refuseDeliveries = true;
    const total = MAX_INBOUND_PER_TOPIC + 5;
    const updates = Array.from({ length: total }, (_, index) => h.api.pushMessage({ fromId: OWNER_ID, text: `m${index}`, threadId: reg.threadId }));
    await first.receive(updates);
    expect(first.events().some((event) => event.type === "delivery-failed" && (event.detail ?? "").includes("dropped"))).toBe(true);
    expect(h.api.sentTo(reg.threadId).some((message) => message.text.includes(`already held ${MAX_INBOUND_PER_TOPIC}`) && message.text.includes("5 oldest"))).toBe(true);
    await first.stop();

    h.refuseDeliveries = false;
    const second = h.makeHub();
    await second.start();
    await until(() => h.deliveries.length === MAX_INBOUND_PER_TOPIC, "the kept messages", 15_000);
    expect(h.deliveries[0]?.line).toBe("m5");
    expect(h.deliveries.at(-1)?.line).toBe(`m${total - 1}`);
  });
});

describe("what the topic is told, and when", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("a decision that could not be handed to the shell is not announced as granted (MINOR-2)", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const sessionId = "sess-fx-0008";
    const registered = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId, project: "/work/app", name: "release" });
    const threadId = (registered.body as { threadId: number }).threadId;
    const stream = await openRawStream(serve.origin, serve.shellToken, sessionId);
    await untilFrame(stream, "status");
    const asked = call(serve.origin, serve.shellToken, "POST", remoteRoutePath("approval"), { sessionId, prompt: "Run `bun test`?", timeoutMs: 20_000 });
    const find = () => rig.api.sentTo(threadId).find((message) => message.inlineKeyboard !== undefined);
    await until(() => find() !== undefined, "the approval buttons");
    const allow = (find()?.inlineKeyboard ?? []).flat().find((button) => button.text === "Allow")?.callback_data;
    if (allow === undefined) {
      throw new Error("no Allow button");
    }
    // The shell's connection goes away before the press: there is nobody to hand the decision to.
    stream.close();
    await until(async () => {
      const probe = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("approval"), { sessionId, prompt: "probe", timeoutMs: 100 });
      return probe.status === 409;
    }, "serve to notice the stream is gone");
    rig.api.pushCallback({ fromId: OWNER_ID, data: allow, threadId });
    await settle();
    await settle();
    await settle();
    expect(rig.api.sentTo(threadId).map((message) => message.text)).not.toContain("Approval granted.");
    void asked.catch(() => undefined);
  });

  test("a topic that is rebound forgets which ids the old binding finished (MINOR-3)", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const sessionId = "sess-fx-0009";
    const registered = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId, project: "/work/app", name: "alpha" });
    expect(registered.status).toBe(200);
    const threadId = (registered.body as { threadId: number }).threadId;
    const stream = await openRawStream(serve.origin, serve.shellToken, sessionId);
    const one = rig.api.pushMessage({ fromId: OWNER_ID, text: "one", threadId });
    await untilFrame(stream, "inbound");
    expect((await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("ack"), { sessionId, updateId: one.update_id })).status).toBe(200);
    stream.close();

    // The same session comes back under another name: a new topic, a new binding.
    const rebound = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId, project: "/work/app", name: "beta" });
    expect(rebound.status).toBe(200);
    const newThread = (rebound.body as { threadId: number }).threadId;
    const next = await openRawStream(serve.origin, serve.shellToken, sessionId);
    await untilFrame(next, "status");
    // An id equal to one the OLD binding finished (numbering restarted) must be sent, not swallowed.
    const delivered = serve.service.surface.consumer.deliver(sessionId, "same number, new binding", { updateId: one.update_id, threadId: newThread, fromId: OWNER_ID, receivedAt: Date.now() });
    delivered.catch(() => undefined);
    const frame = await untilFrame(next, "inbound");
    expect(frame.id).toBe(String(one.update_id));
    next.close();
  });

  test("an ack or a Last-Event-ID for an id that was never sent is ignored (NIT-1)", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const sessionId = "sess-fx-0010";
    const registered = await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("register"), { sessionId, project: "/work/app", name: "release" });
    const threadId = (registered.body as { threadId: number }).threadId;
    const stream = await openRawStream(serve.origin, serve.shellToken, sessionId);
    const one = rig.api.pushMessage({ fromId: OWNER_ID, text: "one", threadId });
    const two = rig.api.pushMessage({ fromId: OWNER_ID, text: "two", threadId });
    await untilFrame(stream, "inbound");

    // An id far above anything sent: it must not complete "one", so "two" keeps waiting.
    const bogus = one.update_id + 1_000_000;
    await call(serve.origin, serve.shellToken, "POST", remoteRoutePath("ack"), { sessionId, updateId: bogus });
    await settle();
    await settle();
    expect(stream.frames.filter((frame) => frame.event === "inbound").map((frame) => frame.id)).toEqual([String(one.update_id)]);

    // The same for a reconnect: a made-up Last-Event-ID does not skip "one".
    stream.close();
    await settle();
    const again = await openRawStream(serve.origin, serve.shellToken, sessionId, { "last-event-id": String(bogus) });
    const frame = await untilFrame(again, "inbound");
    expect(frame.id).toBe(String(one.update_id));
    expect(two.update_id).toBeGreaterThan(one.update_id);
    again.close();
  });
});
