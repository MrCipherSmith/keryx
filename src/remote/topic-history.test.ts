// Flow 399: the topic gets the session's last messages back. The pure selection and formatting,
// the bridge's restore and `/history`, the router's answer, the client's `reused` flag, and the
// outbound queue under a rate limit. No network except the in-process serve rig.

import { afterEach, describe, expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { AGENT_SLASH_COMMANDS } from "../commands/agent-commands";
import { HELP_GROUPS } from "../standard/help-groups";
import type { InboundMeta, RemoteClientOptions, StartResult } from "./client";
import { REMOTE_COMMANDS } from "./command-gateway";
import {
  HISTORY_DEFAULT_COUNT,
  HISTORY_EMPTY_MESSAGE,
  HISTORY_ITEM_MAX_CHARS,
  HISTORY_MAX_COUNT,
  HISTORY_USAGE,
  formatHistoryItem,
  parseHistoryArgs,
  qualifyingHistory,
  selectHistory,
} from "./history";
import { RemoteBridge, type RemoteBridgeHost, type RemoteClientLike } from "./shell-bridge";
import { makeHarness, until } from "./remote.test-helpers";
import { makeRig, type Rig } from "./remote.http.test-helpers";

const META: InboundMeta = { updateId: 1, threadId: 7, fromId: 9, receivedAt: 0 };
// Shaped like a provider key; the redactor must not let it through.
const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp";

const user = (content: string): NormalizedMessage => ({ role: "user", content, provenance: "trusted" });
const agent = (content: string): NormalizedMessage => ({ role: "assistant", content });
const agentCalling = (content: string): NormalizedMessage =>
  ({ role: "assistant", content, toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] }) as unknown as NormalizedMessage;
const tool = (content: string): NormalizedMessage => ({ role: "tool", content, provenance: "tool", toolCallId: "c1" });

/** `turns` operator turns, each answered; message n of the conversation is "q<n>" then "a<n>". */
function conversation(turns: number): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let n = 1; n <= turns; n += 1) {
    out.push(user(`q${n}`), agentCalling(`let me look at ${n}`), tool(`output ${n}`), agent(`a${n}`));
  }
  return out;
}

describe("parseHistoryArgs", () => {
  test("no number means the default; one whole number from 1 to 20 is taken", () => {
    expect(parseHistoryArgs("")).toEqual({ ok: true, count: HISTORY_DEFAULT_COUNT });
    expect(parseHistoryArgs("   ")).toEqual({ ok: true, count: 10 });
    expect(parseHistoryArgs("1")).toEqual({ ok: true, count: 1 });
    expect(parseHistoryArgs(" 7 ")).toEqual({ ok: true, count: 7 });
    expect(parseHistoryArgs(String(HISTORY_MAX_COUNT))).toEqual({ ok: true, count: HISTORY_MAX_COUNT });
  });

  test("zero, too many, words, signs, decimals and two numbers are the usage line", () => {
    for (const bad of ["0", "21", "100", "abc", "-3", "+3", "2.5", "1 2", "5 items", "0x5", "1e1"]) {
      expect(parseHistoryArgs(bad)).toEqual({ ok: false, message: HISTORY_USAGE });
    }
  });
});

