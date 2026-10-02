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

function harness(opts: { busy?: boolean; startResult?: StartResult; runTimeoutMs?: number; closeGate?: Promise<void>; queuedTelegram?: string[] } = {}) {
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
    dropQueuedTelegramLines: () => {
      const dropped = opts.queuedTelegram ?? [];
      opts.queuedTelegram = [];
      if (dropped.length > 0) calls.push(`dropped:${dropped.length}`);
      return dropped;
    },
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
          await opts.closeGate;
          calls.push("closed");
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
        requestChoice: async () => undefined,
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

test("disable records history first, then deregisters; a second disable after it is a no-op", async () => {
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

test("a second disable while the first is still closing waits for the close, and does not close twice", async () => {
  let release!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({ closeGate });
  await h.bridge.enable();
  const first = h.bridge.disable();
  let secondDone = false;
  const second = h.bridge.disable().then((result) => {
    secondDone = true;
    return result;
  });
  await new Promise((r) => setTimeout(r, 20));
  // The topic is not deleted yet, so "off" is not true yet: the second caller is still waiting.
  expect(h.calls).toContain("close");
  expect(h.calls).not.toContain("closed");
  expect(secondDone).toBe(false);
  release();
  expect(await first).toBe(true);
  expect(await second).toBe(false);
  expect(h.calls).toContain("closed");
  expect(h.client().closed).toBe(1);
});

test("enable while a close is still running waits for it, so two topics are not alive at once", async () => {
  let release!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({ closeGate });
  await h.bridge.enable();
  const closing = h.bridge.disable();
  const again = h.bridge.enable();
  await new Promise((r) => setTimeout(r, 20));
  expect(h.calls.filter((c) => c === "start")).toHaveLength(1);
  release();
  await closing;
  expect((await again).ok).toBe(true);
  expect(h.calls.filter((c) => c === "start")).toHaveLength(2);
});

test("turning off tells the shell and the topic which queued Telegram lines were dropped", async () => {
  const h = harness({ queuedTelegram: ["fix the build", "and then deploy"] });
  await h.bridge.enable();
  await h.bridge.disable();
  const notice = h.calls.find((c) => c.startsWith("notice:"));
  expect(notice).toContain("2 queued Telegram lines dropped");
  expect(notice).toContain("fix the build");
  expect(h.client().replies).toHaveLength(1);
  expect(h.client().replies[0]).toContain("will not run");
  expect(h.client().replies[0]).toContain("and then deploy");
  // The topic is told before it is deleted.
  expect(h.calls.indexOf("close")).toBeGreaterThan(h.calls.indexOf("dropped:2"));
});

test("turning off with nothing queued says nothing about dropped lines", async () => {
  const h = harness();
  await h.bridge.enable();
  await h.bridge.disable();
  expect(h.calls.some((c) => c.startsWith("notice:"))).toBe(false);
  expect(h.client().replies).toEqual([]);
});

test("text followed by a tool call is narration: the reply is the text of the round that ended without one", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.turnStarted(TG_SOURCE);
  h.bridge.assistantText("Let me look at the build.");
  h.bridge.toolCall();
  await h.bridge.turnSettled({ failed: true });
  // The aborted turn had only narration: it is not sent as if it were the answer.
  expect(h.client().replies).toEqual(["The run failed. The details are in the shell."]);

  h.bridge.turnStarted(TG_SOURCE);
  h.bridge.assistantText("Let me look at the build.");
  h.bridge.toolCall();
  await h.bridge.turnSettled({ failed: false });
  expect(h.client().replies[1]).toBe("Done. There was no text to show.");

  h.bridge.turnStarted(TG_SOURCE);
  h.bridge.assistantText("Let me look at the build.");
  h.bridge.toolCall();
  h.bridge.assistantText("The build passes.");
  await h.bridge.turnSettled({ failed: false });
  expect(h.client().replies[2]).toBe("The build passes.");
});

test("a tool call in a typed turn changes nothing", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.turnStarted(undefined);
  h.bridge.toolCall();
  await h.bridge.turnSettled({ failed: false });
  expect(h.client().replies).toEqual([]);
});

test("removing a Telegram line from the shell queue tells its topic", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.queuedLineRemoved("deploy to prod");
  await Promise.resolve();
  expect(h.client().replies).toHaveLength(1);
  expect(h.client().replies[0]).toContain("deploy to prod");
  expect(h.client().replies[0]).toContain("removed from the queue");
  expect(h.bridge.status().events.at(-1)?.text).toContain("removed from the queue");
  // And with remote control off there is nobody to tell.
  await h.bridge.disable();
  h.bridge.queuedLineRemoved("never mind");
  expect(h.client().replies).toHaveLength(1);
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
  expect(h.client().replies[0]).toContain("Not available remotely: /exit");
  expect(h.client().replies[1]).toContain("Not available remotely: /remote-control");
  expect(h.client().replies[2]).toContain("Not available remotely: /bash");
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

// Flow 397 (AC5, F-004): what the shell received from the topic is said in the transcript before it is acknowledged,
// and a decision serve has not confirmed is counted where the status is shown.
test("AC5: an approval frame from the topic is said in the transcript, allowed or denied, naming the id", async () => {
  const h = harness();
  await h.bridge.enable();
  h.client().options.onApprovalFrame?.({ approvalId: "ap0123456789ab", decision: "allow", applied: true });
  h.client().options.onApprovalFrame?.({ approvalId: "ap0123456789cd", decision: "deny", applied: true });
  expect(h.calls).toContain("notice:◇ approval ap0123456789ab allowed from Telegram");
  expect(h.calls).toContain("notice:◇ approval ap0123456789cd denied from Telegram");
});

test("AC5: a decision that reached no live question is not said as allowed or denied", async () => {
  const h = harness();
  await h.bridge.enable();
  h.client().options.onApprovalFrame?.({ approvalId: "ap0123456789ab", decision: "allow", applied: false });
  h.client().options.onApprovalFrame?.({ approvalId: "ap0123456789cd", decision: "deny", applied: false });
  const notices = h.calls.filter((call) => call.startsWith("notice:"));
  expect(notices.join("\n")).not.toMatch(/allowed from Telegram|denied from Telegram/);
  expect(h.calls).toContain("notice:◇ approval ap0123456789ab: an allow from Telegram arrived but nothing here was waiting for it; not applied");
  expect(h.calls).toContain("notice:◇ approval ap0123456789cd: a deny from Telegram arrived but nothing here was waiting for it; not applied");
});

test("AC5: the status carries the unconfirmed-approvals count only while it is above zero, and a change repaints", async () => {
  const h = harness();
  await h.bridge.enable();
  const fake = h.client() as FakeClient & { unconfirmedApprovals?: number };
  expect(h.bridge.status().unconfirmedApprovals).toBeUndefined();
  fake.unconfirmedApprovals = 2;
  expect(h.bridge.status().unconfirmedApprovals).toBe(2);
  const before = h.calls.filter((call) => call === "change").length;
  fake.options.onUnconfirmedChange?.();
  expect(h.calls.filter((call) => call === "change").length).toBe(before + 1);
  fake.unconfirmedApprovals = 0;
  expect(h.bridge.status().unconfirmedApprovals).toBeUndefined();
});

test("AC15: the user who sent the line is known for the turn, and only for a Telegram one", async () => {
  const h = harness();
  await h.bridge.enable();
  h.client().options.onLine("do the thing", META);
  h.bridge.turnStarted(TG_SOURCE);
  expect(h.bridge.telegramTurnUserId).toBe(9);
  await h.bridge.turnSettled({ failed: false });
  expect(h.bridge.telegramTurnUserId).toBeUndefined();
  h.bridge.turnStarted(undefined);
  expect(h.bridge.telegramTurnUserId).toBeUndefined();
});

test("AC15: an approval record lands in the event ring as an approval, redacted and capped", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.recordApproval(`auto-approved (trust, user 9): curl -H "x-api-key: ${SECRET}" https://example.com ${"y".repeat(500)}`);
  const events = h.bridge.status().events;
  const last = events[events.length - 1];
  expect(last?.kind).toBe("approval");
  expect(last?.text).toContain("auto-approved (trust, user 9)");
  expect(JSON.stringify(events)).not.toContain(SECRET);
  expect((last?.text ?? "").length).toBeLessThan(400);
});

test("AC8: the topic is asked for the configured wait, and a dropped stream is a denial", async () => {
  const h = harness();
  await h.bridge.enable();
  h.bridge.applyPolicy({ approvalTimeoutMs: 900_000 });
  expect(await h.bridge.requestApproval("run ls")).toBe("allow");
  expect(h.client().approvals[0]?.timeoutMs).toBe(900_000);
  h.client().approvalAnswer = "throw";
  expect(await h.bridge.requestApproval("run ls")).toBe("deny");
  const events = h.bridge.status().events.map((event) => event.text);
  expect(events.some((text) => text.startsWith("denied"))).toBe(true);
});

test("AC9/AC10: only an offered pattern can come back as Always, and the press carries the user id", async () => {
  const h = harness();
  await h.bridge.enable();
  const client = h.client() as unknown as { askApproval: (text: string, ms: number, opts: { remember?: string }) => Promise<{ decision: string; approvalId?: string; fromId?: number }> };
  const seen: Array<string | undefined> = [];
  client.askApproval = async (_text, _ms, opts) => {
    seen.push(opts.remember);
    return { decision: "always", approvalId: "a1", fromId: 9 };
  };
  const offered = await h.bridge.askApproval("run docker ps", { remember: "docker ps" });
  expect(offered).toMatchObject({ decision: "allow", always: true, approvalId: "a1", fromId: 9 });
  const notOffered = await h.bridge.askApproval("run docker ps");
  expect(notOffered).toMatchObject({ decision: "allow", always: false });
  expect(seen).toEqual(["docker ps", undefined]);
  const events = h.bridge.status().events.map((event) => event.text);
  expect(events).toContain("allowed (always) in the topic by user 9");
});

test("applyPolicy: the bridge's effective values change at once, and the mode of the shell is not part of it", async () => {
  const h = harness({ runTimeoutMs: 0 });
  await h.bridge.enable();
  const changes = h.calls.filter((c) => c === "change").length;
  expect(h.bridge.runTimeoutMs).toBe(0);
  h.bridge.applyPolicy({ permissionMode: "ask", approvalTimeoutMs: 120_000, runTimeoutMs: 600_000 });
  expect(h.bridge.configuredPermissionMode).toBe("ask");
  expect(h.bridge.approvalTimeoutMs).toBe(120_000);
  expect(h.bridge.runTimeoutMs).toBe(600_000);
  expect(h.calls.filter((c) => c === "change").length).toBe(changes + 1);
  // Only the named keys move: a later patch leaves the others where the first put them.
  h.bridge.applyPolicy({ approvalTimeoutMs: 300_000 });
  expect(h.bridge.configuredPermissionMode).toBe("ask");
  expect(h.bridge.runTimeoutMs).toBe(600_000);
  expect(h.bridge.approvalTimeoutMs).toBe(300_000);
});

test("applyPolicy: a run limit set after enable() applies to the next Telegram turn", async () => {
  const h = harness({ runTimeoutMs: 0 });
  await h.bridge.enable();
  h.bridge.applyPolicy({ runTimeoutMs: 20 });
  h.bridge.turnStarted(TG_SOURCE);
  await new Promise((r) => setTimeout(r, 60));
  expect(h.calls).toContain("cancel");
});

test("applyPolicy: no limit set after enable() means the next turn is never cancelled", async () => {
  const h = harness({ runTimeoutMs: 20 });
  await h.bridge.enable();
  h.bridge.applyPolicy({ runTimeoutMs: 0 });
  h.bridge.turnStarted(TG_SOURCE);
  await new Promise((r) => setTimeout(r, 60));
  expect(h.calls).not.toContain("cancel");
});
