// Flow 376 block 3: the shell's side of remote control, against a fake client.
// No network, no serve: only what the bridge decides.

import { expect, test } from "bun:test";
import type { InboundMeta, RemoteClientOptions, StartResult } from "./client";
import {
  REMOTE_EVENT_LIMIT,
  REMOTE_REPLY_MAX_CHARS,
  RemoteBridge,
  type RemoteBridgeHost,
  type RemoteClientLike,
  TG_SOURCE,
  composeApprovalPrompt,
  composeReply,
  describeApprovalForTopic,
} from "./shell-bridge";

const META: InboundMeta = { updateId: 1, threadId: 7, fromId: 9, receivedAt: 0 };
// Shaped like a provider key; the redactor must not let it through.
const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp";

interface FakeClient extends RemoteClientLike {
  options: RemoteClientOptions;
  replies: string[];
  approvals: Array<{ prompt: string; timeoutMs: number }>;
  closed: number;
  isConnected: boolean;
  approvalAnswer: "allow" | "deny" | "throw";
  startResult: StartResult;
  replyOk: boolean;
  heartbeat: number | undefined;
}

function harness(opts: { busy?: boolean; startResult?: StartResult; runTimeoutMs?: number } = {}) {
  const calls: string[] = [];
  const state = { busy: opts.busy ?? false, now: 1_000_000 };
  const host: RemoteBridgeHost = {
    sessionId: () => "sess-1",
    project: () => "/proj",
    isBusy: () => state.busy,
    runLine: (t) => calls.push(`run:${t}`),
    enqueue: (t) => calls.push(`queue:${t}`),
    notice: (t) => calls.push(`notice:${t}`),
    cancelTurn: () => calls.push("cancel"),
    recordOn: (n) => calls.push(`on:${n}`),
    recordOff: () => calls.push("off"),
    onChange: () => calls.push("change"),
  };
  let client!: FakeClient;
  const bridge = new RemoteBridge({
    host,
    now: () => state.now,
    approvalTimeoutMs: 50,
    makeClient: (options) => {
      const startResult: StartResult = opts.startResult ?? { ok: true, name: "topic-a", threadId: 7, runTimeoutMs: opts.runTimeoutMs ?? 0 };
      const fake: FakeClient = {
        options,
        replies: [],
        approvals: [],
        closed: 0,
        isConnected: true,
        approvalAnswer: "allow",
        startResult,
        replyOk: true,
        heartbeat: undefined,
        get connected() {
          return fake.isConnected;
        },
        get name() {
          return startResult.ok ? startResult.name : undefined;
        },
        get runTimeoutMs() {
          return startResult.ok ? startResult.runTimeoutMs : undefined;
        },
        get lastHeartbeatAt() {
          return fake.heartbeat;
        },
        start: async () => {
          calls.push("start");
          return startResult;
        },
        close: async () => {
          calls.push("close");
          fake.closed += 1;
        },
        reply: async (text: string) => {
          fake.replies.push(text);
          return fake.replyOk;
        },
        requestApproval: async (prompt: string, timeoutMs: number) => {
          fake.approvals.push({ prompt, timeoutMs });
          if (fake.approvalAnswer === "throw") throw new Error("stream dropped");
          return fake.approvalAnswer;
        },
      } as FakeClient;
      client = fake;
      return fake;
    },
  });
  return { bridge, calls, state, client: () => client };
}

test("remote control is off until enable() is called; nothing is created", () => {
  const h = harness();
  expect(h.bridge.active).toBe(false);
  expect(h.bridge.status().state).toBe("off");
  expect(h.bridge.status().name).toBeUndefined();
  expect(h.calls).toEqual([]);
});

test("enable registers, records history, and reports on with the topic name", async () => {
  const h = harness();
  const result = await h.bridge.enable("my-topic");
  expect(result.ok).toBe(true);
  expect(h.client().options.name).toBe("my-topic");
  expect(h.client().options.sessionId).toBe("sess-1");
  expect(h.client().options.project).toBe("/proj");
  expect(h.calls).toContain("on:topic-a");
  expect(h.bridge.status()).toMatchObject({ state: "on", name: "topic-a" });
  expect(h.bridge.active).toBe(true);
});

test("enable twice is refused without a second client", async () => {
  const h = harness();
  await h.bridge.enable();
  const again = await h.bridge.enable();
  expect(again).toMatchObject({ ok: false, code: "already-on" });
  expect(h.calls.filter((c) => c === "start")).toHaveLength(1);
});

