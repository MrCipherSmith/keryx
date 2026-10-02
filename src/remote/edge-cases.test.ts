// Edge cases around the durable queues, the outbound limits, the config and the
// HTTP client's error mapping: corrupt files, rate limits, bounds, closed schema.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHttpBotApi } from "./bot-api-http";
import {
  DEFAULT_APPROVAL_WAIT_MS,
  DEFAULT_ORPHAN_MS,
  DEFAULT_REMOTE_PERMISSION_MODE,
  DEFAULT_RUN_TIMEOUT_MS,
  LEGACY_RUN_TIMEOUT_MS,
  loadRemoteConfig,
  parseRemoteConfig,
  saveRemoteConfig,
} from "./config";
import { DurableLog } from "./durable-log";
import { nameKey } from "./naming";
import { OUTBOUND_MAX_ENTRIES } from "./outbound-queue";
import { INBOUND_DIRNAME, REGISTRY_FILE, remoteDirPath } from "./paths";
import { BotApiError, type BotApiErrorKind, isRetryable, TELEGRAM_MAX_TEXT } from "./types";
import { type Harness, makeHarness, makeRemoteDir, OWNER_ID, until } from "./remote.test-helpers";
import { rmSync } from "node:fs";

let h: Harness;
const dirs: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Line {
  id: string;
  n: number;
}
const parseLine = (value: unknown): Line | undefined => {
  const raw = value as { id?: unknown; n?: unknown } | null;
  return typeof raw?.id === "string" && typeof raw.n === "number" ? { id: raw.id, n: raw.n } : undefined;
};

describe("durable log", () => {
  function logAt(dir: string, maxEntries?: number): DurableLog<Line> {
    return new DurableLog<Line>({ file: path.join(dir, "log.jsonl"), parse: parseLine, ...(maxEntries === undefined ? {} : { maxEntries }) });
  }

  test("pending is adds minus acks, and survives a reload", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const a = logAt(dir);
    a.load();
    a.add({ id: "x", n: 1 });
    a.add({ id: "y", n: 2 });
    a.add({ id: "z", n: 3 });
    a.ack("y");
    const b = logAt(dir);
    b.load();
    expect(b.pending().map((e) => e.id)).toEqual(["x", "z"]);
  });

  test("a duplicate id is not added twice", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const log = logAt(dir);
    log.load();
    expect(log.add({ id: "x", n: 1 }).added).toBe(true);
    expect(log.add({ id: "x", n: 2 }).added).toBe(false);
    expect(log.pending()).toEqual([{ id: "x", n: 1 }]);
  });

  test("corrupt lines and a torn tail are skipped, counted and repaired", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const file = path.join(dir, "log.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ op: "add", entry: { id: "a", n: 1 } }),
        "this is not json",
        JSON.stringify({ op: "add", entry: { id: "b", n: "wrong type" } }),
        JSON.stringify({ op: "add", entry: { id: "c", n: 3 } }),
        '{"op":"add","entry":{"id":"d","n":',
      ].join("\n"),
      { mode: 0o600 },
    );
    const log = logAt(dir);
    const report = log.load();
    expect(report.corruptLines).toBe(3);
    expect(log.pending().map((e) => e.id)).toEqual(["a", "c"]);

    // The next append is not glued onto the torn bytes.
    log.add({ id: "e", n: 5 });
    const again = logAt(dir);
    expect(again.load().corruptLines).toBe(0);
    expect(again.pending().map((e) => e.id)).toEqual(["a", "c", "e"]);
  });

  test("the bound drops the oldest pending entries and reports them", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const log = logAt(dir, 3);
    log.load();
    for (let n = 1; n <= 3; n += 1) log.add({ id: `m${n}`, n });
    const { dropped } = log.add({ id: "m4", n: 4 });
    expect(dropped.map((e) => e.id)).toEqual(["m1"]);
    const reloaded = logAt(dir, 3);
    reloaded.load();
    expect(reloaded.pending().map((e) => e.id)).toEqual(["m2", "m3", "m4"]);
  });
});

