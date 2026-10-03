// Flow 397 AC4: the calls the full-screen shell makes between its main queue, its session
// switches, its turn stream and the remote-control bridge, driven for real.
//
// The flow 376 review (F-010, F-014, F-015, F-016) found these call sites guarded only by tests
// that read `tui-shell.ts` as text, so a deleted call kept every test green. The calls now live in
// `remote-queue-wiring.ts` behind injected dependencies. These tests run them against a real
// `RemoteBridge` (a fake client under it) and assert what the topic and the queue end up with:
// delete a call in the wiring and the matching test goes red.

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import type { RemoteClientOptions, StartResult } from "../remote/client";
import { RemoteBridge, type RemoteBridgeHost, type RemoteClientLike, TG_SOURCE } from "../remote/shell-bridge";
import type { QueuedMainQuestion } from "./main-queue";
import { createRemoteQueueWiring, type RemoteQueueBridge } from "./remote-queue-wiring";

const META = { updateId: 1, threadId: 7, fromId: 9, receivedAt: 0 };

interface Rig {
  bridge: RemoteBridge;
  wiring: ReturnType<typeof createRemoteQueueWiring>;
  /** What the shell would run, as `source|line`. */
  runs: string[];
  /** The transcript lines the shell said. */
  said: string[];
  replies: string[];
  composer: string[];
  queue: () => QueuedMainQuestion[];
  /** A line typed in the shell, queued while busy. */
  queueLocal: (text: string) => void;
  /** A line typed in the Telegram topic. */
  telegram: (text: string) => void;
}

async function rig(): Promise<Rig> {
  let queue: QueuedMainQuestion[] = [];
  let nextId = 0;
  const runs: string[] = [];
  const said: string[] = [];
  const replies: string[] = [];
  const composer: string[] = [];
  let clientOptions!: RemoteClientOptions;

  // The wiring and the bridge need each other: the bridge's host calls the wiring.
  const ref: { bridge?: RemoteBridge } = {};
  const wiring = createRemoteQueueWiring({
    getBridge: () => ref.bridge,
    getQueue: () => queue,
    setQueue: (next) => {
      queue = next;
    },
    nextId: () => `q-${(nextId += 1)}`,
    summarize: (text) => text,
    paint: () => {},
    composer: { setText: (text) => composer.push(text), focus: () => {} },
    say: (text) => said.push(text),
    runLine: (line, _origin, source) => runs.push(`${source ?? "local"}|${line}`),
  });

  const host: RemoteBridgeHost = {
    sessionId: () => "sess-1",
    project: () => "/proj",
    // The shell is always busy here: a Telegram line goes to the queue, as it does mid-turn.
    isBusy: () => true,
    runLine: (text) => wiring.runTelegramLine(text),
    enqueue: (text) => wiring.enqueueTelegramLine(text),
    notice: () => {},
    cancelTurn: () => {},
    recordOn: () => {},
    recordOff: () => {},
    dropQueuedTelegramLines: () => wiring.dropQueuedTelegramLines(),
  };
  const bridge = new RemoteBridge({
    host,
    approvalTimeoutMs: 50,
    makeClient: (options) => {
      clientOptions = options;
      const start: StartResult = { ok: true, name: "topic-a", threadId: 7, runTimeoutMs: 0 };
      return {
        connected: true,
        name: "topic-a",
        runTimeoutMs: 0,
        lastHeartbeatAt: undefined,
        unconfirmedApprovals: 0,
        start: async () => start,
        close: async () => {},
        reply: async (text: string) => {
          replies.push(text);
          return true;
        },
        requestApproval: async () => "allow",
        requestChoice: async () => undefined,
      } as unknown as RemoteClientLike;
    },
  });
  ref.bridge = bridge;
  const enabled = await bridge.enable("topic-a");
  expect(enabled.ok).toBe(true);

  return {
    bridge,
    wiring,
    runs,
    said,
    replies,
    composer,
    queue: () => queue,
    queueLocal: (text) => {
      queue.push({ id: `q-${(nextId += 1)}`, question: text, displayQuestion: text });
    },
    telegram: (text) => clientOptions.onLine(text, META),
  };
}

// ---- F-016: a removed Telegram line is reported to its topic -------------------------

test("AC4 F-016: removing a queued Telegram line tells the topic, once", async () => {
  const r = await rig();
  r.telegram("deploy to staging");
  expect(r.queue().map((item) => item.source)).toEqual([TG_SOURCE]);

  r.wiring.removeMainQueue(0);

  expect(r.queue()).toEqual([]);
  expect(r.replies).toHaveLength(1);
  expect(r.replies[0]).toContain("deploy to staging");
  expect(r.replies[0]).toContain("removed from the queue");
});

test("AC4 F-016: removing a line typed in the shell says nothing to the topic", async () => {
  const r = await rig();
  r.queueLocal("local question");

  r.wiring.removeMainQueue(0);

  expect(r.queue()).toEqual([]);
  expect(r.replies).toEqual([]);
});