describe("which messages qualify", () => {
  test("operator turns and the final text of each turn; no tool calls, output or narration", () => {
    const items = qualifyingHistory(conversation(3));
    expect(items).toEqual([
      { role: "user", text: "q1" },
      { role: "agent", text: "a1" },
      { role: "user", text: "q2" },
      { role: "agent", text: "a2" },
      { role: "user", text: "q3" },
      { role: "agent", text: "a3" },
    ]);
    expect(JSON.stringify(items)).not.toContain("let me look");
    expect(JSON.stringify(items)).not.toContain("output");
  });

  test("the last 10 of a long session are items 16 to 25 of the 25, oldest first", () => {
    // 13 turns make 26 qualifying messages; take 25 by dropping the last agent answer.
    const history = conversation(13).slice(0, -1);
    expect(qualifyingHistory(history)).toHaveLength(25);
    const items = selectHistory(history, 10);
    expect(items).toHaveLength(10);
    const all = qualifyingHistory(history);
    expect(items).toEqual(all.slice(15, 25));
  });

  test("injected user blocks, harness nudges and compaction summaries are not operator messages", () => {
    const history: NormalizedMessage[] = [
      { role: "user", content: "[Compacted earlier context: ...]", provenance: "project" },
      { role: "user", content: "Anchors:\n- a", provenance: "project", injected: true },
      { role: "user", content: "nudge", provenance: "harness" },
      user("real question"),
      agent("real answer"),
    ];
    expect(qualifyingHistory(history)).toEqual([
      { role: "user", text: "real question" },
      { role: "agent", text: "real answer" },
    ]);
  });

  test("a turn that ended on tool calls yields no agent item; a closing text replaces earlier text", () => {
    const history = [user("q1"), agent("first draft"), agentCalling("narration"), tool("x"), user("q2"), agent("one"), agent("two")];
    expect(qualifyingHistory(history)).toEqual([
      { role: "user", text: "q1" },
      { role: "user", text: "q2" },
      { role: "agent", text: "two" },
    ]);
  });

  test("an empty or short history gives what there is; a count above it gives all of it", () => {
    expect(qualifyingHistory([])).toEqual([]);
    expect(selectHistory([user("only"), agent("one")], 10)).toHaveLength(2);
    expect(selectHistory(conversation(2), 1)).toEqual([{ role: "agent", text: "a2" }]);
  });
});

describe("formatHistoryItem", () => {
  test("a role label, then the text; no time", () => {
    expect(formatHistoryItem({ role: "user", text: "hello" })).toBe("You:\nhello");
    expect(formatHistoryItem({ role: "agent", text: "  hi there \n" })).toBe("Agent:\nhi there");
  });

  test("a secret is redacted before anything is cut", () => {
    const text = formatHistoryItem({ role: "user", text: `my key is ${SECRET} please keep it` });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    // A secret that straddles the cut point is gone too, not half-shown.
    const straddling = formatHistoryItem({ role: "agent", text: `${"x".repeat(HISTORY_ITEM_MAX_CHARS - 20)} ${SECRET} ${"y".repeat(100)}` });
    expect(straddling).not.toContain("sk-ant-api03-AbCd");
  });

  test("a long turn is cut at the limit with a marker", () => {
    const text = formatHistoryItem({ role: "agent", text: "z".repeat(40_000) });
    const body = text.slice("Agent:\n".length);
    expect(body.length).toBe(HISTORY_ITEM_MAX_CHARS + 1);
    expect(body.endsWith("…")).toBe(true);
  });

  test("a cut never splits a surrogate pair", () => {
    const text = formatHistoryItem({ role: "agent", text: `${"a".repeat(HISTORY_ITEM_MAX_CHARS - 1)}😀${"b".repeat(50)}` });
    const body = text.slice("Agent:\n".length);
    expect(body.endsWith("…")).toBe(true);
    const beforeMarker = body.charCodeAt(body.length - 2);
    expect(beforeMarker >= 0xd800 && beforeMarker <= 0xdbff).toBe(false);
  });
});

// ---- the bridge ------------------------------------------------------------------------

interface HistoryClient extends RemoteClientLike {
  options: RemoteClientOptions;
  replies: string[];
  replyOk: boolean;
  /** Called with the text of each reply; may return false to refuse it. */
  onReply?: (text: string, index: number) => boolean | Promise<boolean>;
}

