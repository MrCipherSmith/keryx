// Flow 173 (T4/T5) — background-job-session.ts: `BackgroundJobStore`,
// structural mirror of `subagent-session.ts`'s `SubagentSessionStore`
// (apply/get/list/subscribe), fed by `job-bridge.ts`'s `BackgroundJobEvent`
// stream (the SAME discriminated union `background-job-registry.ts` already
// exports and fires via its `onEvent` hook — not a new shape).
//
// DELIBERATE DIVERGENCE from `SubagentSessionStore` (this flow's AC9,
// description.md: "entries do NOT clear on a new turn/`/clear` — a
// background job is explicitly meant to outlive the turn that started it.
// It clears only on explicit kill or session exit"): `SubagentSessionStore`
// exposes a bulk `clear()` that `tui-shell.ts` calls at TWO points — a fresh
// parent turn, and `/clear`/`/new`. A `BackgroundJobStore` with an
// equivalent `clear()` would invite exactly that same call site to be added
// later, silently reintroducing the bug this flow's whole design exists to
// avoid. So `BackgroundJobStore` deliberately has NO `clear()` at all — only
// `removeAll()`, a distinctly named session-TEARDOWN sweep.
//
// flow 263 (P0, RED): every `shell_exec` is now a task. A task starts in the
// `foreground` phase and is invisible to the store until its `phase:
// "background"` event (a `background:true` start emits that event right after
// `start`). Output received before `phase` is kept; a task that exits while
// still foreground is dropped silently and never listed. Terminal statuses
// are `completed` | `failed` | `killed` (was `exited` | `killed`), each with
// its own glyph.
import { expect, test } from "bun:test";
import type { BackgroundJobEvent } from "../harness/tool/builtin/background-job-registry";
import {
  BackgroundJobStore,
  formatJobListHeader,
  formatJobMeta,
  formatJobOutput,
  formatJobRow,
  MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  type BackgroundJobEntry,
  type BackgroundJobStoreHint,
} from "./background-job-session";

const START = (over: Partial<Extract<BackgroundJobEvent, { type: "start" }>> = {}): BackgroundJobEvent => ({
  type: "start",
  jobId: "task-1-1001",
  pid: 1001,
  command: "npm run dev",
  startedAt: "2026-08-19T10:00:00.000Z",
  ...over,
});

const PHASE = (jobId = "task-1-1001"): BackgroundJobEvent =>
  ({ type: "phase", jobId, phase: "background" }) as BackgroundJobEvent;

/** start + promote: the shape of a task the store lists. */
function applyVisible(store: BackgroundJobStore, over: Partial<Extract<BackgroundJobEvent, { type: "start" }>> = {}): void {
  const start = START(over);
  store.apply(start);
  store.apply(PHASE(start.jobId));
}

const EXIT = (
  jobId: string,
  status: "completed" | "failed" | "killed",
  extra: { exitCode?: number; killReason?: string; endedAt?: string } = {},
): BackgroundJobEvent =>
  ({
    type: "exit",
    jobId,
    status,
    endedAt: extra.endedAt ?? "2026-08-19T10:05:00.000Z",
    ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    ...(extra.killReason !== undefined ? { killReason: extra.killReason } : {}),
  }) as BackgroundJobEvent;

// --- flow 263 AC8: phase gating -------------------------------------------

test("AC8: a start event alone does NOT list the task", () => {
  const store = new BackgroundJobStore();
  const hints: BackgroundJobStoreHint[] = [];
  store.subscribe((hint) => hints.push(hint));
  store.apply(START());
  expect(store.list()).toEqual([]);
  expect(hints).toEqual([]);
});

test("AC8: the phase event lists the task (as running) and emits a start hint", () => {
  const store = new BackgroundJobStore();
  const hints: BackgroundJobStoreHint[] = [];
  store.subscribe((hint) => hints.push(hint));
  applyVisible(store);
  expect(store.list().map((e) => e.jobId)).toEqual(["task-1-1001"]);
  expect(store.get("task-1-1001")).toMatchObject({
    jobId: "task-1-1001",
    pid: 1001,
    command: "npm run dev",
    status: "running",
  });
  expect(hints).toEqual([{ id: "task-1-1001", kind: "start" }]);
});

test("AC8: output received before the phase event is retained once the task becomes visible", () => {
  const store = new BackgroundJobStore();
  store.apply(START());
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "early line\n", stream: "stdout" });
  expect(store.list()).toEqual([]);
  store.apply(PHASE());
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "late line\n", stream: "stdout" });
  expect(store.get("task-1-1001")?.output).toBe("early line\nlate line\n");
});