test("AC4 F-016: removing an index that is not in the queue changes nothing", async () => {
  const r = await rig();
  r.telegram("keep me");

  r.wiring.removeMainQueue(5);
  r.wiring.removeMainQueue(-1);

  expect(r.queue()).toHaveLength(1);
  expect(r.replies).toEqual([]);
});

// ---- F-010: an edited Telegram line stays a Telegram line ----------------------------

test("AC4 F-010: a Telegram line that was edited and re-queued still runs as a Telegram line", async () => {
  const r = await rig();
  r.queueLocal("first");
  r.telegram("from the phone");

  r.wiring.editMainQueue(1);
  expect(r.composer).toEqual(["from the phone"]);
  expect(r.wiring.hasPendingEdit()).toBe(true);
  expect(r.queue().map((item) => item.question)).toEqual(["first"]);

  expect(r.wiring.requeuePendingEdit("from the phone, edited", "from the phone, edited")).toBe(true);
  expect(r.wiring.hasPendingEdit()).toBe(false);
  expect(r.queue().map((item) => `${item.source ?? "local"}|${item.question}`)).toEqual([
    "local|first",
    "tg|from the phone, edited",
  ]);

  // The drain runs it with its source, so the reply goes back to the topic.
  const drained = r.queue()[1];
  expect(drained).toBeDefined();
  if (drained !== undefined) r.wiring.runQueued(drained);
  expect(r.runs).toEqual(["tg|from the phone, edited"]);
});

test("AC4 F-010: a line typed in the shell that was edited and re-queued does not become a Telegram line", async () => {
  const r = await rig();
  r.queueLocal("mine");

  r.wiring.editMainQueue(0);
  r.wiring.requeuePendingEdit("mine, edited", "mine, edited");

  const item = r.queue()[0];
  expect(item?.source).toBeUndefined();
  if (item !== undefined) r.wiring.runQueued(item);
  expect(r.runs).toEqual(["local|mine, edited"]);
});

test("AC4 F-010: with no edit waiting, a submit is not taken for a re-queue", async () => {
  const r = await rig();
  expect(r.wiring.requeuePendingEdit("new line", "new line")).toBe(false);
  expect(r.queue()).toEqual([]);
});

// ---- F-014: a session switch leaves no Telegram line behind --------------------------

test("AC4 F-014: a session switch turns remote control off and no Telegram line stays in the queue", async () => {
  const r = await rig();
  r.queueLocal("mine");
  r.telegram("from the phone");
  expect(r.queue().filter((item) => item.source === TG_SOURCE)).toHaveLength(1);

  r.wiring.stopRemoteForSessionSwitch();

  // Synchronously: the new session must not inherit a line addressed to the old topic.
  expect(r.queue().map((item) => item.question)).toEqual(["mine"]);
  expect(r.said.join("")).toContain("remote control is turning off");
  expect(r.bridge.active).toBe(false);

  // The closing line comes once the topic is really gone.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(r.said.join("")).toContain("remote control off: the topic is deleted.");
});

test("AC4 F-014: with remote control off a session switch says nothing", async () => {
  const r = await rig();
  await r.bridge.disable();
  r.said.length = 0;

  r.wiring.stopRemoteForSessionSwitch();

  expect(r.said).toEqual([]);
});

test("AC4 F-014: a switch asked for from the topic keeps the topic and closes only the history interval", () => {
  const calls: string[] = [];
  const bridge = {
    active: true,
    keepingTopic: true,
    disable: async () => {
      calls.push("disable");
      return true;
    },
    sessionLeaving: () => calls.push("sessionLeaving"),
    queuedLineRemoved: () => {},
    turnStarted: () => {},
    assistantText: () => {},
    toolCall: () => {},
    turnSettled: async () => {},
  } satisfies RemoteQueueBridge;
  const said: string[] = [];
  const wiring = createRemoteQueueWiring({
    getBridge: () => bridge,
    getQueue: () => [],
    setQueue: () => {},
    nextId: () => "q",
    summarize: (text) => text,
    paint: () => {},
    composer: { setText: () => {}, focus: () => {} },
    say: (text) => said.push(text),
    runLine: () => {},
  });

  wiring.stopRemoteForSessionSwitch();

  expect(calls).toEqual(["sessionLeaving"]);
  expect(said).toEqual([]);
});

// ---- F-015: narration before a tool call is not the answer ---------------------------

test("AC4 F-015: text said before a tool call is dropped; a settled turn with no later text says so", async () => {
  const r = await rig();
  r.wiring.turnStarted(TG_SOURCE);
  r.wiring.assistantText("Let me look at the build.");
  r.wiring.wrapOnToolCall(undefined)();
  await r.wiring.turnSettled({ failed: false, aborted: false });

  expect(r.replies).toEqual(["Done. There was no text to show."]);
});