function bridgeHarness(
  opts: {
    reused?: boolean;
    resumed?: boolean;
    history?: NormalizedMessage[] | undefined;
    noHistoryHook?: boolean;
    onReply?: HistoryClient["onReply"];
    paceMs?: number;
  } = {},
) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const state = { history: opts.history ?? conversation(8), now: 1_000_000 };
  const host: RemoteBridgeHost = {
    sessionId: () => "sess-1",
    project: () => "/proj",
    isBusy: () => false,
    runLine: (t) => calls.push(`run:${t}`),
    enqueue: (t) => calls.push(`queue:${t}`),
    notice: (t) => calls.push(`notice:${t}`),
    cancelTurn: () => calls.push("cancel"),
    recordOn: (n) => calls.push(`on:${n}`),
    recordOff: () => calls.push("off"),
    ...(opts.noHistoryHook ? {} : { history: () => state.history }),
    sessionResumed: () => opts.resumed ?? false,
  };
  const clients: HistoryClient[] = [];
  const bridge = new RemoteBridge({
    host,
    now: () => state.now,
    approvalTimeoutMs: 50,
    historyPaceMs: opts.paceMs ?? 2_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    makeClient: (options) => {
      const startResult: StartResult = { ok: true, name: "topic-a", threadId: 7, runTimeoutMs: 0, ...(opts.reused === undefined ? {} : { reused: opts.reused }) };
      const fake = {
        options,
        replies: [] as string[],
        replyOk: true,
        onReply: opts.onReply,
        get connected() {
          return true;
        },
        get name() {
          return "topic-a";
        },
        get runTimeoutMs() {
          return 0;
        },
        get lastHeartbeatAt() {
          return undefined;
        },
        start: async () => startResult,
        close: async () => undefined,
        reply: async (text: string) => {
          const verdict = fake.onReply === undefined ? fake.replyOk : await fake.onReply(text, fake.replies.length);
          if (verdict) fake.replies.push(text);
          return verdict;
        },
        requestApproval: async () => "deny" as const,
        requestChoice: async () => undefined,
      } as unknown as HistoryClient;
      clients.push(fake);
      return fake;
    },
  });
  return { bridge, calls, sleeps, state, clients, client: () => clients[clients.length - 1] as HistoryClient, say: (line: string) => (clients[clients.length - 1] as HistoryClient).options.onLine(line, META) };
}

/** Let the detached automatic restore run to its end. */
async function settle(h: ReturnType<typeof bridgeHarness>, expected: number): Promise<void> {
  await until(() => h.client().replies.length >= expected && h.bridge.status().history !== undefined, "the history to be posted");
}

describe("automatic restore", () => {
  test("a resumed session whose topic was just created gets the last 10 messages, in order, each its own message", async () => {
    const h = bridgeHarness({ reused: false, resumed: true });
    await h.bridge.enable("my-topic");
    await settle(h, 10);
    const replies = h.client().replies;
    expect(replies).toHaveLength(10);
    const expected = qualifyingHistory(conversation(8)).slice(-10).map(formatHistoryItem);
    expect(replies).toEqual(expected);
    // Role labels, and the operator's and the agent's messages alternate.
    expect(replies.map((text) => text.split(":")[0])).toEqual(["You", "Agent", "You", "Agent", "You", "Agent", "You", "Agent", "You", "Agent"]);
    expect(replies.join("\n")).not.toContain("let me look");
    expect(h.bridge.status().history).toMatchObject({ count: 10, auto: true });
    expect(h.calls.some((c) => c.startsWith("notice:history restored"))).toBe(true);
  });

  test("the messages are spaced by the pace, never before the first one", async () => {
    const h = bridgeHarness({ reused: false, resumed: true, paceMs: 1_500 });
    await h.bridge.enable();
    await settle(h, 10);
    expect(h.sleeps).toEqual(Array.from({ length: 9 }, () => 1_500));
  });

  test("a topic that already existed (reused) is not refilled", async () => {
    const h = bridgeHarness({ reused: true, resumed: true });
    await h.bridge.enable();
    await h.bridge.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.client().replies).toEqual([]);
    expect(h.bridge.status().history).toBeUndefined();
  });

  test("a session that was not resumed is not refilled, even in a fresh topic", async () => {
    const h = bridgeHarness({ reused: false, resumed: false });
    await h.bridge.enable();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.client().replies).toEqual([]);
  });

  test("a client that does not say whether the topic is new does not trigger a restore", async () => {
    const h = bridgeHarness({ resumed: true });
    await h.bridge.enable();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.client().replies).toEqual([]);
  });

  test("a resumed session with nothing to say posts nothing and does not fail the enable", async () => {
    const h = bridgeHarness({ reused: false, resumed: true, history: [] });
    const result = await h.bridge.enable();
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.client().replies).toEqual([]);
    expect(h.bridge.status().state).toBe("on");
  });

  test("turning it off and on again with a kept topic (reused) does not repost", async () => {
    const h = bridgeHarness({ reused: false, resumed: true });
    await h.bridge.enable();
    await settle(h, 10);
    await h.bridge.disable();
    expect(h.bridge.status().history).toBeUndefined();
    const second = bridgeHarness({ reused: true, resumed: true, history: h.state.history });
    await second.bridge.enable();
    await new Promise((r) => setTimeout(r, 20));
    expect(second.client().replies).toEqual([]);
  });

  test("a failed send stops the restore there; nothing is sent twice and enable stays on", async () => {
    const h = bridgeHarness({ reused: false, resumed: true, onReply: (_text, index) => index < 3 });
    await h.bridge.enable();
    await until(() => h.bridge.status().events.some((e) => e.kind === "error" && e.text.includes("history stopped")), "the stop to be noted");
    expect(h.client().replies).toHaveLength(3);
    expect(new Set(h.client().replies).size).toBe(3);
    expect(h.bridge.status().state).toBe("on");
  });
});

