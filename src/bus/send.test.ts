import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BusRefusalCode, isBusRefusal } from "./errors";
import { cursorAtStart, readEvents } from "./log";
import { eventsPath } from "./paths";
import { writePresence } from "./presence";
import type { PresenceRecord } from "./schema";
import { CLI_RATE_LIMIT_PER_MINUTE, rateLimitBypassed, sendMessage, type SendInput } from "./send";

// AC7: send semantics and every refusal by its code.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function busRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-send-"));
  ROOTS.push(dir);
  return path.join(dir, "bus");
}

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const LIVE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const LIVE_TWIN = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const STALE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION = "9b2f7e1c-3f4a-4c55-8d3e-2a1b0c9d8e7f";
const liveness = { host: "this-host", isAlive: (pid: number) => pid === 100 };
const quietEnv = { NODE_ENV: "test" };

function presence(instanceId: string, name: string, heartbeatAt: number): PresenceRecord {
  return {
    schemaVersion: 1,
    instanceId,
    name,
    pid: 100,
    host: "this-host",
    sessionId: SESSION,
    checkout: "/repo",
    branch: null,
    surface: "tui",
    status: "idle",
    activity: "",
    startedAt: new Date(heartbeatAt).toISOString(),
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    keryxVersion: "0.2.121",
  };
}

async function seeded(): Promise<string> {
  const root = await busRoot();
  await writePresence(root, presence(LIVE, "release", NOW - 1_000));
  await writePresence(root, presence(STALE, "sleepy", NOW - 60_000)); // same host, pid alive, old heartbeat
  return root;
}

function input(overrides: Partial<SendInput> = {}): SendInput {
  return { toLabel: "@all", kind: "notice", body: "hello", origin: "cli", now: () => NOW, liveness, env: quietEnv, ...overrides };
}

async function refusal(promise: Promise<unknown>): Promise<BusRefusalCode | undefined> {
  try {
    await promise;
  } catch (error) {
    return isBusRefusal(error) ? error.code : undefined;
  }
  return undefined;
}

describe("sendMessage", () => {
  test("@all is written as [\"*\"], from cli with a fresh instanceId each time", async () => {
    const root = await seeded();
    const first = await sendMessage(root, input());
    const second = await sendMessage(root, input());

    expect(first.resolvedTo).toEqual(["*"]);
    expect(first.event.to).toEqual(["*"]);
    expect(first.event.toLabel).toBe("@all");
    expect(first.event.from.name).toBe("cli");
    expect(first.event.from.origin).toBe("cli");
    expect(first.event.from.instanceId).not.toBe(second.event.from.instanceId);
    expect([first.seq, second.seq]).toEqual([1, 2]);
  });

  test("@name resolves to every LIVE instance holding it", async () => {
    const root = await seeded();
    await writePresence(root, presence(LIVE_TWIN, "release", NOW - 2_000));
    const sent = await sendMessage(root, input({ toLabel: "@release", kind: "question" }));
    expect(sent.resolvedTo).toEqual([LIVE, LIVE_TWIN].sort());
    expect(sent.event.kind).toBe("question");
  });

  test("accepts notice, question, handoff and reply; reply carries refs.replyTo", async () => {
    const root = await seeded();
    const asked = await sendMessage(root, input({ toLabel: "@release", kind: "question" }));
    await sendMessage(root, input({ kind: "handoff" }));
    const reply = await sendMessage(root, input({ kind: "reply", replyTo: asked.id }));
    expect(reply.event.refs).toEqual({ replyTo: asked.id });
    const kinds = (await readEvents(root, await cursorAtStart(root))).events.map((e) => e.kind);
    expect(kinds).toEqual(["question", "handoff", "reply"]);
  });

  test("refusals by name", async () => {
    const root = await seeded();
    expect(await refusal(sendMessage(root, input({ toLabel: "@nobody" })))).toBe("unknown-recipient");
    expect(await refusal(sendMessage(root, input({ toLabel: "release" })))).toBe("unknown-recipient");
    expect(await refusal(sendMessage(root, input({ toLabel: "@sleepy" })))).toBe("recipient-not-live");
    expect(await refusal(sendMessage(root, input({ kind: "reply" })))).toBe("reply-without-replyTo");
    expect(await refusal(sendMessage(root, input({ kind: "reply", replyTo: "../x" })))).toBe("invalid-id");
    expect(await refusal(sendMessage(root, input({ kind: "pause-request" })))).toBe("invalid-event");
    expect(await refusal(sendMessage(root, input({ body: "é".repeat(1025) })))).toBe("body-too-large");
    expect((await readEvents(root, await cursorAtStart(root))).events).toEqual([]);
  });

  test("a gone holder of the name is recipient-not-live too", async () => {
    const root = await busRoot();
    await writePresence(root, { ...presence(STALE, "ghost", NOW - 60_000), pid: 999 });
    expect(await refusal(sendMessage(root, input({ toLabel: "@ghost" })))).toBe("recipient-not-live");
  });

  test("the body is stored redacted", async () => {
    const root = await seeded();
    const secret = "ghp_" + "c".repeat(36);
    const sent = await sendMessage(root, input({ body: `key ${secret}` }));
    expect(sent.event.body).not.toContain(secret);
    expect(await readFile(eventsPath(root), "utf8")).not.toContain(secret);
  });

  test("the 31st CLI message within a minute is rate-limited; the window then slides", async () => {
    const root = await seeded();
    for (let i = 0; i < CLI_RATE_LIMIT_PER_MINUTE; i += 1) await sendMessage(root, input({ body: `m${i}` }));
    expect(await refusal(sendMessage(root, input()))).toBe("rate-limited");
    expect(await sendMessage(root, input({ now: () => NOW + 61_000 }))).toEqual(
      expect.objectContaining({ seq: CLI_RATE_LIMIT_PER_MINUTE + 1 }),
    );
  });

  test("the test-only bypass lifts the limit, and only in a test context", async () => {
    expect(rateLimitBypassed({ NODE_ENV: "test", KERYX_TEST_BUS_RATE: "off" })).toBe(true);
    expect(rateLimitBypassed({ KERYX_TEST_BUS: "1", KERYX_TEST_BUS_RATE: "off" })).toBe(true);
    expect(rateLimitBypassed({ KERYX_TEST_BUS_RATE: "off" })).toBe(false);
    expect(rateLimitBypassed({ NODE_ENV: "production", KERYX_TEST_BUS_RATE: "off" })).toBe(false);
    expect(rateLimitBypassed({ NODE_ENV: "test", KERYX_TEST_BUS_RATE: "on" })).toBe(false);

    const root = await seeded();
    const env = { NODE_ENV: "test", KERYX_TEST_BUS_RATE: "off" };
    for (let i = 0; i <= CLI_RATE_LIMIT_PER_MINUTE; i += 1) await sendMessage(root, input({ env }));
    expect((await readEvents(root, await cursorAtStart(root))).events.length).toBe(CLI_RATE_LIMIT_PER_MINUTE + 1);
  });
});
