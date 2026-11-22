import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "../acp/types";
import {
  applyUpdates,
  findTool,
  initialState,
  newConv,
  reducer,
  sessionMarks,
  shownView,
  type Action,
  type ConvState,
  type Item,
  type QueuedUpdate,
  type RoutedUpdate,
  type WindowState,
} from "./reducer";

const u = (x: Record<string, unknown>) => x as unknown as SessionUpdate;
const chunk = (text: string, kind = "agent_message_chunk") => u({ sessionUpdate: kind, content: { type: "text", text } });
const tool = (toolCallId: string, status: string, fresh = false) =>
  u({ sessionUpdate: fresh ? "tool_call" : "tool_call_update", toolCallId, status, title: `t ${toolCallId}` });
const routed = (sessionId: string, update: SessionUpdate, at = 1): RoutedUpdate => ({ sessionId, update, at });
const run = (s: WindowState, ...actions: Action[]) => actions.reduce(reducer, s);
const textOf = (c: ConvState | undefined) => (c?.items ?? []).map((i) => ("text" in i ? i.text : i.kind)).join("|");

const conv: ConvState = newConv("s1", { replaying: false });

/** A window holding s1 (shown) and s2. */
const twoHeld = run(
  { ...initialState, phase: "ready" },
  { t: "created", sessionId: "s1", show: true },
  { t: "created", sessionId: "s2", show: false },
);

test("tracks a Telegram turn off-screen, ignores a mismatched finish, and clears it on owner loss", () => {
  const event = (phase: string, updateId: number) =>
    u({ sessionUpdate: "_keryx/telegram/turn", source: "telegram", phase, updateId, generation: "generation-a" });
  const start = run(twoHeld, { t: "updates", updates: [
    routed("s2", event("started", 7)), routed("s2", chunk("From Telegram", "user_message_chunk")),
    routed("s2", event("finished", 6)),
  ] });
  expect(sessionMarks(start, new Set()).s2?.busy).toBe(true);
  expect(shownView(start).busy).toBe(false);
  expect(textOf(start.convs.s2)).toBe("From Telegram");
  const end = run(start, { t: "updates", updates: [routed("s2", event("finished", 7))] });
  expect(sessionMarks(end, new Set()).s2?.busy).toBe(false);
  expect(sessionMarks(run(start, { t: "connectionReset" }), new Set()).s2?.busy).toBe(false);
});

test("requires the same session and a Telegram topic URL, and ignores stale status after a notification", () => {
  const update = (sessionId: string, topicUrl: string) => u({
    sessionUpdate: "_keryx/telegram/session", telegram: { sessionId, state: "active", topicUrl },
  });
  const wrongSession = run(twoHeld, { t: "updates", updates: [routed("s1", update("s2", "https://t.me/c/100/4"))] });
  expect(shownView(wrongSession).telegram).toBeUndefined();
  const changed = run(wrongSession, { t: "updates", updates: [routed("s1", update("s1", "https://t.me.evil.example/c/100/4"))] },
    { t: "telegramStatus", sessionId: "s1", previous: null, value: { state: "detached" } });
  expect(shownView(changed).telegram).toEqual({ state: "active" });
});

describe("conversation: batched updates", () => {
  const batch: QueuedUpdate[] = [
    { update: chunk("Hel"), at: 1 },
    { update: chunk("lo"), at: 2 },
    { update: tool("c1", "in_progress", true), at: 3 },
    { update: tool("c1", "completed"), at: 9 },
    { update: chunk("Done"), at: 10 },
    { update: u({ sessionUpdate: "plan", entries: [] }), at: 11 },
  ];

  test("one batch equals the same updates applied one by one", () => {
    const together = applyUpdates(conv, batch);
    let oneByOne = conv;
    for (const q of batch) oneByOne = applyUpdates(oneByOne, [q]);
    expect(together).toEqual(oneByOne);
    expect(together.items.map((i) => i.kind)).toEqual(["agent", "tool", "agent"]);
  });

  test("a batch that changes nothing returns the same conversation", () => {
    const withModes: ConvState = { ...conv, modes: { currentModeId: "ask", availableModes: [] }, title: "T" };
    const noop: QueuedUpdate[] = [
      { update: chunk("you", "user_message_chunk"), at: 1 }, // live user text is added on send
      { update: chunk(""), at: 2 },
      { update: u({ sessionUpdate: "current_mode_update", currentModeId: "ask" }), at: 3 },
      { update: u({ sessionUpdate: "session_info_update" }), at: 4 },
      { update: u({ sessionUpdate: "session_info_update", title: "T" }), at: 5 },
      { update: u({ sessionUpdate: "something_new" }), at: 6 },
    ];
    expect(applyUpdates(withModes, noop)).toBe(withModes);
  });

  test("a batch with one real change returns a new conversation", () => {
    expect(applyUpdates(conv, [{ update: chunk(""), at: 1 }, { update: chunk("x"), at: 2 }])).not.toBe(conv);
  });
});