describe("/history from the shell", () => {
  test("posts the last N, repeats on purpose when asked again, and says so in the transcript", async () => {
    const h = bridgeHarness({ reused: true, resumed: false });
    await h.bridge.enable();
    expect(await h.bridge.historyForCommand("3")).toBeUndefined();
    expect(h.client().replies).toHaveLength(3);
    expect(h.client().replies).toEqual(qualifyingHistory(conversation(8)).slice(-3).map(formatHistoryItem));
    expect(h.bridge.status().history).toMatchObject({ count: 3, auto: false });
    expect(await h.bridge.historyForCommand("")).toBeUndefined();
    expect(h.client().replies).toHaveLength(13);
    expect(h.calls.filter((c) => c.startsWith("notice:history posted"))).toHaveLength(2);
  });

  test("a bad number is the usage line and posts nothing", async () => {
    const h = bridgeHarness({ reused: true });
    await h.bridge.enable();
    expect(await h.bridge.historyForCommand("0")).toBe(HISTORY_USAGE);
    expect(await h.bridge.historyForCommand("21")).toBe(HISTORY_USAGE);
    expect(h.client().replies).toEqual([]);
  });

  test("an empty session answers with the empty line", async () => {
    const h = bridgeHarness({ reused: true, history: [] });
    await h.bridge.enable();
    expect(await h.bridge.historyForCommand("")).toBe(HISTORY_EMPTY_MESSAGE);
  });

  test("with remote control off there is no topic: the answer says how to turn it on", async () => {
    const h = bridgeHarness();
    expect(await h.bridge.postHistory(5)).toMatchObject({ ok: false, reason: "off" });
    expect(await h.bridge.historyForCommand("5")).toContain("/remote-control");
  });

  test("a shell without a history hook says it cannot", async () => {
    const h = bridgeHarness({ reused: true, noHistoryHook: true });
    await h.bridge.enable();
    expect(await h.bridge.postHistory(5)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  test("a second call while the first is still posting is refused, not interleaved", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = bridgeHarness({
      reused: true,
      onReply: async (_text, index) => {
        if (index === 0) await gate;
        return true;
      },
    });
    await h.bridge.enable();
    const first = h.bridge.postHistory(4);
    const second = await h.bridge.postHistory(4);
    expect(second).toMatchObject({ ok: false, reason: "running" });
    release();
    expect(await first).toEqual({ ok: true, posted: 4 });
    expect(h.client().replies).toHaveLength(4);
  });

  test("the run stops when the topic is turned off in the middle", async () => {
    const h = bridgeHarness({ reused: true });
    await h.bridge.enable();
    h.client().onReply = async (_text, index) => {
      if (index === 1) await h.bridge.disable();
      return true;
    };
    const outcome = await h.bridge.postHistory(6);
    expect(outcome.ok).toBe(false);
    expect(h.client().replies.length).toBeLessThan(6);
  });

  test("a secret in the session never reaches the topic", async () => {
    const h = bridgeHarness({ reused: true, history: [user(`use ${SECRET} for the call`), agent(`I used ${SECRET}`)] });
    await h.bridge.enable();
    await h.bridge.postHistory(2);
    expect(h.client().replies.join("\n")).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
  });
});

describe("/history from the topic", () => {
  test("`/history 4` posts four messages and answers nothing else", async () => {
    const h = bridgeHarness({ reused: true });
    await h.bridge.enable();
    await h.say("/history 4");
    await h.bridge.idle();
    await until(() => h.client().replies.length >= 4, "four messages");
    expect(h.client().replies).toEqual(qualifyingHistory(conversation(8)).slice(-4).map(formatHistoryItem));
  });

  test("a bad argument is answered with the usage line", async () => {
    const h = bridgeHarness({ reused: true });
    await h.bridge.enable();
    await h.say("/history lots");
    await h.bridge.idle();
    await until(() => h.client().replies.length >= 1, "the usage line");
    expect(h.client().replies).toEqual([HISTORY_USAGE]);
  });

  test("an empty session is answered with the empty line", async () => {
    const h = bridgeHarness({ reused: true, history: [] });
    await h.bridge.enable();
    await h.say("/history");
    await h.bridge.idle();
    await until(() => h.client().replies.length >= 1, "the empty line");
    expect(h.client().replies).toEqual([HISTORY_EMPTY_MESSAGE]);
  });
});

describe("where /history is listed", () => {
  test("the topic's command list, the agent's slash commands and the help groups all carry it", () => {
    expect(REMOTE_COMMANDS.some((c) => c.name === "history" && c.kind === "builtin")).toBe(true);
    expect(AGENT_SLASH_COMMANDS.some((c) => c.name === "/history" || c.name === "history")).toBe(true);
    const grouped = JSON.stringify(HELP_GROUPS);
    expect(grouped).toContain("/history");
  });
});

// ---- the client and the queue ---------------------------------------------------------

describe("the client reports whether the topic was new", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("a fresh topic is reused:false; the same session registering again is reused:true", async () => {
    rig = makeRig();
    await rig.startServe();
    const first = rig.makeClient({ sessionId: "sess-th-0001", project: "/work/app", name: "release", onLine: () => undefined });
    const a = await first.start();
    expect(a).toMatchObject({ ok: true, reused: false });
    const second = rig.makeClient({ sessionId: "sess-th-0001", project: "/work/app", name: "release", onLine: () => undefined });
    const b = await second.start();
    expect(b).toMatchObject({ ok: true });
    expect(b.ok && b.reused).toBe(true);
  });
});

describe("history through the outbound queue under a rate limit", () => {
  test("ten messages arrive in order, none twice, when Telegram answers 429 part-way", async () => {
    const h = makeHarness();
    try {
      const hub = h.makeHub();
      const reg = await hub.register({ sessionId: "sess-th-0003", project: "/w/app", name: "release" });
      if (!reg.ok) throw new Error("register failed");
      await hub.start();
      const items = qualifyingHistory(conversation(8)).slice(-10).map(formatHistoryItem);
      h.api.rateLimitNext("sendMessage", 2);
      for (const text of items) await hub.send("sess-th-0003", text);
      await h.clock.advance(2_000);
      await until(() => hub.outboundPending() === 0, "the queue to drain");
      const sent = h.api.sentTo(reg.threadId).map((m) => m.text);
      const ours = sent.filter((text) => text.startsWith("You:") || text.startsWith("Agent:"));
      expect(ours).toEqual(items);
    } finally {
      await h.cleanup();
    }
  });
});