describe("a corrupt queue file does not stop the hub", () => {
  test("garbage and a torn tail in an inbound queue: the good entry is delivered, new input still works", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.stop();

    const inbound = path.join(remoteDirPath(h.dir), INBOUND_DIRNAME);
    mkdirSync(inbound, { recursive: true });
    const file = path.join(inbound, `${createHash("sha256").update(nameKey("release")).digest("hex").slice(0, 32)}.jsonl`);
    const entry = { id: "u5000", updateId: 5000, kind: "text", fromId: OWNER_ID, receivedAt: 1, text: "survivor" };
    writeFileSync(file, `\u0000\u0000garbage\n${JSON.stringify({ op: "add", entry })}\n{"op":"add","entry":{"id":"u5001"`, { mode: 0o600 });

    const second = h.makeHub();
    await second.start();
    await until(() => h.deliveries.length === 1, "survivor delivered");
    expect(h.deliveries[0]?.line).toBe("survivor");

    h.api.pushMessage({ fromId: OWNER_ID, text: "after the damage", threadId: reg.threadId });
    await until(() => h.deliveries.length === 2, "new input delivered");
    expect(h.deliveries[1]?.line).toBe("after the damage");
  });

  test("an unreadable registry file starts an empty registry instead of crashing", () => {
    h = makeHarness();
    const dir = remoteDirPath(h.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, REGISTRY_FILE), "{ not json", { mode: 0o600 });
    const hub = h.makeHub();
    expect(hub.list()).toEqual([]);
  });

  test("a corrupt poller offset file falls back to zero", async () => {
    h = makeHarness();
    const dir = remoteDirPath(h.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "poller-state.json"), "\u0000\u0000", { mode: 0o600 });
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await hub.start();
    h.api.pushMessage({ fromId: OWNER_ID, text: "works", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "delivery");
  });
});

describe("outbound queue", () => {
  async function registered() {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    return { hub, reg };
  }

  test("a 429 holds the queue for retry_after, then sends", async () => {
    const { hub, reg } = await registered();
    await hub.start();
    const before = h.api.callCount("sendMessage");
    h.api.rateLimitNext("sendMessage", 5);
    await hub.send("sess-one-0001", "slow down");
    expect(h.api.sentTo(reg.threadId).some((m) => m.text === "slow down")).toBe(false);
    expect(hub.outboundPending()).toBe(1);
    const afterFirst = h.api.callCount("sendMessage");
    expect(afterFirst).toBe(before + 1);

    await h.clock.advance(4_000);
    expect(h.api.callCount("sendMessage")).toBe(afterFirst);
    await h.clock.advance(1_000);
    await until(() => h.api.sentTo(reg.threadId).some((m) => m.text === "slow down"), "sent after retry_after");
    expect(hub.outboundPending()).toBe(0);
  });

  test("order is kept across a rate limit", async () => {
    const { hub, reg } = await registered();
    await hub.start();
    h.api.rateLimitNext("sendMessage", 2);
    await hub.send("sess-one-0001", "one");
    await hub.send("sess-one-0001", "two");
    await hub.send("sess-one-0001", "three");
    await h.clock.advance(2_000);
    await until(() => hub.outboundPending() === 0, "queue drained");
    const order = h.api.sentTo(reg.threadId).map((m) => m.text).filter((t) => ["one", "two", "three"].includes(t));
    expect(order).toEqual(["one", "two", "three"]);
  });

  test("the queue is bounded at 200: the oldest are dropped and said so", async () => {
    const { hub, reg } = await registered();
    h.api.setDown(true);
    // Drain the registration notice's failed attempt first so only our messages count.
    for (let n = 1; n <= OUTBOUND_MAX_ENTRIES + 5; n += 1) {
      await hub.send("sess-one-0001", `m${n}`);
    }
    expect(hub.outboundPending()).toBe(OUTBOUND_MAX_ENTRIES);
    expect(hub.events().filter((e) => e.type === "outbound-dropped").length).toBeGreaterThanOrEqual(5);

    h.api.setDown(false);
    await hub.flushOutbound();
    await h.clock.advance(5_000);
    await until(() => hub.outboundPending() === 0, "queue drained");
    const sent = h.api.sentTo(reg.threadId).map((m) => m.text);
    expect(sent).toContain(`m${OUTBOUND_MAX_ENTRIES + 5}`);
    expect(sent).not.toContain("m1");
    expect(sent).not.toContain("m5");
  });

  test("a message over the Telegram limit is split into numbered parts, not clamped or refused", async () => {
    const { hub, reg } = await registered();
    await hub.send("sess-one-0001", "x".repeat(TELEGRAM_MAX_TEXT + 500));
    const texts = h.api.sentTo(reg.threadId).map((m) => m.text);
    const parts = texts.slice(-2);
    expect(parts[0]?.startsWith("(1/2)\n")).toBe(true);
    expect(parts[1]?.startsWith("(2/2)\n")).toBe(true);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    }
    const body = parts.map((p) => p.slice(p.indexOf("\n") + 1)).join("");
    expect(body).toBe("x".repeat(TELEGRAM_MAX_TEXT + 500));
  });

  test("a permanent refusal drops the message instead of blocking the queue", async () => {
    const { hub, reg } = await registered();
    await hub.send("sess-one-0001", "before");
    // The topic vanishes behind the hub's back: sending to it is a 400.
    await h.api.deleteForumTopic({ chatId: h.api.chatId, messageThreadId: reg.threadId });
    await hub.send("sess-one-0001", "into the void");
    expect(hub.outboundPending()).toBe(0);
    expect(hub.events().some((e) => e.type === "outbound-dropped")).toBe(true);
  });

  test("a network failure keeps the message and the hub retries on its own", async () => {
    const { hub, reg } = await registered();
    await hub.start();
    h.api.setDown(true);
    await hub.send("sess-one-0001", "when the network is back");
    expect(hub.outboundPending()).toBe(1);
    h.api.setDown(false);
    await h.clock.advance(10_000);
    await until(() => h.api.sentTo(reg.threadId).some((m) => m.text === "when the network is back"), "retry");
  });
});