describe("conversation: tools", () => {
  test("findTool finds the most recent call with that id", () => {
    const t = (id: number, toolCallId: string): Item => ({
      kind: "tool",
      id,
      toolCallId,
      title: "",
      toolKind: "other",
      status: "pending",
      content: [],
      autoApproved: false,
      startedAt: 0,
      endedAt: null,
    });
    const items: Item[] = [t(1, "a"), t(2, "b"), t(3, "a"), { kind: "agent", id: 4, text: "x" }];
    expect(findTool(items, "a")).toBe(2);
    expect(findTool(items, "zzz")).toBe(-1);
  });

  test("a live completed call gets an end time", () => {
    const s = applyUpdates(conv, [
      { update: tool("c1", "in_progress", true), at: 100 },
      { update: tool("c1", "completed"), at: 350 },
    ]);
    const it = s.items[0] as Extract<Item, { kind: "tool" }>;
    expect(it.startedAt).toBe(100);
    expect(it.endedAt).toBe(350);
  });

  test("a replayed completed call has no end time", () => {
    const s = applyUpdates({ ...conv, replaying: true }, [
      { update: tool("c1", "in_progress", true), at: 100 },
      { update: tool("c1", "completed"), at: 350 },
    ]);
    expect((s.items[0] as Extract<Item, { kind: "tool" }>).endedAt).toBeNull();
  });
});

describe("window: every update is routed by its sessionId", () => {
  test("an update for a session that is not shown lands in its own state", () => {
    const s = run(twoHeld, { t: "updates", updates: [routed("s2", chunk("background")), routed("s1", chunk("front"))] });
    expect(textOf(s.convs.s2)).toBe("background");
    expect(textOf(s.convs.s1)).toBe("front");
    expect(shownView(s).items.map((i) => (i.kind === "agent" ? i.text : ""))).toEqual(["front"]);
  });

  test("an update for a session the window does not have changes nothing", () => {
    expect(run(twoHeld, { t: "updates", updates: [routed("zzz", chunk("x"))] })).toBe(twoHeld);
  });

  test("a released session is not narrated into, but keeps its last state", () => {
    const s = run(twoHeld, { t: "updates", updates: [routed("s2", chunk("before"))] }, { t: "released", sessionId: "s2" });
    expect(s.convs.s2?.held).toBeFalse();
    const after = run(s, { t: "updates", updates: [routed("s2", chunk(" after"))] });
    expect(textOf(after.convs.s2)).toBe("before");
  });

  test("busy, notices and sent text belong to their own session", () => {
    const s = run(
      twoHeld,
      { t: "userSent", sessionId: "s2", text: "hi" },
      { t: "busy", sessionId: "s2", busy: true },
      { t: "notice", sessionId: "s2", level: "info", text: "Stopped." },
    );
    expect(s.convs.s1?.busy).toBeFalse();
    expect(s.convs.s2?.busy).toBeTrue();
    expect(textOf(s.convs.s2)).toBe("hi|Stopped.");
    expect(shownView(s).busy).toBeFalse();
  });
});

