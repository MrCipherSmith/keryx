// Flow 399: the topic gets the session's last messages back. The pure selection and formatting,
// the bridge's restore and `/history`, the router's answer, the client's `reused` flag, and the
// outbound queue under a rate limit. No network except the in-process serve rig.

import { afterEach, describe, expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { AGENT_SLASH_COMMANDS } from "../commands/agent-commands";
import { HELP_GROUPS } from "../standard/help-groups";
import type { InboundMeta, RemoteClient, RemoteClientOptions, StartResult } from "./client";
import { REMOTE_COMMANDS } from "./command-gateway";
import {
  HISTORY_DEFAULT_COUNT,
  HISTORY_EMPTY_MESSAGE,
  HISTORY_ITEM_MAX_CHARS,
  HISTORY_MAX_COUNT,
  HISTORY_SECRET_PLACEHOLDER,
  HISTORY_USAGE,
  formatHistoryItem,
  looksLikeSecret,
  parseHistoryArgs,
  qualifyingHistory,
  selectHistory,
} from "./history";
import { RemoteBridge, type RemoteBridgeHost, type RemoteClientLike } from "./shell-bridge";
import { settle as settleLoop, until } from "./remote.test-helpers";
import { makeRig, type Rig } from "./remote.http.test-helpers";

const META: InboundMeta = { updateId: 1, threadId: 7, fromId: 9, receivedAt: 0 };
// Shaped like a provider key; the redactor must not let it through.
const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp";

/** The last 10 messages of `conversation(8)`, as the topic reads them, written out so no test derives them from the code under test. */
const LAST_TEN_OF_EIGHT = [
  "You:\nq4",
  "Agent:\na4",
  "You:\nq5",
  "Agent:\na5",
  "You:\nq6",
  "Agent:\na6",
  "You:\nq7",
  "Agent:\na7",
  "You:\nq8",
  "Agent:\na8",
];

// Not real credentials: the shapes the shared redactor misses.
const BOT_TOKEN = "7412398765:AAHx9Kf3Lq0ZpR7sT2vWx4Yb6Nc8Md1QeUg";
const SHELL_TOKEN = "q3F9xK2mT7vB0LzR8wYpN4cD6eHuJ1aSgOiXbMkVtQE";

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
    // Written out: message 16 of 25 is the agent's a8, message 25 is the operator's q13.
    expect(items).toEqual([
      { role: "agent", text: "a8" },
      { role: "user", text: "q9" },
      { role: "agent", text: "a9" },
      { role: "user", text: "q10" },
      { role: "agent", text: "a10" },
      { role: "user", text: "q11" },
      { role: "agent", text: "a11" },
      { role: "user", text: "q12" },
      { role: "agent", text: "a12" },
      { role: "user", text: "q13" },
    ]);
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

  test("while a turn runs, its half-written assistant text is not a message; once it ends it is", () => {
    const streaming = agent("The answer so f");
    const history = [user("q1"), agent("a1"), user("q2"), streaming];
    expect(qualifyingHistory(history, { turnRunning: true })).toEqual([
      { role: "user", text: "q1" },
      { role: "agent", text: "a1" },
      { role: "user", text: "q2" },
    ]);
    expect(selectHistory(history, 1, { turnRunning: true })).toEqual([{ role: "user", text: "q2" }]);
    // Idle: the same history, the finished text is there.
    expect(qualifyingHistory(history).at(-1)).toEqual({ role: "agent", text: "The answer so f" });
    // The items are strings: the live message growing afterwards changes nothing already selected.
    const picked = selectHistory(history, 1);
    streaming.content += "ar as I know";
    expect(picked).toEqual([{ role: "agent", text: "The answer so f" }]);
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

  // T-1 (flow 399 review): `SECRET` above is a long mixed-case run, so `looksLikeSecret` hides the whole
  // turn and `redactSensitiveText` never runs. An AWS access key id is the other way round: the guard
  // does not flag it and only the redactor can mask it.
  test("a secret only the redactor knows is masked in place, before the cut (history.ts:134)", () => {
    const AWS = "AKIAIOSFODNN7EXAMPLE";
    expect(looksLikeSecret(AWS)).toBe(false);
    expect(formatHistoryItem({ role: "user", text: `my aws key is ${AWS} thanks` })).toBe("You:\nmy aws key is [REDACTED:secret] thanks");
    // It starts 10 characters before the cut: redacted after the cut it would stay half-shown ("AKIAIOSFO…").
    const straddling = formatHistoryItem({ role: "agent", text: `${"x".repeat(HISTORY_ITEM_MAX_CHARS - 10)} ${AWS} ${"y".repeat(100)}` });
    expect(looksLikeSecret(`${"x".repeat(HISTORY_ITEM_MAX_CHARS - 10)} ${AWS} ${"y".repeat(100)}`)).toBe(false);
    expect(straddling).not.toContain("AKIAIO");
    expect(straddling.endsWith("…")).toBe(true);
  });

  test("a Telegram bot token or a bare token in a turn hides the whole turn, either role", () => {
    for (const text of [
      `here is the bot token ${BOT_TOKEN} thanks`,
      BOT_TOKEN,
      SHELL_TOKEN,
      `use ${SHELL_TOKEN}`,
      `Authorization is ${SHELL_TOKEN}==`,
    ]) {
      for (const role of ["user", "agent"] as const) {
        const out = formatHistoryItem({ role, text });
        expect(out).toBe(`${role === "user" ? "You" : "Agent"}:\n${HISTORY_SECRET_PLACEHOLDER}`);
        expect(out).not.toContain("AAHx9K");
        expect(out).not.toContain("q3F9xK2m");
      }
    }
  });

  test("a secret after the cut point of a 40,000-character turn is still found", () => {
    const long = `${"word ".repeat(8_000)}${BOT_TOKEN}`;
    expect(long.length).toBeGreaterThan(40_000 - 100);
    expect(formatHistoryItem({ role: "user", text: long })).toBe(`You:\n${HISTORY_SECRET_PLACEHOLDER}`);
    expect(formatHistoryItem({ role: "agent", text: `${long}` })).not.toContain("word");
  });

  test("ordinary text is not mistaken for a secret", () => {
    for (const text of [
      "deploy at 12:30 tomorrow",
      "commit 858e787c8efeb5b785c6cbc29425d8b809f7cbe5 is green",
      "see /home/altsay/keryx-wH1/src/remote/topic-history.test.ts for the test",
      "SomeVeryLongCamelCaseIdentifierWithoutAnyDigitsAtAllInIt is a name",
      "call 8005550123 or 8005550124",
      "https://github.com/MrCipherSmith/keryx/pull/870",
      "На русском языке длинное слово: сверхъестественнейшаяпоследовательность",
    ]) {
      expect(looksLikeSecret(text)).toBe(false);
    }
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
    /** A turn is being written: the host says so. Omitted: the host does not say, and `isBusy` stands in. */
    turnRunning?: () => boolean;
    busy?: () => boolean;
    /** The pause between two restored messages; default returns at once. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const state = { history: opts.history ?? conversation(8), now: 1_000_000 };
  const host: RemoteBridgeHost = {
    sessionId: () => "sess-1",
    project: () => "/proj",
    isBusy: () => opts.busy?.() ?? false,
    runLine: (t) => calls.push(`run:${t}`),
    enqueue: (t) => calls.push(`queue:${t}`),
    notice: (t) => calls.push(`notice:${t}`),
    cancelTurn: () => calls.push("cancel"),
    recordOn: (n) => calls.push(`on:${n}`),
    recordOff: () => calls.push("off"),
    ...(opts.noHistoryHook ? {} : { history: () => state.history }),
    sessionResumed: () => opts.resumed ?? false,
    ...(opts.turnRunning !== undefined ? { turnRunning: opts.turnRunning } : {}),
  };
  const clients: HistoryClient[] = [];
  const bridge = new RemoteBridge({
    host,
    now: () => state.now,
    approvalTimeoutMs: 50,
    historyPaceMs: opts.paceMs ?? 2_000,
    sleep: async (ms) => {
      sleeps.push(ms);
      await opts.sleep?.(ms);
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
    expect(replies).toEqual(LAST_TEN_OF_EIGHT);
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

  test("turning it off and on again in the same process does not restore into the new topic", async () => {
    const h = bridgeHarness({ reused: false, resumed: true });
    await h.bridge.enable();
    await settle(h, 10);
    await h.bridge.disable();
    expect(h.bridge.status().history).toBeUndefined();
    // The client says "new topic" again, as the hub does after a delete; the session is still resumed.
    await h.bridge.enable();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.clients).toHaveLength(2);
    expect(h.client().replies).toEqual([]);
    expect(h.bridge.status().history).toBeUndefined();
    // `/history` is how that topic gets its messages, and it does.
    expect(await h.bridge.historyForCommand("2")).toBeUndefined();
    expect(h.client().replies).toEqual(["You:\nq8", "Agent:\na8"]);
  });

  test("a restore that does not happen says why in the transcript", async () => {
    const empty = bridgeHarness({ reused: false, resumed: true, history: [] });
    await empty.bridge.enable();
    await until(() => empty.calls.some((c) => c.startsWith("notice:history was not restored automatically")), "the reason");
    expect(empty.calls.find((c) => c.includes("not restored automatically"))).toContain(HISTORY_EMPTY_MESSAGE);

    const refused = bridgeHarness({ reused: false, resumed: true, onReply: () => false });
    await refused.bridge.enable();
    await until(() => refused.calls.some((c) => c.startsWith("notice:history was not restored automatically")), "the failure reason");
    expect(refused.calls.find((c) => c.includes("not restored automatically"))).toContain("Send /history again");
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
    expect(h.client().replies).toEqual(["Agent:\na7", "You:\nq8", "Agent:\na8"]);
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

  test("mid-turn it posts the finished messages and leaves out the half-written answer", async () => {
    const streaming = agent("half a sent");
    let running = true;
    const h = bridgeHarness({
      reused: true,
      history: [user("q1"), agent("a1"), user("q2"), streaming],
      turnRunning: () => running,
      busy: () => running,
    });
    await h.bridge.enable();
    expect(await h.bridge.historyForCommand("5")).toBeUndefined();
    expect(h.client().replies).toEqual(["You:\nq1", "Agent:\na1", "You:\nq2"]);
    expect(h.client().replies.join("\n")).not.toContain("half a sent");
    // The turn ends: the same /history now has the finished answer.
    streaming.content = "half a sentence, finished";
    running = false;
    expect(await h.bridge.historyForCommand("1")).toBeUndefined();
    expect(h.client().replies.at(-1)).toBe("Agent:\nhalf a sentence, finished");
  });

  test("without a turnRunning hook a busy shell counts as running", async () => {
    const h = bridgeHarness({ reused: true, history: [user("q1"), agent("partial")], busy: () => true });
    await h.bridge.enable();
    expect(await h.bridge.historyForCommand("2")).toBeUndefined();
    expect(h.client().replies).toEqual(["You:\nq1"]);
  });

  test("a message that grows while the posts are paced is posted as it was when selected", async () => {
    const last = agent("as selected");
    const h = bridgeHarness({
      reused: true,
      history: [user("q1"), last],
      onReply: (_text, index) => {
        if (index === 0) last.content = "changed after the first post";
        return true;
      },
    });
    await h.bridge.enable();
    await h.bridge.postHistory(2);
    expect(h.client().replies).toEqual(["You:\nq1", "Agent:\nas selected"]);
  });

  test("off and on again during the pause: the new topic's /history is not refused and the old run stops", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const h = bridgeHarness({
      reused: true,
      sleep: async () => {
        paused = true;
        await gate;
      },
    });
    await h.bridge.enable();
    const oldClient = h.client();
    const first = h.bridge.postHistory(4);
    await until(() => paused, "the pause after the first message");
    await h.bridge.disable();
    await h.bridge.enable();
    const newClient = h.client();
    expect(newClient).not.toBe(oldClient);
    // Same client would be "running"; a new client is a new topic and gets its own run.
    release();
    expect(await h.bridge.postHistory(4)).toEqual({ ok: true, posted: 4 });
    expect(newClient.replies).toEqual(["You:\nq7", "Agent:\na7", "You:\nq8", "Agent:\na8"]);
    const old = await first;
    expect(old).toMatchObject({ ok: false, reason: "failed", posted: 1 });
    expect(oldClient.replies).toEqual(["You:\nq7"]);
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

  test("a pasted bot token, a bare shell token and a token in a 40,000-character turn never reach the topic", async () => {
    const h = bridgeHarness({
      reused: true,
      history: [
        user(`the bot token is ${BOT_TOKEN}`),
        agent(`noted ${BOT_TOKEN.split(":")[1]}`),
        user(SHELL_TOKEN),
        agent("fine, I will not use it"),
        user(`${"word ".repeat(8_000)}${BOT_TOKEN}`),
        agent(`${"filler ".repeat(5_000)}${SHELL_TOKEN}`),
      ],
    });
    await h.bridge.enable();
    expect(await h.bridge.postHistory(10)).toEqual({ ok: true, posted: 6 });
    const all = h.client().replies.join("\n");
    for (const piece of ["AAHx9K", "7412398765", "q3F9xK2m", "Lq0ZpR7sT2", "word word", "filler"]) {
      expect(all).not.toContain(piece);
    }
    expect(h.client().replies).toEqual([
      `You:\n${HISTORY_SECRET_PLACEHOLDER}`,
      `Agent:\n${HISTORY_SECRET_PLACEHOLDER}`,
      `You:\n${HISTORY_SECRET_PLACEHOLDER}`,
      "Agent:\nfine, I will not use it",
      `You:\n${HISTORY_SECRET_PLACEHOLDER}`,
      `Agent:\n${HISTORY_SECRET_PLACEHOLDER}`,
    ]);
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
    expect(h.client().replies).toEqual(["You:\nq7", "Agent:\na7", "You:\nq8", "Agent:\na8"]);
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
  test("the topic's command list, the agent's slash commands and the help groups each carry its own entry", () => {
    expect(REMOTE_COMMANDS.find((c) => c.name === "history")).toMatchObject({ kind: "builtin" });
    const slash = AGENT_SLASH_COMMANDS.find((c) => c.name === "/history");
    expect(slash?.description).toContain("/history [N]");
    const help = HELP_GROUPS.find((e) => e.kind === "slash" && e.name === "/history");
    expect(help?.group).toBe("Automation");
    expect(help?.summary).toContain("[N]");
    expect(help?.summary).toContain("20");
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

// ---- the real client and serve, with the real bridge on top ------------------------------

/** A bridge over a real client talking to the rig's serve; the host is a plain recorder. */
function realBridge(rig: Rig, opts: { resumed: boolean; sessionId: string; history?: NormalizedMessage[] }) {
  const clients: RemoteClient[] = [];
  const notices: string[] = [];
  const bridge = new RemoteBridge({
    host: {
      sessionId: () => opts.sessionId,
      project: () => "/work/app",
      isBusy: () => false,
      runLine: () => undefined,
      enqueue: () => undefined,
      notice: (text) => void notices.push(text),
      cancelTurn: () => undefined,
      recordOn: () => undefined,
      recordOff: () => undefined,
      history: () => opts.history ?? conversation(8),
      sessionResumed: () => opts.resumed,
    },
    historyPaceMs: 5,
    makeClient: (options) => {
      const client = rig.makeClient(options);
      clients.push(client);
      return client;
    },
  });
  const sentTo = (threadId: number): string[] =>
    rig.api
      .sentTo(threadId)
      .map((m) => m.text)
      .filter((text) => text.startsWith("You:") || text.startsWith("Agent:"));
  return { bridge, clients, notices, sentTo, client: () => clients[clients.length - 1] as RemoteClient };
}

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

  test("AC12: the answer of the first registration survives a reconnect, and a reconnect restores nothing", async () => {
    rig = makeRig();
    const firstServe = await rig.startServe();
    const t = realBridge(rig, { resumed: true, sessionId: "sess-th-0004" });
    const started = await t.bridge.enable("release");
    if (!started.ok) throw new Error("enable failed");
    expect(started.reused).toBe(false);
    const threadId = started.threadId;
    await until(() => t.sentTo(threadId).length === 10, "the automatic restore", 8_000);
    expect(t.sentTo(threadId)).toEqual(LAST_TEN_OF_EIGHT);
    expect(t.client().reusedAtStart).toBe(false);

    // Serve goes away and comes back; the client registers again, the hub says "reused" this time.
    await firstServe.stop();
    await until(() => !t.client().connected, "the shell to notice serve is gone");
    await rig.startServe();
    await until(() => t.client().connected, "the shell to reconnect", 10_000);
    await settleLoop();
    await settleLoop();
    // The flag is the first registration's, so a second registration changes nothing...
    expect(t.client().reusedAtStart).toBe(false);
    // ...and nothing was posted again.
    await new Promise((r) => setTimeout(r, 100));
    expect(t.sentTo(threadId)).toEqual(LAST_TEN_OF_EIGHT);
  });

  test("AC12: turning remote control off and on in one process leaves the new topic empty until /history", async () => {
    rig = makeRig();
    await rig.startServe();
    const t = realBridge(rig, { resumed: true, sessionId: "sess-th-0006" });
    const first = await t.bridge.enable("release");
    if (!first.ok) throw new Error("enable failed");
    await until(() => t.sentTo(first.threadId).length === 10, "the automatic restore", 8_000);
    expect(await t.bridge.disable()).toBe(true);

    const second = await t.bridge.enable("release");
    if (!second.ok) throw new Error("second enable failed");
    expect(t.clients).toHaveLength(2);
    expect(second.reused).toBe(false); // a new topic, over a session that is still resumed
    const before = t.sentTo(second.threadId).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(t.sentTo(second.threadId).length).toBe(before);
    expect(t.bridge.status().history).toBeUndefined();

    // On request it does fill.
    expect(await t.bridge.historyForCommand("2")).toBeUndefined();
    await until(() => t.sentTo(second.threadId).length === before + 2, "the two messages", 8_000);
    expect(t.sentTo(second.threadId).slice(-2)).toEqual(["You:\nq8", "Agent:\na8"]);
  });
});

describe("history through the real outbound queue under a rate limit", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.cleanup();
  });

  test("AC10: ten messages posted by the bridge's own pacing arrive in order, none twice, when Telegram answers 429", async () => {
    rig = makeRig();
    await rig.startServe();
    const t = realBridge(rig, { resumed: false, sessionId: "sess-th-0007" });
    const started = await t.bridge.enable("release");
    if (!started.ok) throw new Error("enable failed");
    // The next send is refused for one second; the queue holds, then sends everything once, in order.
    rig.api.rateLimitNext("sendMessage", 1, 1);
    expect(await t.bridge.historyForCommand("10")).toBeUndefined();
    await until(() => t.sentTo(started.threadId).length === 10, "all ten messages", 12_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.sentTo(started.threadId)).toEqual(LAST_TEN_OF_EIGHT);
  });
});