test("a failed start leaves remote control off, records no history and reports the error", async () => {
  const h = harness({ startResult: { ok: false, code: "no-serve", message: "serve is not running", retrying: false } });
  const result = await h.bridge.enable();
  expect(result.ok).toBe(false);
  expect(h.bridge.active).toBe(false);
  expect(h.bridge.status().state).toBe("off");
  expect(h.calls.some((c) => c.startsWith("on:"))).toBe(false);
  expect(h.calls).toContain("close");
  expect(h.bridge.status().events.at(-1)).toMatchObject({ kind: "error" });
});

test("disable records history first, then deregisters; a second disable is a no-op", async () => {
  const h = harness();
  await h.bridge.enable();
  h.calls.length = 0;
  expect(await h.bridge.disable()).toBe(true);
  expect(h.calls.indexOf("off")).toBeGreaterThanOrEqual(0);
  expect(h.calls.indexOf("off")).toBeLessThan(h.calls.indexOf("close"));
  expect(h.bridge.status().state).toBe("off");
  expect(await h.bridge.disable()).toBe(false);
  expect(h.client().closed).toBe(1);
});

test("an idle shell runs a Telegram line like a typed line", async () => {
  const h = harness();
  await h.bridge.enable();
  h.client().options.onLine("  fix the build  ", META);
  expect(h.calls.filter((c) => c.startsWith("run:") || c.startsWith("queue:"))).toEqual(["run:fix the build"]);
});

test("a busy shell queues the line through the host queue, not a queue of its own", async () => {
  const h = harness({ busy: true });
  await h.bridge.enable();
  h.client().options.onLine("later please", META);
  expect(h.calls.filter((c) => c.startsWith("run:") || c.startsWith("queue:"))).toEqual(["queue:later please"]);
});

test("empty lines are dropped", async () => {
  const h = harness();
  await h.bridge.enable();
  h.client().options.onLine("   ", META);
  expect(h.calls.some((c) => c.startsWith("run:") || c.startsWith("queue:"))).toBe(false);
});

test("slash commands from Telegram are refused with a reply and never reach the session", async () => {
  const h = harness();
  await h.bridge.enable();
  for (const line of ["/exit", "/remote-control off", "/bash rm -rf /"]) h.client().options.onLine(line, META);
  expect(h.calls.some((c) => c.startsWith("run:") || c.startsWith("queue:"))).toBe(false);
  await Promise.resolve();
  expect(h.client().replies).toHaveLength(3);
  expect(h.client().replies[0]).toContain("Slash commands are not run from Telegram");
});

test("the final text of a Telegram turn goes back, redacted; only the last text counts", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.turnStarted(TG_SOURCE);
  expect(h.bridge.telegramTurnActive).toBe(true);
  h.bridge.assistantText("working on it");
  h.bridge.assistantText(`Done. The key is ${SECRET}`);
  h.bridge.assistantText("   ");
  await h.bridge.turnSettled({ failed: false });
  expect(h.client().replies).toHaveLength(1);
  expect(h.client().replies[0]).toContain("Done.");
  expect(h.client().replies[0]).not.toContain(SECRET);
  expect(h.client().replies[0]).not.toContain("working on it");
  expect(h.bridge.telegramTurnActive).toBe(false);
});

test("a typed turn sends nothing to Telegram", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.turnStarted(undefined);
  h.bridge.assistantText("typed answer");
  await h.bridge.turnSettled({ failed: false });
  expect(h.client().replies).toEqual([]);
});

test("a long reply is cut with a note; a failed turn without text says so; an empty one says done", async () => {
  expect(composeReply("x".repeat(REMOTE_REPLY_MAX_CHARS + 500)).length).toBeLessThan(REMOTE_REPLY_MAX_CHARS + 80);
  expect(composeReply("x".repeat(REMOTE_REPLY_MAX_CHARS + 500))).toContain("[cut:");
  expect(composeReply("short")).toBe("short");

  const h = harness();
  await h.bridge.enable();
  h.bridge.turnStarted(TG_SOURCE);
  await h.bridge.turnSettled({ failed: true });
  h.bridge.turnStarted(TG_SOURCE);
  await h.bridge.turnSettled({ failed: false });
  expect(h.client().replies[0]).toContain("failed");
  expect(h.client().replies[1]).toContain("no text");
});

test("a reply that cannot be sent is logged as an error, not thrown", async () => {
  const h = harness();
  await h.bridge.enable();
  h.client().replyOk = false;
  h.bridge.turnStarted(TG_SOURCE);
  h.bridge.assistantText("hello");
  await h.bridge.turnSettled({ failed: false });
  expect(h.bridge.status().events.at(-1)).toMatchObject({ kind: "error" });
});