describe("window: switching", () => {
  test("showing a held session is local and shows its cached state", () => {
    const withText = run(twoHeld, { t: "updates", updates: [routed("s2", chunk("cached"))] });
    const s = run(withText, { t: "show", sessionId: "s2" });
    expect(s.shownId).toBe("s2");
    expect(s.convs).toBe(withText.convs);
    expect(shownView(s).items.map((i) => (i.kind === "agent" ? i.text : ""))).toEqual(["cached"]);
  });

  test("showing a session the window does not have changes nothing", () => {
    expect(run(twoHeld, { t: "show", sessionId: "zzz" })).toBe(twoHeld);
  });

  test("a load replays off screen and is shown only when it lands", () => {
    const loading = run(twoHeld, { t: "loadStart", sessionId: "s3" }, { t: "updates", updates: [routed("s3", chunk("old question", "user_message_chunk"))] });
    expect(loading.shownId).toBe("s1");
    expect(shownView(loading).opening).toBeTrue();
    expect(shownView(loading).loadingIds).toEqual(["s3"]);
    const done = run(loading, { t: "loadDone", sessionId: "s3", modes: { currentModeId: "ask", availableModes: [] }, show: true });
    expect(done.shownId).toBe("s3");
    expect(done.loading).toEqual({});
    expect(done.convs.s3?.replaying).toBeFalse();
    expect(done.convs.s3?.held).toBeTrue();
    expect(textOf(done.convs.s3)).toBe("old question");
    expect(shownView(done).modes?.currentModeId).toBe("ask");
  });

  test("a load that fails leaves the view and a released copy as they were", () => {
    const released = run(twoHeld, { t: "updates", updates: [routed("s2", chunk("last"))] }, { t: "released", sessionId: "s2" });
    const s = run(released, { t: "loadStart", sessionId: "s2" }, { t: "loadFailed", sessionId: "s2" });
    expect(s.shownId).toBe("s1");
    expect(s.convs.s2).toBe(released.convs.s2);
    expect(shownView(s).opening).toBeFalse();
  });

  test("reloading a released session replaces its read-only copy", () => {
    const released = run(twoHeld, { t: "updates", updates: [routed("s2", chunk("stale"))] }, { t: "released", sessionId: "s2" });
    const s = run(
      released,
      { t: "loadStart", sessionId: "s2" },
      { t: "updates", updates: [routed("s2", chunk("replayed"))] },
      { t: "loadDone", sessionId: "s2", show: true },
    );
    expect(textOf(s.convs.s2)).toBe("replayed");
    expect(s.convs.s2?.held).toBeTrue();
  });

  test("a new session not meant to be shown is added without taking the screen", () => {
    const s = run(twoHeld, { t: "creating", delta: 1 }, { t: "created", sessionId: "s3", show: false }, { t: "creating", delta: -1 });
    expect(s.shownId).toBe("s1");
    expect(s.convs.s3?.held).toBeTrue();
    expect(shownView(s).opening).toBeFalse();
  });

  test("a lost connection keeps every conversation visible, read-only", () => {
    const s = run(twoHeld, { t: "busy", sessionId: "s1", busy: true }, { t: "loadStart", sessionId: "s3" }, { t: "connectionReset" });
    expect(s.shownId).toBe("s1");
    expect(s.convs.s1?.held).toBeFalse();
    expect(s.convs.s1?.busy).toBeFalse();
    expect(s.loading).toEqual({});
    expect(shownView(s).held).toBeFalse();
    expect(shownView(s).lostReason).toBe("connection");
  });

  test("an idle-cap release and a lost connection are told apart, and a reload clears the reason", () => {
    const released = run(twoHeld, { t: "released", sessionId: "s2" }, { t: "connectionReset" });
    expect(released.convs.s2?.lostReason).toBe("idle-cap");
    expect(released.convs.s1?.lostReason).toBe("connection");
    const back = run(released, { t: "loadStart", sessionId: "s2" }, { t: "loadDone", sessionId: "s2", show: true });
    expect(back.convs.s2?.lostReason).toBeNull();
  });
});

describe("window: sidebar marks", () => {
  test("busy, waiting and released are marked per session", () => {
    const s = run(twoHeld, { t: "busy", sessionId: "s2", busy: true }, { t: "released", sessionId: "s1" });
    const marks = sessionMarks(s, new Set(["s2"]));
    expect(marks.s1).toEqual({ busy: false, waiting: false, held: false, lostReason: "idle-cap", title: null, running: 0, subagents: [] });
    expect(marks.s2).toEqual({ busy: true, waiting: true, held: true, lostReason: null, title: null, running: 0, subagents: [] });
  });
});

