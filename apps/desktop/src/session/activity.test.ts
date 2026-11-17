import { describe, expect, test } from "bun:test";
import { toTask, toTasks } from "../acp/providers";
import { applySubagentEvent, MAX_SUBAGENT_ENTRIES, MAX_SUBAGENT_ENTRY_CHARS, runningSubagents, subagentForToolCall, type Subagent } from "./activity";
import { activityCount, initialState, reducer, sessionMarks, shownView, type Action, type WindowState } from "./reducer";

const log = (id: string, kind: string, text: string) => ({ kind: "log", id, entry: { kind, text } });
const upsert = (id: string, over: Record<string, unknown> = {}) => ({ kind: "upsert", id, label: id, status: "running", ...over });
const fold = (...events: unknown[]) => events.reduce<readonly Subagent[]>((l, e) => applySubagentEvent(l, e), []);

describe("applySubagentEvent", () => {
  test("upsert creates, then merges only the fields it carries", () => {
    const l = fold(upsert("a", { label: "reviewer", model: "m1", task: "look", parentToolCallId: "call-1", runtime: "external" }), { kind: "upsert", id: "a", status: "done", detail: "ok" });
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id: "a", label: "reviewer", status: "done", detail: "ok", model: "m1", task: "look", parentToolCallId: "call-1", runtime: "external", entries: [] });
  });

  test("a text entry replaces the previous entry only when that one is also text", () => {
    const l = fold(upsert("a"), log("a", "text", "He"), log("a", "text", "Hello"), log("a", "tool", "grep x"), log("a", "text", "Hi"), log("a", "result", "r"), log("a", "text", "Hi again"));
    expect(l[0]!.entries.map((e) => `${e.kind}:${e.text}`)).toEqual(["text:Hello", "tool:grep x", "text:Hi", "result:r", "text:Hi again"]);
  });

  test("other kinds always append, reasoning included", () => {
    const l = fold(upsert("a"), log("a", "reasoning", "x"), log("a", "reasoning", "y"));
    expect(l[0]!.entries).toHaveLength(2);
  });

  test("limits: 200 entries (the oldest drop) and 2,000 characters each", () => {
    let l: readonly Subagent[] = fold(upsert("a"));
    for (let i = 0; i < MAX_SUBAGENT_ENTRIES + 5; i++) l = applySubagentEvent(l, log("a", "tool", `t${i}`));
    expect(l[0]!.entries).toHaveLength(MAX_SUBAGENT_ENTRIES);
    expect(l[0]!.entries[0]!.text).toBe("t5");
    l = applySubagentEvent(l, log("a", "result", "x".repeat(5000)));
    const last = l[0]!.entries[l[0]!.entries.length - 1]!;
    expect(last.text.length).toBe(MAX_SUBAGENT_ENTRY_CHARS);
    expect(last.text.endsWith("…")).toBe(true);
  });

  test("a log for an unknown id creates the subagent; malformed events change nothing", () => {
    const l = fold(log("z", "text", "hi"));
    expect(l[0]).toMatchObject({ id: "z", label: "z", status: "running" });
    const before = fold(upsert("a"));
    expect(applySubagentEvent(before, { kind: "nope", id: "a" })).toBe(before);
    expect(applySubagentEvent(before, { kind: "log", id: "a", entry: { kind: 1 } })).toBe(before);
    expect(applySubagentEvent(before, null)).toBe(before);
  });

  test("running count and the link from a tool call", () => {
    const l = fold(upsert("a", { parentToolCallId: "c1" }), upsert("b", { status: "done", parentToolCallId: "c2" }));
    expect(runningSubagents(l)).toBe(1);
    expect(subagentForToolCall(l, "c2")?.id).toBe("b");
    expect(subagentForToolCall(l, "none")).toBeUndefined();
  });
});

describe("subagents and tasks in the window reducer", () => {
  const run = (s: WindowState, ...a: Action[]) => a.reduce(reducer, s);
  const two = run({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true }, { t: "created", sessionId: "s2", show: false });
  const ev = (sessionId: string, event: unknown): Action => ({ t: "subagent", sessionId, event });

  test("events land on the session they name, shown or not", () => {
    const s = run(two, ev("s2", upsert("a")), ev("s1", upsert("b")));
    expect(s.convs.s1!.subagents.map((x) => x.id)).toEqual(["b"]);
    expect(s.convs.s2!.subagents.map((x) => x.id)).toEqual(["a"]);
    expect(shownView(s).subagents.map((x) => x.id)).toEqual(["b"]);
  });

  test("an event for a session the window does not hold is ignored", () => {
    expect(run(two, ev("nope", upsert("a")))).toBe(two);
  });

  test("subagents are kept across turns, not cleared when a turn starts or ends", () => {
    const s = run(two, ev("s1", upsert("a", { status: "done" })), { t: "userSent", sessionId: "s1", text: "next" }, { t: "busy", sessionId: "s1", busy: true }, { t: "busy", sessionId: "s1", busy: false });
    expect(s.convs.s1!.subagents).toHaveLength(1);
  });

  test("a new session starts empty and the old one keeps its own", () => {
    const s = run(two, ev("s1", upsert("a")), { t: "created", sessionId: "s3", show: true });
    expect(shownView(s).subagents).toEqual([]);
    expect(s.convs.s1!.subagents).toHaveLength(1);
  });

  test("session/load starts empty (subagents are not persisted) but keeps the tasks keryx still runs", () => {
    const tasks = [toTask({ jobId: "t1", command: "sleep 9", status: "running", startedAt: "2026-11-17T10:00:00Z" })!];
    const s = run(two, ev("s1", upsert("a")), { t: "tasks", sessionId: "s1", tasks }, { t: "loadStart", sessionId: "s1" }, { t: "loadDone", sessionId: "s1", show: true });
    expect(s.convs.s1!.subagents).toEqual([]);
    expect(s.convs.s1!.tasks).toEqual(tasks);
  });

  test("marks carry the running count of subagents plus tasks", () => {
    const tasks = toTasks({ tasks: [{ jobId: "t1", command: "a", status: "running", startedAt: "2026-11-17T10:00:00Z" }, { jobId: "t2", command: "b", status: "completed", startedAt: "2026-11-17T10:00:00Z" }] });
    const s = run(two, ev("s2", upsert("a")), ev("s2", upsert("b", { status: "done" })), { t: "tasks", sessionId: "s2", tasks });
    expect(activityCount(s.convs.s2!)).toBe(2);
    expect(sessionMarks(s, new Set()).s2!.running).toBe(2);
    expect(sessionMarks(s, new Set()).s1!.running).toBe(0);
  });
});

describe("toTask", () => {
  test("reads BackgroundJobInfo", () => {
    expect(toTask({ jobId: "t1", command: "make", status: "failed", phase: "background", startedAt: "2026-11-17T10:00:00.000Z", endedAt: "2026-11-17T10:00:05.000Z", exitCode: 2 })).toEqual({
      id: "t1",
      command: "make",
      status: "failed",
      phase: "background",
      description: null,
      startedAt: Date.parse("2026-11-17T10:00:00.000Z"),
      endedAt: Date.parse("2026-11-17T10:00:05.000Z"),
      exitCode: 2,
    });
    expect(toTask({ command: "no id" })).toBeNull();
  });
});
