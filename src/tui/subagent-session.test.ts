// Flow 162 — subagent session store + list/work formatters (AC1, AC3, AC5).
import { expect, test } from "bun:test";
import { SIDEBAR_TEXT_WIDTH } from "./shell-chrome";
import {
  MAX_SUBAGENT_EVENT_CHARS,
  MAX_SUBAGENT_EVENTS,
  SubagentSessionStore,
  formatSubagentList,
  formatSubagentMeta,
  formatSubagentRow,
  formatSubagentWork,
  type SubagentSession,
} from "./subagent-session";

function session(partial: Partial<SubagentSession> & Pick<SubagentSession, "id" | "label">): SubagentSession {
  return {
    status: "running",
    startedAt: 1_000,
    events: [],
    ...partial,
  };
}

test("store keeps every child, including done and failed; remove is a no-op", () => {
  const store = new SubagentSessionStore();
  store.apply({ kind: "upsert", id: "sub:1", label: "review-logic", status: "running", task: "review PR" });
  store.apply({ kind: "upsert", id: "sub:2", label: "review-style", status: "done", detail: "done" });
  store.apply({ kind: "upsert", id: "sub:3", label: "explore", status: "failed", detail: "timeout" });
  store.apply({ kind: "remove", id: "sub:2" });
  const ids = store.list().map((s) => s.id);
  expect(ids).toEqual(["sub:1", "sub:2", "sub:3"]);
  expect(store.get("sub:2")?.status).toBe("done");
});

test("clear() drops every tracked child in one call and notifies listeners once", () => {
  const store = new SubagentSessionStore();
  store.apply({ kind: "upsert", id: "sub:1", label: "a", status: "done", detail: "done" });
  store.apply({ kind: "upsert", id: "sub:2", label: "b", status: "running" });
  const hints: string[] = [];
  store.subscribe((hint) => hints.push(hint.kind));

  store.clear();

  expect(store.list()).toEqual([]);
  expect(hints).toEqual(["remove"]);
});

test("clear() on an already-empty store is a no-op (no listener notification)", () => {
  const store = new SubagentSessionStore();
  let notified = false;
  store.subscribe(() => {
    notified = true;
  });

  store.clear();

  expect(notified).toBe(false);
});

test("AC1: formatSubagentList prints every child and never +N more", () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    session({ id: `sub:${i}`, label: `worker-${i}`, status: i === 0 ? "running" : "done" }),
  );
  const text = formatSubagentList(rows, SIDEBAR_TEXT_WIDTH);
  expect(text).toContain("Subagents 20");
  expect(text).not.toMatch(/\+\d+ more/);
  for (let i = 0; i < 20; i += 1) {
    expect(text).toContain(`worker-${i}`);
  }
});

test("formatSubagentRow is one sidebar line with glyph, label, and phase", () => {
  const line = formatSubagentRow(
    session({ id: "sub:1", label: "review-logic", status: "running", detail: "thinking" }),
    SIDEBAR_TEXT_WIDTH,
  );
  expect(line).toContain("◐");
  expect(line).toContain("review-logic");
  expect(line).toMatch(/think/i);
  expect(line.length).toBeLessThanOrEqual(SIDEBAR_TEXT_WIDTH);
});

test("AC3: formatSubagentWork includes task and ordered tool/text/reasoning events", () => {
  const text = formatSubagentWork(
    session({
      id: "sub:1",
      label: "review-logic",
      model: "ollama/fake",
      status: "running",
      task: "Review the auth module",
      events: [
        { at: 1, kind: "task", text: "Review the auth module" },
        { at: 2, kind: "tool", text: "search_code" },
        { at: 3, kind: "reasoning", text: "Need the login path." },
        { at: 4, kind: "text", text: "Found 2 issues." },
      ],
    }),
  );
  expect(text).toContain("Review the auth module");
  expect(text.indexOf("search_code")).toBeLessThan(text.indexOf("Need the login path"));
  expect(text.indexOf("Need the login path")).toBeLessThan(text.indexOf("Found 2 issues"));
});

test("formatSubagentMeta lists id, model, status, and elapsed", () => {
  const text = formatSubagentMeta(
    session({
      id: "sub:1",
      label: "review-logic",
      model: "ollama/fake",
      status: "done",
      startedAt: 1_000,
      endedAt: 13_000,
      task: "Review auth",
    }),
  );
  expect(text).toContain("sub:1");
  expect(text).toContain("ollama/fake");
  expect(text).toContain("done");
  expect(text).toContain("12s");
  expect(text).toContain("Review auth");
});

test("store appends log events and subscribe notifies", () => {
  const store = new SubagentSessionStore();
  let n = 0;
  store.subscribe(() => {
    n += 1;
  });
  store.apply({ kind: "upsert", id: "sub:1", label: "one", status: "running", task: "go" });
  store.apply({ kind: "log", id: "sub:1", entry: { kind: "tool", text: "search_code" } });
  store.apply({ kind: "log", id: "sub:1", entry: { kind: "text", text: "ok" } });
  const rec = store.get("sub:1");
  expect(rec?.task).toBe("go");
  expect(rec?.events.map((e) => e.kind)).toEqual(["task", "tool", "text"]);
  expect(n).toBe(3);
});

test("terminal failed/done status is not overwritten by a later running upsert", () => {
  const store = new SubagentSessionStore();
  store.apply({ kind: "upsert", id: "sub:1", label: "one", status: "failed", detail: "timeout", task: "go" });
  store.apply({ kind: "upsert", id: "sub:1", label: "one", status: "running", detail: "search_code", task: "go" });
  expect(store.get("sub:1")?.status).toBe("failed");
  expect(store.get("sub:1")?.detail).toBe("search_code");
});

test("formatSubagentWork shows empty state when only the synthetic task exists", () => {
  const text = formatSubagentWork(
    session({ id: "sub:1", label: "one", task: "Review auth", events: [{ at: 1, kind: "task", text: "Review auth" }] }),
  );
  expect(text).toContain("Review auth");
  expect(text).toContain("(no events yet)");
});

test("store clips long log text and ring-buffers events while keeping the task", () => {
  const store = new SubagentSessionStore();
  store.apply({ kind: "upsert", id: "sub:1", label: "one", status: "running", task: "keep-me" });
  store.apply({ kind: "log", id: "sub:1", entry: { kind: "text", text: "x".repeat(MAX_SUBAGENT_EVENT_CHARS + 50) } });
  const first = store.get("sub:1")?.events.find((e) => e.kind === "text");
  expect(first?.text.length).toBe(MAX_SUBAGENT_EVENT_CHARS + 1);
  expect(first?.text.endsWith("…")).toBe(true);

  for (let i = 0; i < MAX_SUBAGENT_EVENTS + 20; i += 1) {
    store.apply({ kind: "log", id: "sub:1", entry: { kind: "tool", text: `t${i}` } });
  }
  const events = store.get("sub:1")?.events ?? [];
  expect(events.length).toBeLessThanOrEqual(MAX_SUBAGENT_EVENTS);
  expect(events[0]?.kind).toBe("task");
  expect(events[0]?.text).toBe("keep-me");
});