test("AC8: a task that exits while still foreground is dropped silently and never listed", () => {
  const store = new BackgroundJobStore();
  const hints: BackgroundJobStoreHint[] = [];
  store.subscribe((hint) => hints.push(hint));
  store.apply(START({ jobId: "task-2-2002", pid: 2002, command: "git status" }));
  store.apply({ type: "output", jobId: "task-2-2002", chunk: "clean\n", stream: "stdout" });
  store.apply(EXIT("task-2-2002", "completed", { exitCode: 0 }));

  expect(store.list()).toEqual([]);
  expect(store.get("task-2-2002")).toBeUndefined();
  expect(hints.filter((h) => h.id === "task-2-2002")).toEqual([]);

  // A late stray phase event for the dropped task must not resurrect it.
  store.apply(PHASE("task-2-2002"));
  expect(store.list()).toEqual([]);
});

// --- existing store contract (updated for phase gating + new statuses) ----

test("apply(output) appends the chunk to the entry's output", () => {
  const store = new BackgroundJobStore();
  applyVisible(store);
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "compiling…\n", stream: "stdout" });
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "done\n", stream: "stdout" });
  expect(store.get("task-1-1001")?.output).toBe("compiling…\ndone\n");
});

test("output is bounded to MAX_BACKGROUND_JOB_OUTPUT_CHARS, keeping the TAIL (most recent) output", () => {
  const store = new BackgroundJobStore();
  applyVisible(store);
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "a".repeat(MAX_BACKGROUND_JOB_OUTPUT_CHARS), stream: "stdout" });
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "TAIL_MARKER", stream: "stdout" });
  const output = store.get("task-1-1001")?.output ?? "";
  expect(output.length).toBeLessThanOrEqual(MAX_BACKGROUND_JOB_OUTPUT_CHARS);
  expect(output.endsWith("TAIL_MARKER")).toBe(true);
});

test("apply(exit completed) updates status/exitCode/endedAt but keeps the entry for post-mortem inspection", () => {
  const store = new BackgroundJobStore();
  applyVisible(store);
  store.apply(EXIT("task-1-1001", "completed", { exitCode: 0 }));
  const entry = store.get("task-1-1001");
  expect(entry?.status).toBe("completed");
  expect(entry?.exitCode).toBe(0);
  expect(entry?.endedAt).toBe("2026-08-19T10:05:00.000Z");
  expect(store.list().map((e) => e.jobId)).toContain("task-1-1001");
});

test("AC8: apply(exit failed) renders failed with the exit code", () => {
  const store = new BackgroundJobStore();
  applyVisible(store, { jobId: "task-3-3003", pid: 3003 });
  store.apply(EXIT("task-3-3003", "failed", { exitCode: 2 }));
  expect(store.get("task-3-3003")).toMatchObject({ status: "failed", exitCode: 2 });
});

test("apply(exit) with status 'killed' is reflected the same way", () => {
  const store = new BackgroundJobStore();
  applyVisible(store, { jobId: "task-2-2002", pid: 2002 });
  store.apply(EXIT("task-2-2002", "killed", { killReason: "idle" }));
  expect(store.get("task-2-2002")?.status).toBe("killed");
});

test("apply(output)/apply(exit)/apply(phase) for an id with no prior start is a safe no-op", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "output", jobId: "ghost", chunk: "x", stream: "stdout" });
  store.apply(PHASE("ghost"));
  store.apply(EXIT("ghost", "completed", { exitCode: 0 }));
  expect(store.get("ghost")).toBeUndefined();
  expect(store.list()).toEqual([]);
});

test("subscribe is notified with the right hint kind for phase(start)/output/exit", () => {
  const store = new BackgroundJobStore();
  const hints: BackgroundJobStoreHint[] = [];
  const unsubscribe = store.subscribe((hint) => hints.push(hint));
  applyVisible(store);
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "x", stream: "stdout" });
  store.apply(EXIT("task-1-1001", "completed", { exitCode: 0 }));
  unsubscribe();
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "after-unsubscribe", stream: "stdout" });
  expect(hints).toEqual([
    { id: "task-1-1001", kind: "start" },
    { id: "task-1-1001", kind: "output" },
    { id: "task-1-1001", kind: "exit" },
  ]);
});

// --- AC9 (flow 173): the deliberate divergence from SubagentSessionStore ---

test("AC9: BackgroundJobStore exposes NO clear() method — unlike SubagentSessionStore, there is no bulk-reset a new-turn/`/clear` call site could invoke", () => {
  const store = new BackgroundJobStore();
  expect((store as unknown as { clear?: unknown }).clear).toBeUndefined();
});

