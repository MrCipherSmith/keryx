import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "../acp/types";
import { applyUpdates, findTool, initialState, reducer, type Item, type QueuedUpdate, type SessionState } from "./reducer";

const u = (x: Record<string, unknown>) => x as unknown as SessionUpdate;
const chunk = (text: string, kind = "agent_message_chunk") => u({ sessionUpdate: kind, content: { type: "text", text } });
const tool = (toolCallId: string, status: string, fresh = false) =>
  u({ sessionUpdate: fresh ? "tool_call" : "tool_call_update", toolCallId, status, title: `t ${toolCallId}` });

const live: SessionState = { ...initialState, sessionId: "s1", phase: "ready" };

describe("reducer: batched updates", () => {
  const batch: QueuedUpdate[] = [
    { update: chunk("Hel"), at: 1 },
    { update: chunk("lo"), at: 2 },
    { update: tool("c1", "in_progress", true), at: 3 },
    { update: tool("c1", "completed"), at: 9 },
    { update: chunk("Done"), at: 10 },
    { update: u({ sessionUpdate: "plan", entries: [] }), at: 11 },
  ];

  test("one batch equals the same updates applied one by one", () => {
    const together = reducer(live, { t: "updates", updates: batch });
    let oneByOne = live;
    for (const q of batch) oneByOne = reducer(oneByOne, { t: "update", update: q.update, at: q.at });
    expect(together).toEqual(oneByOne);
    expect(together.items.map((i) => i.kind)).toEqual(["agent", "tool", "agent"]);
  });

  test("a batch that changes nothing returns the same state", () => {
    const withModes: SessionState = { ...live, modes: { currentModeId: "ask", availableModes: [] } as unknown as SessionState["modes"], title: "T" };
    const noop: QueuedUpdate[] = [
      { update: chunk("you", "user_message_chunk"), at: 1 }, // live user text is added on send
      { update: chunk(""), at: 2 },
      { update: u({ sessionUpdate: "current_mode_update", currentModeId: "ask" }), at: 3 },
      { update: u({ sessionUpdate: "session_info_update" }), at: 4 },
      { update: u({ sessionUpdate: "session_info_update", title: "T" }), at: 5 },
      { update: u({ sessionUpdate: "something_new" }), at: 6 },
    ];
    expect(applyUpdates(withModes, noop)).toBe(withModes);
    expect(reducer(live, { t: "update", update: u({ sessionUpdate: "current_mode_update", currentModeId: "x" }) })).toBe(live);
  });

  test("a batch with one real change returns a new state", () => {
    expect(applyUpdates(live, [{ update: chunk(""), at: 1 }, { update: chunk("x"), at: 2 }])).not.toBe(live);
  });
});

describe("reducer: tools", () => {
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
    const s = applyUpdates(live, [
      { update: tool("c1", "in_progress", true), at: 100 },
      { update: tool("c1", "completed"), at: 350 },
    ]);
    const it = s.items[0] as Extract<Item, { kind: "tool" }>;
    expect(it.startedAt).toBe(100);
    expect(it.endedAt).toBe(350);
  });

  test("a replayed completed call has no end time", () => {
    const replaying = { ...live, replaying: true };
    const s = applyUpdates(replaying, [
      { update: tool("c1", "in_progress", true), at: 100 },
      { update: tool("c1", "completed"), at: 350 },
    ]);
    expect((s.items[0] as Extract<Item, { kind: "tool" }>).endedAt).toBeNull();
  });
});

describe("reducer: the switching flag has one owner", () => {
  test("only the switching action changes it", () => {
    const on = reducer(live, { t: "switching", on: true });
    expect(on.switching).toBeTrue();
    expect(reducer(on, { t: "session", sessionId: "s2", replaying: true }).switching).toBeTrue();
    expect(reducer({ ...on, replaying: true }, { t: "replayDone" }).switching).toBeTrue();
    expect(reducer(on, { t: "sessionLost" }).switching).toBeTrue();
    expect(reducer(on, { t: "switching", on: false }).switching).toBeFalse();
  });
});