describe("userSendFailed", () => {
  const userOf = (s: WindowState, n = 0) => s.convs.s1!.items.filter((i) => i.kind === "user")[n] as Extract<Item, { kind: "user" }>;

  test("flags the last user item", () => {
    const s = run(twoHeld, { t: "userSent", sessionId: "s1", text: "a" }, { t: "userSendFailed", sessionId: "s1" });
    expect(userOf(s).failed).toBeTrue();
  });

  test("is skipped when agent output follows the user item", () => {
    const s = run(
      twoHeld,
      { t: "userSent", sessionId: "s1", text: "a" },
      { t: "updates", updates: [routed("s1", chunk("reply"))] },
      { t: "userSendFailed", sessionId: "s1" },
    );
    expect(userOf(s).failed).toBeUndefined();
  });

  test("stays when an unrelated message is sent later", () => {
    const s = run(
      twoHeld,
      { t: "userSent", sessionId: "s1", text: "a" },
      { t: "userSendFailed", sessionId: "s1" },
      { t: "userSent", sessionId: "s1", text: "b" },
    );
    expect(userOf(s, 0).failed).toBeTrue();
    expect(userOf(s, 1).failed).toBeUndefined();
  });

  test("an edit that names the failed message clears only that message's flag", () => {
    const sent = run(twoHeld, { t: "userSent", sessionId: "s1", text: "a" });
    const id = userOf(sent, 0).id;
    const s = run(sent, { t: "userSendFailed", sessionId: "s1" }, { t: "userSent", sessionId: "s1", text: "edited a", replaces: id });
    expect(userOf(s, 0).failed).toBeUndefined();
    expect(userOf(s, 1).failed).toBeUndefined();
  });

  test("an edit naming a different message leaves the failed flag", () => {
    const s = run(
      twoHeld,
      { t: "userSent", sessionId: "s1", text: "a" },
      { t: "userSendFailed", sessionId: "s1" },
      { t: "userSent", sessionId: "s1", text: "a", replaces: 999 },
    );
    expect(userOf(s, 0).failed).toBeTrue();
  });

  test("sending the same text again from the composer clears the flag of the failed copy", () => {
    const s = run(
      twoHeld,
      { t: "userSent", sessionId: "s1", text: "a" },
      { t: "userSendFailed", sessionId: "s1" },
      { t: "userSent", sessionId: "s1", text: "a" },
    );
    expect(userOf(s, 0).failed).toBeUndefined();
  });

  test("an itemId flags that item; a missing item changes nothing", () => {
    const sent = run(twoHeld, { t: "userSent", sessionId: "s1", text: "a" });
    const id = userOf(sent).id;
    expect(userOf(run(sent, { t: "userSendFailed", sessionId: "s1", itemId: id })).failed).toBeTrue();
    expect(run(sent, { t: "userSendFailed", sessionId: "s1", itemId: 999 })).toBe(sent);
    expect(run(twoHeld, { t: "userSendFailed", sessionId: "s1" })).toBe(twoHeld);
  });
});

describe("replay: delegate notes kept in the history (spec 3.9.5a)", () => {
  const note = (runId: string, turn: number, text: string) =>
    u({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { keryx: { delegateResult: { runId, agentId: "claude-cli", turn, text } } } });
  const loaded = () =>
    run(
      twoHeld,
      { t: "loadStart", sessionId: "s3" },
      { t: "updates", updates: [routed("s3", chunk("go", "user_message_chunk")), routed("s3", note("ext:1", 1, "first")), routed("s3", note("ext:1", 2, "| a |\n|---|\n| 1 |"))] },
      { t: "loadDone", sessionId: "s3", show: false },
    );

  test("each note is a delegate card, not a user bubble", () => {
    const items = loaded().convs.s3!.items;
    expect(items.map((i) => i.kind)).toEqual(["user", "delegate", "delegate"]);
    expect(items[2]).toMatchObject({ kind: "delegate", runId: "ext:1", agentId: "claude-cli", turn: 2, text: "| a |\n|---|\n| 1 |" });
  });

  test("the run is restored as ONE finished external subagent holding the last turn, so the pill counts it", () => {
    const s = loaded();
    const agents = s.convs.s3!.subagents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "ext:1", status: "done", detail: "from history", runtime: "external", agentId: "claude-cli" });
    expect(agents[0]!.entries).toEqual([{ kind: "result", text: "| a |\n|---|\n| 1 |" }]);
    expect(sessionMarks(s, new Set()).s3?.subagents).toHaveLength(1);
    expect(sessionMarks(s, new Set()).s3?.running).toBe(0);
  });

  test("a live (not replayed) chunk with the meta changes nothing", () => {
    const s = applyUpdates(conv, [{ update: note("ext:1", 1, "x"), at: 1 }]);
    expect(s).toBe(conv);
  });
});