test("the run time limit cancels the turn and the reply says so", async () => {
  const h = harness({ runTimeoutMs: 20 });
  await h.bridge.enable();
  h.bridge.turnStarted(TG_SOURCE);
  await new Promise((r) => setTimeout(r, 60));
  expect(h.calls).toContain("cancel");
  h.bridge.assistantText("partial");
  await h.bridge.turnSettled({ failed: true });
  expect(h.client().replies[0]).toContain("time limit");
});

test("a turn that settles before the limit never cancels", async () => {
  const h = harness({ runTimeoutMs: 40 });
  await h.bridge.enable();
  h.bridge.turnStarted(TG_SOURCE);
  h.bridge.assistantText("fast");
  await h.bridge.turnSettled({ failed: false });
  await new Promise((r) => setTimeout(r, 80));
  expect(h.calls).not.toContain("cancel");
});

test("approvals: an explicit allow is allow; deny, a throw, and a drop are all deny", async () => {
  const h = harness();
  await h.bridge.enable();
  expect(await h.bridge.requestApproval("Approve bash?")).toBe("allow");
  expect(h.client().approvals[0]?.timeoutMs).toBe(50);
  h.client().approvalAnswer = "deny";
  expect(await h.bridge.requestApproval("Approve bash?")).toBe("deny");
  h.client().approvalAnswer = "throw";
  expect(await h.bridge.requestApproval("Approve bash?")).toBe("deny");
});

test("approvals fail closed with no client or while the stream is down", async () => {
  const h = harness();
  expect(await h.bridge.requestApproval("Approve bash?")).toBe("deny");
  await h.bridge.enable();
  h.client().isConnected = false;
  expect(await h.bridge.requestApproval("Approve bash?")).toBe("deny");
  expect(h.client().approvals).toEqual([]);
});

test("the approval prompt is redacted and within the server limit", () => {
  expect(composeApprovalPrompt(`run with ${SECRET}`)).not.toContain(SECRET);
  expect(composeApprovalPrompt("y".repeat(10_000)).length).toBeLessThanOrEqual(3_000);
});

test("describeApprovalForTopic shows the command a human would read and the risk flags", () => {
  const text = describeApprovalForTopic("bash", JSON.stringify({ command: "rm -rf build" }), { destructive: true, untrustedOrigin: true });
  expect(text).toContain("Approve bash?");
  expect(text).toContain("rm -rf build");
  expect(text).toContain("delete or overwrite");
  expect(text).toContain("fetched from outside");
  expect(text).not.toContain("{");

  expect(describeApprovalForTopic("edit", "not json")).toContain("not json");
  expect(describeApprovalForTopic("x", "{}", { card: ["Card line 1", "Card line 2"] })).toBe("Card line 1\nCard line 2");
  expect(describeApprovalForTopic("bash", JSON.stringify({ command: "z".repeat(5000) })).length).toBeLessThan(1_700);
  expect(describeApprovalForTopic("bash", "{}", { credentials: true })).toContain("credential");
});

test("status carries the heartbeat age and goes offline when the stream drops", async () => {
  const h = harness();
  await h.bridge.enable();
  expect(h.bridge.status().heartbeatAgeMs).toBeUndefined();
  h.client().heartbeat = h.state.now - 12_000;
  expect(h.bridge.status().heartbeatAgeMs).toBe(12_000);
  h.client().options.onStatus?.({ state: "disconnected" });
  expect(h.bridge.status().state).toBe("offline");
  h.client().options.onStatus?.({ state: "connected" });
  expect(h.bridge.status().state).toBe("on");
});

test("the events ring keeps only the newest REMOTE_EVENT_LIMIT, oldest first", async () => {
  const h = harness();
  await h.bridge.enable();
  for (let i = 0; i < REMOTE_EVENT_LIMIT + 10; i += 1) h.client().options.onLine(`line ${i}`, META);
  const events = h.bridge.status().events;
  expect(events).toHaveLength(REMOTE_EVENT_LIMIT);
  expect(events.at(-1)?.text).toContain(`line ${REMOTE_EVENT_LIMIT + 9}`);
  expect(events[0]?.text).not.toContain("line 0");
});

test("events never carry a secret from a line", async () => {
  const h = harness();
  await h.bridge.enable();
  h.client().options.onLine(`use ${SECRET}`, META);
  expect(JSON.stringify(h.bridge.status().events)).not.toContain(SECRET);
});

test("disable during a Telegram turn drops the pending reply", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.turnStarted(TG_SOURCE);
  h.bridge.assistantText("half");
  await h.bridge.disable();
  await h.bridge.turnSettled({ failed: false });
  expect(h.client().replies).toEqual([]);
  expect(h.bridge.telegramTurnActive).toBe(false);
});
