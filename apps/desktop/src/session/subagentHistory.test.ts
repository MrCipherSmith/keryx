import { describe, expect, test } from "bun:test";
import { applySubagentEvent, partitionSubagents, sortSubagents, type Subagent } from "./activity";
import { archivedChild, recoverChild } from "./subagentHistory";
import { initialState, reducer, type Action, type WindowState } from "./reducer";

const sessionId = "parent";
function advance(state: WindowState, ...actions: Action[]): WindowState {
  return actions.reduce(reducer, state);
}
const create = { t: "created", sessionId, show: true } as const;
const prompt = { t: "userSent", sessionId, text: "next" } as const;
const event = (id: string, status: string, at: number): Action => ({ t: "subagent", sessionId, event: { kind: "upsert", id, status }, at });
const rows = (w: WindowState) => w.convs[sessionId]!.subagents;
const ids = (list: readonly Subagent[]) => list.map(row => row.id);

describe("child sessions across parent turns", () => {
  test("first spawn switches the current turn, preserves older live children until exit, and newest first", () => {
    let w = advance(initialState, create, prompt, event("first", "done", 10), event("still-open", "idle", 15), prompt);
    expect(ids(partitionSubagents(rows(w)).current)).toEqual(["still-open", "first"]);
    w = advance(w, event("new", "done", 20), event("newer", "running", 25));
    expect(ids(partitionSubagents(rows(w)).current)).toEqual(["newer", "still-open", "new"]);
    expect(ids(partitionSubagents(rows(w)).archived)).toEqual(["first"]);
    w = advance(w, event("still-open", "done", 30));
    expect(ids(sortSubagents(rows(w)))).toEqual(["newer", "new", "still-open", "first"]);
    expect(ids(partitionSubagents(rows(w)).archived)).toEqual(["still-open", "first"]);
    expect(rows(w).find(a => a.id === "still-open")?.startedAt).toBe(15);
  });

  test("replay of a stored native result joins its observed child log and keeps the replay call id", () => {
    const ts = "2026-02-01T00:00:00Z";
    const replay = advance(initialState, { t: "loadStart", sessionId }, { t: "updates", updates: [
      { sessionId, at: 3000, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "go" } } },
      { sessionId, at: 3000, update: { sessionUpdate: "tool_call", toolCallId: "call", title: "spawn_subagent", _meta: { keryx: { recordedAt: ts } } } },
      { sessionId, at: 3000, update: { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed", rawOutput: "subagent Reviewer (sub:one) read_only via a/b\n--- summary ---\nVerified the fix." } },
    ] });
    const fallback = advance(replay, { t: "loadDone", sessionId, show: true });
    expect(rows(fallback)).toMatchObject([{ id: "sub:one", label: "Reviewer", turn: 1, startedAt: Date.parse(ts), status: "done", entries: [{ text: "Verified the fix." }] }]);
    const reopened = advance(replay, { t: "loadDone", sessionId, show: true, archive: [
      { id: "sub:one", label: "Reviewer", status: "unknown", parentToolCallId: "live", turn: 1, entries: [{ kind: "tool", text: "read_file" }] },
    ] });
    expect(rows(reopened)).toMatchObject([{ id: "sub:one", parentToolCallId: "call", status: "done", entries: [{ text: "read_file" }, { text: "Verified the fix." }] }]);
  });

  test("public snapshots preserve only authorized event kinds and scrub credentials", () => {
    const child: Subagent = { id: "a", label: "Reviewer", task: "private-task", status: "running", entries: [
      { kind: "task", text: "private-task" }, { kind: "reasoning", text: "private-thought" },
      { kind: "text", text: "Testing now, PASSWORD=secret-password" }, { kind: "tool", text: "read_file: sensitive/path" },
      { kind: "result", text: "read_file sensitive result" }, { kind: "result", text: "Safe final", returned: true },
    ] };
    const snapshot = archivedChild(child);
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.entries.map(e => e.kind)).toEqual(["text", "tool", "system", "result"]);
    expect(snapshot.entries.map(e => e.text)).toContain("Safe final");
    expect(JSON.stringify(snapshot)).not.toMatch(/private-|sensitive|secret-password/);
    expect(archivedChild({ ...snapshot })).toEqual(snapshot);
  });

  test("a quota-limited shutdown tail supplements durable events and preserves genuine gaps", () => {
    const saved: Subagent = { id: "sub", label: "Worker", status: "unknown", entries: [{ kind: "text", text: "Initial public answer" }, { kind: "tool", text: "read_file" }] };
    const marker = { kind: "system", text: "Earlier activity omitted" };
    const answer = { kind: "result", text: "Final answer", returned: true as const };
    const tail = { ...saved, status: "done", entries: [marker, saved.entries[1]!, answer] };
    expect(recoverChild(saved, tail).entries).toEqual([...saved.entries, answer]);
    expect(recoverChild(saved, { ...tail, entries: [marker, answer] }).entries).toEqual([...saved.entries, marker, answer]);
  });

  test("bounded snapshots mark truncated activity and retain the final returned result", () => {
    const child: Subagent = { id: "a", label: "Inspector", status: "done", entries: Array.from({ length: 120 }, (_, i) => ({ kind: "tool", text: "tool_" + i })) };
    child.entries.push({ kind: "result", text: "The report", returned: true });
    const kept = archivedChild(child);
    expect(kept.entries).toHaveLength(100);
    expect(kept.entries[0]?.text).toBe("Earlier activity omitted");
    expect(kept.entries.at(-1)?.text).toBe("The report");
    const truncated = applySubagentEvent([{ ...child, entries: Array.from({ length: 200 }, () => ({ kind: "tool", text: "read" })) }], { kind: "log", id: "a", entry: { kind: "tool", text: "read" } });
    expect(truncated[0]?.entriesTruncated).toBe(true);
  });
});
