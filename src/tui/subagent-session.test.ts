// Flow 162 — subagent session store + list/work formatters (AC1, AC3, AC5).
import { expect, test } from "bun:test";
import {
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

test("AC1: formatSubagentList prints every child and never +N more", () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    session({ id: `sub:${i}`, label: `worker-${i}`, status: i === 0 ? "running" : "done" }),
  );
  const text = formatSubagentList(rows, 26);
  expect(text).toContain("Subagents 20");
  expect(text).not.toMatch(/\+\d+ more/);
  for (let i = 0; i < 20; i += 1) {
    expect(text).toContain(`worker-${i}`);
  }
});

test("formatSubagentRow is one sidebar line with glyph, label, and phase", () => {
  const line = formatSubagentRow(
    session({ id: "sub:1", label: "review-logic", status: "running", detail: "thinking" }),
    26,
  );
  expect(line).toContain("◐");
  expect(line).toContain("review-logic");
  expect(line).toMatch(/think/i);
  expect(line.length).toBeLessThanOrEqual(26);
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