describe("config", () => {
  test("defaults fill the two timeouts", () => {
    const parsed = parseRemoteConfig({ schemaVersion: 1, chatId: -1001, allowedUserIds: [1] });
    expect(parsed).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        chatId: -1001,
        allowedUserIds: [1],
        orphanMs: DEFAULT_ORPHAN_MS,
        runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
        permissionMode: DEFAULT_REMOTE_PERMISSION_MODE,
        approvalTimeoutMs: DEFAULT_APPROVAL_WAIT_MS,
      },
    });
    expect(DEFAULT_ORPHAN_MS).toBe(10 * 60_000);
    // Flow 396: no run limit by default (the old 30 minutes is LEGACY_RUN_TIMEOUT_MS, an explicit opt-in).
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(0);
    expect(LEGACY_RUN_TIMEOUT_MS).toBe(30 * 60_000);
    expect(DEFAULT_APPROVAL_WAIT_MS).toBe(15 * 60_000);
  });

  test("the schema is closed and strict", () => {
    const base = { schemaVersion: 1, chatId: -1001, allowedUserIds: [1] };
    expect(parseRemoteConfig({ ...base, extra: true }).ok).toBe(false);
    expect(parseRemoteConfig({ ...base, schemaVersion: 2 }).ok).toBe(false);
    expect(parseRemoteConfig({ ...base, chatId: 0 }).ok).toBe(false);
    expect(parseRemoteConfig({ ...base, allowedUserIds: [] }).ok).toBe(false);
    expect(parseRemoteConfig({ ...base, allowedUserIds: ["1"] }).ok).toBe(false);
    expect(parseRemoteConfig({ ...base, orphanMs: 0 }).ok).toBe(false);
    expect(parseRemoteConfig({ ...base, runTimeoutMs: 1.5 }).ok).toBe(false);
    expect(parseRemoteConfig([]).ok).toBe(false);
    expect(parseRemoteConfig(null).ok).toBe(false);
  });

  test("an unknown key that looks like a secret is not echoed back", () => {
    const parsed = parseRemoteConfig({ schemaVersion: 1, chatId: -1001, allowedUserIds: [1], "7123456789:AAHsecret": 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).not.toContain("7123456789");
    }
  });

  test("save and load round-trip, owner-only; a missing file says what to create", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    const missing = loadRemoteConfig(dir);
    expect(missing.ok).toBe(false);
    saveRemoteConfig({ schemaVersion: 1, chatId: -1001, allowedUserIds: [1, 2], orphanMs: 5_000, runTimeoutMs: 9_000 }, dir);
    const loaded = loadRemoteConfig(dir);
    expect(loaded).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        chatId: -1001,
        allowedUserIds: [1, 2],
        orphanMs: 5_000,
        runTimeoutMs: 9_000,
        permissionMode: DEFAULT_REMOTE_PERMISSION_MODE,
        approvalTimeoutMs: DEFAULT_APPROVAL_WAIT_MS,
      },
    });
  });

  test("a config file that is not JSON is refused", () => {
    const dir = makeRemoteDir();
    dirs.push(dir);
    mkdirSync(path.join(dir, "remote"), { recursive: true });
    writeFileSync(path.join(dir, "remote", "config.json"), "{ nope", { mode: 0o600 });
    expect(loadRemoteConfig(dir).ok).toBe(false);
  });
});