// F-011 (flow 173 review fix-round): the real /clear|/new wiring guarantee is
// proven against source in `tui-shell.test.ts`; this test proves only the
// store's own contract — no public method other than removeAll() clears a
// running task's entry.
test("AC9: no method on BackgroundJobStore's public surface OTHER than removeAll() can ever clear a running job's entry", () => {
  const store = new BackgroundJobStore();
  applyVisible(store, { jobId: "long-running", pid: 9001, command: "tail -f app.log" });

  for (let i = 0; i < 5; i += 1) {
    store.apply({ type: "output", jobId: "long-running", chunk: `tick ${i}\n`, stream: "stdout" });
  }

  expect(store.get("long-running")).toBeDefined();
  expect(store.get("long-running")?.status).toBe("running");
  expect(store.list().map((e) => e.jobId)).toContain("long-running");
});

test("AC9: removeAll() is the ONE explicit session-teardown sweep that clears every entry, including still-running jobs", () => {
  const store = new BackgroundJobStore();
  applyVisible(store, { jobId: "job-a" });
  applyVisible(store, { jobId: "job-b", pid: 1002 });
  expect(store.list().length).toBe(2);
  const hints: BackgroundJobStoreHint[] = [];
  store.subscribe((hint) => hints.push(hint));

  store.removeAll();

  expect(store.list()).toEqual([]);
  expect(store.get("job-a")).toBeUndefined();
  expect(store.get("job-b")).toBeUndefined();
  expect(hints.length).toBeGreaterThan(0);
});

// --- format helpers --------------------------------------------------------

test("formatJobListHeader renders the count", () => {
  expect(formatJobListHeader(0)).toBe("Background Jobs 0");
  expect(formatJobListHeader(3)).toBe("Background Jobs 3");
});

test("formatJobRow includes the command and a status marker, clipped to width", () => {
  const store = new BackgroundJobStore();
  applyVisible(store, { command: "npm run dev -- --watch" });
  const entry = store.get("task-1-1001");
  if (entry === undefined) throw new Error("expected entry");
  const row = formatJobRow(entry, 24);
  expect(row.length).toBeLessThanOrEqual(24);
  expect(row).toContain("npm run dev");
});

test("AC8: formatJobRow renders a distinct glyph for running, completed, failed and killed", () => {
  const base: BackgroundJobEntry = {
    jobId: "task-1-1001",
    command: "npm run dev",
    pid: 1001,
    status: "running",
    startedAt: "2026-08-19T10:00:00.000Z",
    output: "",
  };
  const statuses = ["running", "completed", "failed", "killed"] as const;
  const glyphs = statuses.map((status) => {
    const row = formatJobRow({ ...base, status } as BackgroundJobEntry, 40);
    const glyph = row.split(" ")[0] ?? "";
    expect(glyph.length).toBeGreaterThan(0);
    expect(glyph).not.toBe("undefined");
    expect(row).toContain("npm run dev");
    return glyph;
  });
  expect(new Set(glyphs).size).toBe(statuses.length);
});

test("formatJobMeta reports id/pid/status/command", () => {
  const store = new BackgroundJobStore();
  applyVisible(store);
  store.apply(EXIT("task-1-1001", "completed", { exitCode: 0 }));
  const entry = store.get("task-1-1001");
  if (entry === undefined) throw new Error("expected entry");
  const meta = formatJobMeta(entry);
  expect(meta).toContain("task-1-1001");
  expect(meta).toContain("1001");
  expect(meta).toContain("completed");
  expect(meta).toContain("npm run dev");
});

test("AC4/AC8: a killed task carries its killReason onto the entry and into the Meta view", () => {
  // The whole point of splitting `killed` by reason is that the human can tell
  // "I stopped it" from "the idle rail gave up on it" — asserting only the
  // status would let the reason be dropped anywhere between event and view.
  const store = new BackgroundJobStore();
  applyVisible(store);
  store.apply(EXIT("task-1-1001", "killed", { killReason: "idle" }));
  const entry = store.get("task-1-1001");
  if (entry === undefined) throw new Error("expected entry");
  expect(entry.status).toBe("killed");
  expect(entry.killReason).toBe("idle");
  expect(formatJobMeta(entry)).toContain("idle");
});

test("formatJobOutput returns the entry's accumulated output", () => {
  const store = new BackgroundJobStore();
  applyVisible(store);
  store.apply({ type: "output", jobId: "task-1-1001", chunk: "hello world\n", stream: "stdout" });
  const entry = store.get("task-1-1001");
  if (entry === undefined) throw new Error("expected entry");
  expect(formatJobOutput(entry)).toContain("hello world");
});
