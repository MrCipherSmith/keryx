import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BusRefusalCode, isBusRefusal } from "./errors";
import { cursorAtStart, readEvents } from "./log";
import { eventsPath } from "./paths";
import { writePresence } from "./presence";
import type { PresenceRecord } from "./schema";
import {
  AGENT_RATE_LIMIT_PER_MINUTE,
  CLI_RATE_LIMIT_PER_MINUTE,
  OPERATOR_RATE_LIMIT_PER_MINUTE,
  rateLimitBypassed,
  sendMessage,
  type SendInput,
} from "./send";

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

  test("the 31st operator message within a minute from ONE instance is rate-limited (D-12); another instance is unaffected", async () => {
    const root = await seeded();
    const from = { instanceId: LIVE, name: "release", origin: "operator" as const };
    for (let i = 0; i < OPERATOR_RATE_LIMIT_PER_MINUTE; i += 1) {
      await sendMessage(root, input({ origin: "operator", from, body: `m${i}` }));
    }
    expect(await refusal(sendMessage(root, input({ origin: "operator", from })))).toBe("rate-limited");

    // A second sender is bounded by its OWN budget, not the first's (D-12).
    const otherFrom = { instanceId: LIVE_TWIN, name: "release", origin: "operator" as const };
    const fromOther = await sendMessage(root, input({ origin: "operator", from: otherFrom }));
    expect(fromOther.event.from.instanceId).toBe(LIVE_TWIN);

    // The window then slides, like the CLI limit.
    expect(await sendMessage(root, input({ origin: "operator", from, now: () => NOW + 61_000 }))).toEqual(
      expect.objectContaining({ seq: OPERATOR_RATE_LIMIT_PER_MINUTE + 2 }),
    );
  });

  test("agent-origin sends are written with from.origin agent (review r1 F3)", async () => {
    const root = await seeded();
    const from = { instanceId: LIVE, name: "release", origin: "agent" as const };
    const sent = await sendMessage(root, input({ origin: "agent", from, toLabel: "@all" }));
    expect(sent.event.from.origin).toBe("agent");
    expect(sent.event.from.instanceId).toBe(LIVE);
  });

  test("an agent send needs from, like an operator send", async () => {
    const root = await seeded();
    expect(await refusal(sendMessage(root, input({ origin: "agent", toLabel: "@all" })))).toBe("invalid-event");
  });

  test("the 11th agent message within a minute from ONE instance is rate-limited (D-12, review r1 F3/F5); the window then slides", async () => {
    const root = await seeded();
    const from = { instanceId: LIVE, name: "release", origin: "agent" as const };
    for (let i = 0; i < AGENT_RATE_LIMIT_PER_MINUTE; i += 1) {
      await sendMessage(root, input({ origin: "agent", from, toLabel: "@all", body: `m${i}` }));
    }
    expect(await refusal(sendMessage(root, input({ origin: "agent", from, toLabel: "@all" })))).toBe("rate-limited");

    expect(
      await sendMessage(root, input({ origin: "agent", from, toLabel: "@all", now: () => NOW + 61_000 })),
    ).toEqual(expect.objectContaining({ seq: AGENT_RATE_LIMIT_PER_MINUTE + 1 }));
  });

  test("the agent budget is separate from the operator budget for the SAME instance (review r1 F3): exhausting one leaves the other free", async () => {
    const root = await seeded();
    const agentFrom = { instanceId: LIVE, name: "release", origin: "agent" as const };
    for (let i = 0; i < AGENT_RATE_LIMIT_PER_MINUTE; i += 1) {
      await sendMessage(root, input({ origin: "agent", from: agentFrom, toLabel: "@all", body: `a${i}` }));
    }
    expect(await refusal(sendMessage(root, input({ origin: "agent", from: agentFrom, toLabel: "@all" })))).toBe(
      "rate-limited",
    );

    // The operator budget for the SAME instance is untouched by the agent budget being spent.
    const operatorFrom = { instanceId: LIVE, name: "release", origin: "operator" as const };
    const stillWorks = await sendMessage(root, input({ origin: "operator", from: operatorFrom, toLabel: "@all" }));
    expect(stillWorks.event.from.origin).toBe("operator");

    // And an agent send from a DIFFERENT instance is unaffected too.
    const otherAgentFrom = { instanceId: LIVE_TWIN, name: "release", origin: "agent" as const };
    await writePresence(root, presence(LIVE_TWIN, "release", NOW - 2_000));
    const otherWorks = await sendMessage(root, input({ origin: "agent", from: otherAgentFrom, toLabel: "@all" }));
    expect(otherWorks.event.from.instanceId).toBe(LIVE_TWIN);
  });

  test("the operator budget is separate from the agent budget for the SAME instance: exhausting the operator budget leaves agent sends free", async () => {
    const root = await seeded();
    const operatorFrom = { instanceId: LIVE, name: "release", origin: "operator" as const };
    for (let i = 0; i < OPERATOR_RATE_LIMIT_PER_MINUTE; i += 1) {
      await sendMessage(root, input({ origin: "operator", from: operatorFrom, toLabel: "@all", body: `o${i}` }));
    }
    expect(await refusal(sendMessage(root, input({ origin: "operator", from: operatorFrom, toLabel: "@all" })))).toBe(
      "rate-limited",
    );

    const agentFrom = { instanceId: LIVE, name: "release", origin: "agent" as const };
    const stillWorks = await sendMessage(root, input({ origin: "agent", from: agentFrom, toLabel: "@all" }));
    expect(stillWorks.event.from.origin).toBe("agent");
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

describe("sendMessage: toInstanceId (review r1 F4 — reply addressed by instance, not by name)", () => {
  test("bypasses name resolution: addresses the instance directly, and toLabel stays the display label", async () => {
    const root = await seeded();
    const sent = await sendMessage(root, input({ toLabel: "@ignored-for-routing", toInstanceId: LIVE }));
    expect(sent.resolvedTo).toEqual([LIVE]);
    expect(sent.event.to).toEqual([LIVE]);
    expect(sent.event.toLabel).toBe("@ignored-for-routing");
  });

  test("recipient-not-live when the instance has no presence at all, or is stale/gone — never unknown-recipient", async () => {
    const root = await seeded();
    expect(await refusal(sendMessage(root, input({ toInstanceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" })))).toBe(
      "recipient-not-live",
    );
    expect(await refusal(sendMessage(root, input({ toInstanceId: STALE })))).toBe("recipient-not-live");
  });

  test("invalid-id for a malformed toInstanceId", async () => {
    const root = await seeded();
    expect(await refusal(sendMessage(root, input({ toInstanceId: "../not-a-uuid" })))).toBe("invalid-id");
  });
});

describe("sendMessage: recipient-is-self (review r1 F6)", () => {
  test("an operator send to @<own-name> resolves only to self and is refused", async () => {
    const root = await seeded();
    const from = { instanceId: LIVE, name: "release", origin: "operator" as const };
    expect(await refusal(sendMessage(root, input({ origin: "operator", from, toLabel: "@release" })))).toBe(
      "recipient-is-self",
    );
  });

  test("an agent send to @<own-name> resolves only to self and is refused", async () => {
    const root = await seeded();
    const from = { instanceId: LIVE, name: "release", origin: "agent" as const };
    expect(await refusal(sendMessage(root, input({ origin: "agent", from, toLabel: "@release" })))).toBe(
      "recipient-is-self",
    );
  });

  test("a reply addressed back to one's own instance via toInstanceId is refused", async () => {
    const root = await seeded();
    const from = { instanceId: LIVE, name: "release", origin: "operator" as const };
    expect(
      await refusal(
        sendMessage(root, input({ origin: "operator", from, kind: "reply", replyTo: LIVE, toInstanceId: LIVE })),
      ),
    ).toBe("recipient-is-self");
  });

  test("@<name> held by self AND a live twin is NOT recipient-is-self (more than one live holder)", async () => {
    const root = await seeded();
    await writePresence(root, presence(LIVE_TWIN, "release", NOW - 2_000));
    const from = { instanceId: LIVE, name: "release", origin: "operator" as const };
    const sent = await sendMessage(root, input({ origin: "operator", from, toLabel: "@release" }));
    expect(sent.resolvedTo).toEqual([LIVE, LIVE_TWIN].sort());
  });

  test("@all is never recipient-is-self, even though the sender is itself a live instance", async () => {
    const root = await seeded();
    const from = { instanceId: LIVE, name: "release", origin: "operator" as const };
    const sent = await sendMessage(root, input({ origin: "operator", from, toLabel: "@all" }));
    expect(sent.resolvedTo).toEqual(["*"]);
  });

  test("a CLI send (no from.instanceId tied to a live instance) is never refused as recipient-is-self", async () => {
    const root = await seeded();
    const sent = await sendMessage(root, input({ origin: "cli", toLabel: "@release" }));
    expect(sent.resolvedTo).toEqual([LIVE]);
  });
});