describe("the HTTP client's request and error mapping (against an injected stand-in)", () => {
  const TOKEN = "7000000001:AAEdgeCaseTokenValue_abcdefghijk";

  function client(respond: (url: string, body: Record<string, unknown>) => Response | Error) {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push({ url: String(input), body });
      const result = respond(String(input), body);
      if (result instanceof Error) throw result;
      return result;
    }) as typeof fetch;
    return { api: createHttpBotApi({ token: TOKEN, baseUrl: "http://bot-api.invalid/", fetchImpl }), seen };
  }
  const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

  test("getUpdates sends the offset and asks only for messages, button presses and the bot's own membership changes", async () => {
    const { api, seen } = client(() => ok([{ update_id: 7 }]));
    const updates = await api.getUpdates({ offset: 7, timeoutSec: 25, limit: 50 });
    expect(updates).toEqual([{ update_id: 7 }]);
    expect(seen[0]?.url).toBe(`http://bot-api.invalid/bot${TOKEN}/getUpdates`);
    expect(seen[0]?.body).toEqual({ timeout: 25, offset: 7, limit: 50, allowed_updates: ["message", "callback_query", "my_chat_member"] });
  });

  test("topic and message calls use Telegram's field names", async () => {
    const { api, seen } = client((url) => (url.endsWith("createForumTopic") ? ok({ message_thread_id: 55 }) : ok({ message_id: 9 })));
    expect(await api.createForumTopic({ chatId: -1001, name: "release" })).toEqual({ message_thread_id: 55 });
    await api.sendMessage({ chatId: -1001, text: "hi", messageThreadId: 55, inlineKeyboard: [[{ text: "Yes", callback_data: "y" }]] });
    expect(seen[0]?.body).toEqual({ chat_id: -1001, name: "release" });
    expect(seen[1]?.body.message_thread_id).toBe(55);
    expect(seen[1]?.body.chat_id).toBe(-1001);
    expect(seen[1]?.body.reply_markup).toBeDefined();
  });

  test("HTTP statuses map to error kinds", async () => {
    const statuses: [number, BotApiErrorKind, boolean][] = [
      [409, "conflict", false],
      [429, "rate-limited", true],
      [500, "server", true],
      [503, "server", true],
      [400, "rejected", false],
      [403, "rejected", false],
    ];
    for (const [status, kind, retryable] of statuses) {
      const { api } = client(() => new Response(JSON.stringify({ ok: false, description: "nope", parameters: { retry_after: 4 } }), { status }));
      const error = (await api.sendMessage({ chatId: 1, text: "x" }).catch((e: unknown) => e)) as BotApiError;
      expect(error).toBeInstanceOf(BotApiError);
      expect(error.kind).toBe(kind);
      expect(isRetryable(error)).toBe(retryable);
      if (status === 429) expect(error.retryAfterSec).toBe(4);
    }
  });

  test("a transport failure is a network error", async () => {
    const { api } = client(() => new TypeError("connection reset"));
    const error = (await api.getUpdates({ timeoutSec: 0 }).catch((e: unknown) => e)) as BotApiError;
    expect(error.kind).toBe("network");
    expect(isRetryable(error)).toBe(true);
  });
});

describe("the in-process fake behaves like Telegram where the hub depends on it", () => {
  test("update ids increase strictly and an offset confirms what came before it", async () => {
    h = makeHarness();
    const a = h.api.pushMessage({ fromId: 1, text: "a" });
    const b = h.api.pushMessage({ fromId: 1, text: "b" });
    expect(b.update_id).toBeGreaterThan(a.update_id);
    expect((await h.api.getUpdates({ timeoutSec: 0 })).map((u) => u.update_id)).toEqual([a.update_id, b.update_id]);
    expect((await h.api.getUpdates({ offset: b.update_id, timeoutSec: 0 })).map((u) => u.update_id)).toEqual([b.update_id]);
    expect(await h.api.getUpdates({ offset: b.update_id + 1, timeoutSec: 0 })).toEqual([]);
  });

  test("sending into a deleted topic and deleting twice are 400s", async () => {
    h = makeHarness();
    const { message_thread_id } = await h.api.createForumTopic({ chatId: h.api.chatId, name: "t" });
    await h.api.deleteForumTopic({ chatId: h.api.chatId, messageThreadId: message_thread_id });
    const send = await h.api.sendMessage({ chatId: h.api.chatId, text: "x", messageThreadId: message_thread_id }).catch((e: unknown) => e);
    const again = await h.api.deleteForumTopic({ chatId: h.api.chatId, messageThreadId: message_thread_id }).catch((e: unknown) => e);
    expect((send as BotApiError).kind).toBe("rejected");
    expect((again as BotApiError).kind).toBe("rejected");
  });
});