test("AC4 F-015: text said after the last tool call is the reply", async () => {
  const r = await rig();
  r.wiring.turnStarted(TG_SOURCE);
  r.wiring.assistantText("Let me look at the build.");
  r.wiring.wrapOnToolCall(undefined)();
  r.wiring.assistantText("The build is green.");
  await r.wiring.turnSettled({ failed: false, aborted: false });

  expect(r.replies).toHaveLength(1);
  expect(r.replies[0]).toContain("The build is green.");
  expect(r.replies[0]).not.toContain("Let me look");
});

test("AC4 F-015: a failed turn says it failed and never sends the narration as the answer", async () => {
  const r = await rig();
  r.wiring.turnStarted(TG_SOURCE);
  r.wiring.assistantText("Let me look at the build.");
  r.wiring.wrapOnToolCall(undefined)();
  await r.wiring.turnSettled({ failed: true, aborted: false });

  expect(r.replies).toEqual(["The run failed. The details are in the shell."]);
});

test("AC4 F-015: a cancelled turn counts as failed", async () => {
  const r = await rig();
  r.wiring.turnStarted(TG_SOURCE);
  r.wiring.assistantText("Let me look at the build.");
  r.wiring.wrapOnToolCall(undefined)();
  await r.wiring.turnSettled({ failed: false, aborted: true });

  expect(r.replies).toEqual(["The run failed. The details are in the shell."]);
});

test("AC4 F-015: the wrapped tool-call hook still runs the original, with its arguments", async () => {
  const r = await rig();
  const seen: unknown[][] = [];
  const wrapped = r.wiring.wrapOnToolCall((...args: unknown[]) => {
    seen.push(args);
  });

  wrapped("read", { path: "a.ts" });

  expect(seen).toEqual([["read", { path: "a.ts" }]]);
});

test("AC4 F-015: a turn that did not come from Telegram sends nothing to the topic", async () => {
  const r = await rig();
  r.wiring.turnStarted(undefined);
  r.wiring.assistantText("Local answer.");
  await r.wiring.turnSettled({ failed: false, aborted: false });

  expect(r.replies).toEqual([]);
});

// ---- the queue as a whole ------------------------------------------------------------

test("AC4: remote control going off takes the Telegram lines out of the queue and returns them", async () => {
  const r = await rig();
  r.queueLocal("mine");
  r.telegram("one");
  r.telegram("two");

  const dropped = r.wiring.dropQueuedTelegramLines();

  expect(dropped).toEqual(["one", "two"]);
  expect(r.queue().map((item) => item.question)).toEqual(["mine"]);
  expect(r.wiring.dropQueuedTelegramLines()).toEqual([]);
});

test("AC4: a Telegram line while the shell is busy is queued with its label and announced", async () => {
  const r = await rig();
  r.telegram("hello");

  expect(r.queue()).toHaveLength(1);
  expect(r.queue()[0]?.source).toBe(TG_SOURCE);
  expect(r.said.join("")).toContain("a line from Telegram is queued as q1");
});

// The shell closure cannot be mounted in a test, so the delegations from `tui-shell.ts` into the wiring
// are guarded as source text: a deleted `turnSettled` / `turnStarted` / `assistantText` call leaves every
// behavioural test above green, because they drive the wiring directly. This is one reader of the god-file
// (inventoried in docs/requirements/keryx-shell-split/source-text-audit-inventory.md, flow 397). It counts
// call sites and never pins a line number, so moving code does not fail it.
const SHELL_SOURCE = new URL("./tui-shell.ts", import.meta.url);

function shellOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

test("AC4 F-010 F-014 F-015 F-016: tui-shell.ts still delegates every remote-queue call into the wiring", () => {
  const source = readFileSync(SHELL_SOURCE, "utf8");
  const expected: Array<[string, number]> = [
    ["createRemoteQueueWiring({", 1],
    ["remoteQueue.assistantText(text);", 1],
    ["remoteQueue.wrapOnToolCall(", 1],
    ["remoteQueue.stopRemoteForSessionSwitch()", 1],
    ["remoteQueue.removeMainQueue(", 1],
    ["remoteQueue.editMainQueue(", 1],
    ["remoteQueue.requeuePendingEdit(", 1],
    ["remoteQueue.runQueued(", 5],
    ["remoteQueue.turnStarted(source);", 1],
    ["void remoteQueue.turnSettled({", 1],
    ["remoteQueue.runTelegramLine(", 1],
    ["remoteQueue.enqueueTelegramLine(", 1],
    ["remoteQueue.dropQueuedTelegramLines(", 1],
  ];
  const found = expected.map(([needle]) => [needle, shellOccurrences(source, needle)] as const);
  expect(found).toEqual(expected.map(([needle, count]) => [needle, count] as const));
});
