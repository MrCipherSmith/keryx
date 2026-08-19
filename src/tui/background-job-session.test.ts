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
// parent turn, and `/clear`/`/new` (see `subagent-session.ts`'s own header
// comment and `tui-shell.ts`'s `sessions.clear()` call sites). A
// `BackgroundJobStore` with an equivalent `clear()` would invite exactly
// that same call site to be added later, silently reintroducing the bug
// this flow's whole design exists to avoid. So `BackgroundJobStore`
// deliberately has NO `clear()` at all — only `removeAll()`, a distinctly
// named session-TEARDOWN sweep meant to be called from exactly one place
// (the real session-exit path, alongside `JobRegistry.sweepAll()` — see
// `shell.test.ts`/`tui-shell.test.ts`'s AC7 audits), never from a per-turn
// or `/clear` code path.
//
// Does NOT exist yet.
//
// PINNED SHAPE (task-implementer builds exactly this; adjust only if a
// genuinely better shape is found, and flag it in journal.md if so):
//   export type BackgroundJobEntry = {
//     jobId: string; command: string; pid: number;
//     status: "running" | "exited" | "killed";
//     startedAt: string; endedAt?: string; exitCode?: number;
//     output: string; // bounded ring, see MAX_BACKGROUND_JOB_OUTPUT_CHARS
//   };
//   export type BackgroundJobStoreHint = { id: string; kind: "start" | "output" | "exit" };
//   export const MAX_BACKGROUND_JOB_OUTPUT_CHARS = 20_000;
//   export class BackgroundJobStore {
//     apply(event: BackgroundJobEvent): void;
//     get(jobId: string): BackgroundJobEntry | undefined;
//     list(): BackgroundJobEntry[];
//     subscribe(listener: (hint: BackgroundJobStoreHint) => void): () => void;
//     removeAll(): void; // session-teardown sweep ONLY — see divergence note above
//   }
//   export function formatJobListHeader(count: number): string; // "Background Jobs N"
//   export function formatJobRow(entry: BackgroundJobEntry, width?: number): string;
//   export function formatJobMeta(entry: BackgroundJobEntry, now?: number): string;
//   export function formatJobOutput(entry: BackgroundJobEntry): string;
import { expect, test } from "bun:test";
import type { BackgroundJobEvent } from "../harness/tool/builtin/background-job-registry";
import {
  BackgroundJobStore,
  formatJobListHeader,
  formatJobMeta,
  formatJobOutput,
  formatJobRow,
  MAX_BACKGROUND_JOB_OUTPUT_CHARS,
  type BackgroundJobStoreHint,
} from "./background-job-session";

const START = (over: Partial<Extract<BackgroundJobEvent, { type: "start" }>> = {}): BackgroundJobEvent => ({
  type: "start",
  jobId: "job-1",
  pid: 1001,
  command: "npm run dev",
  startedAt: "2026-08-19T10:00:00.000Z",
  ...over,
});

test("apply(start) creates a new running entry, visible via get() and list()", () => {
  const store = new BackgroundJobStore();
  store.apply(START());
  expect(store.get("job-1")).toMatchObject({
    jobId: "job-1",
    pid: 1001,
    command: "npm run dev",
    status: "running",
  });
  expect(store.list().map((e) => e.jobId)).toEqual(["job-1"]);
});

test("apply(output) appends the chunk to the entry's output", () => {
  const store = new BackgroundJobStore();
  store.apply(START());
  store.apply({ type: "output", jobId: "job-1", chunk: "compiling…\n", stream: "stdout" });
  store.apply({ type: "output", jobId: "job-1", chunk: "done\n", stream: "stdout" });
  expect(store.get("job-1")?.output).toBe("compiling…\ndone\n");
});

test("output is bounded to MAX_BACKGROUND_JOB_OUTPUT_CHARS, keeping the TAIL (most recent) output", () => {
  const store = new BackgroundJobStore();
  store.apply(START());
  store.apply({ type: "output", jobId: "job-1", chunk: "a".repeat(MAX_BACKGROUND_JOB_OUTPUT_CHARS), stream: "stdout" });
  store.apply({ type: "output", jobId: "job-1", chunk: "TAIL_MARKER", stream: "stdout" });
  const output = store.get("job-1")?.output ?? "";
  expect(output.length).toBeLessThanOrEqual(MAX_BACKGROUND_JOB_OUTPUT_CHARS);
  expect(output.endsWith("TAIL_MARKER")).toBe(true);
});

test("apply(exit) updates status/exitCode/endedAt but keeps the entry in the store for post-mortem inspection", () => {
  const store = new BackgroundJobStore();
  store.apply(START());
  store.apply({ type: "exit", jobId: "job-1", status: "exited", exitCode: 0, endedAt: "2026-08-19T10:05:00.000Z" });
  const entry = store.get("job-1");
  expect(entry?.status).toBe("exited");
  expect(entry?.exitCode).toBe(0);
  expect(entry?.endedAt).toBe("2026-08-19T10:05:00.000Z");
  // Not removed — a finished job's final output/exit code must stay
  // inspectable, same as a subagent's "done" status stays visible until an
  // explicit clear (here: only removeAll()).
  expect(store.list().map((e) => e.jobId)).toContain("job-1");
});

test("apply(exit) with status 'killed' is reflected the same way", () => {
  const store = new BackgroundJobStore();
  store.apply(START({ jobId: "job-2", pid: 2002 }));
  store.apply({ type: "exit", jobId: "job-2", status: "killed", endedAt: "2026-08-19T10:01:00.000Z" });
  expect(store.get("job-2")?.status).toBe("killed");
});

test("apply(output)/apply(exit) for an id with no prior start is a safe no-op", () => {
  const store = new BackgroundJobStore();
  store.apply({ type: "output", jobId: "ghost", chunk: "x", stream: "stdout" });
  store.apply({ type: "exit", jobId: "ghost", status: "exited", endedAt: "2026-08-19T10:00:00.000Z" });
  expect(store.get("ghost")).toBeUndefined();
  expect(store.list()).toEqual([]);
});

test("subscribe is notified with the right hint kind for start/output/exit", () => {
  const store = new BackgroundJobStore();
  const hints: BackgroundJobStoreHint[] = [];
  const unsubscribe = store.subscribe((hint) => hints.push(hint));
  store.apply(START());
  store.apply({ type: "output", jobId: "job-1", chunk: "x", stream: "stdout" });
  store.apply({ type: "exit", jobId: "job-1", status: "exited", endedAt: "2026-08-19T10:00:01.000Z" });
  unsubscribe();
  store.apply({ type: "output", jobId: "job-1", chunk: "after-unsubscribe", stream: "stdout" });
  expect(hints).toEqual([
    { id: "job-1", kind: "start" },
    { id: "job-1", kind: "output" },
    { id: "job-1", kind: "exit" },
  ]);
});

// --- AC9: the deliberate divergence from SubagentSessionStore -------------

test("AC9: BackgroundJobStore exposes NO clear() method — unlike SubagentSessionStore, there is no bulk-reset a new-turn/`/clear` call site could invoke", () => {
  const store = new BackgroundJobStore();
  expect((store as unknown as { clear?: unknown }).clear).toBeUndefined();
});

// F-011 (review fix-round): the ORIGINAL version of this test applied a loop
// of `output` events and checked the entry still existed — that only
// re-proves "output events don't delete entries," which the format-helper
// and store tests elsewhere in this file already cover; it never simulated
// an actual turn boundary or `/clear`/`/new` dispatch, so it did not test
// what its name claimed. `BackgroundJobStore` has no `clear()` BY DESIGN
// (the test above), so there is no store-level "new turn" event to simulate
// in the first place — the real guarantee AC9 needs lives at the WIRING
// layer: does anything on the real `/clear`|`/new` code path in
// `tui-shell.ts` ever reach `jobs.removeAll()`? That is now proven directly
// against the real source in `tui-shell.test.ts`'s
// "flow 173 F-002/AC7/AC9 — background-job sweep fires at every real exit
// path, never on /clear|/new" describe block ("AC9: /clear|/new does NOT
// sweep or purge background jobs"), which slices the real `/clear`|`/new`
// branch and asserts neither `sweepBackgroundJobs` nor `removeAll` appears
// in it. `launchTuiAgentShell` has no headless dispatch-injection seam (see
// that file's own header comment — every other closure in it is audited the
// same source-text way), so a fully driven end-to-end "type /clear, assert
// the sidebar still lists the job" test is a larger, separate test-harness
// investment, not a same-round fix; flagged in journal.md as a follow-up.
//
// What THIS test legitimately proves, scoped to the store's own contract:
// the store's public surface has no bulk-reset method reachable at all
// (`removeAll()` — the ONE exception — is exercised and asserted separately
// below), so no sequence of the OTHER public methods can ever clear a
// running job's entry, regardless of how many times they are called.
test("AC9: no method on BackgroundJobStore's public surface OTHER than removeAll() can ever clear a running job's entry", () => {
  const store = new BackgroundJobStore();
  store.apply(START({ jobId: "long-running", pid: 9001, command: "tail -f app.log" }));

  for (let i = 0; i < 5; i += 1) {
    store.apply({ type: "output", jobId: "long-running", chunk: `tick ${i}\n`, stream: "stdout" });
  }

  expect(store.get("long-running")).toBeDefined();
  expect(store.get("long-running")?.status).toBe("running");
  expect(store.list().map((e) => e.jobId)).toContain("long-running");
});

test("AC9: removeAll() is the ONE explicit session-teardown sweep that clears every entry, including still-running jobs", () => {
  const store = new BackgroundJobStore();
  store.apply(START({ jobId: "job-a" }));
  store.apply(START({ jobId: "job-b", pid: 1002 }));
  expect(store.list().length).toBe(2);
  const hints: BackgroundJobStoreHint[] = [];
  store.subscribe((hint) => hints.push(hint));

  store.removeAll();

  expect(store.list()).toEqual([]);
  expect(store.get("job-a")).toBeUndefined();
  expect(store.get("job-b")).toBeUndefined();
  expect(hints.length).toBeGreaterThan(0);
});

// --- format helpers (mirror formatSubagentRow/formatSubagentMeta/formatSubagentWork) --

test("formatJobListHeader renders the count", () => {
  expect(formatJobListHeader(0)).toBe("Background Jobs 0");
  expect(formatJobListHeader(3)).toBe("Background Jobs 3");
});

test("formatJobRow includes the command and a status marker, clipped to width", () => {
  const store = new BackgroundJobStore();
  store.apply(START({ command: "npm run dev -- --watch" }));
  const entry = store.get("job-1");
  if (entry === undefined) throw new Error("expected entry");
  const row = formatJobRow(entry, 24);
  expect(row.length).toBeLessThanOrEqual(24);
  expect(row).toContain("npm run dev");
});

test("formatJobMeta reports id/pid/status/command", () => {
  const store = new BackgroundJobStore();
  store.apply(START());
  store.apply({ type: "exit", jobId: "job-1", status: "exited", exitCode: 0, endedAt: "2026-08-19T10:05:00.000Z" });
  const entry = store.get("job-1");
  if (entry === undefined) throw new Error("expected entry");
  const meta = formatJobMeta(entry);
  expect(meta).toContain("job-1");
  expect(meta).toContain("1001");
  expect(meta).toContain("exited");
  expect(meta).toContain("npm run dev");
});

test("formatJobOutput returns the entry's accumulated output", () => {
  const store = new BackgroundJobStore();
  store.apply(START());
  store.apply({ type: "output", jobId: "job-1", chunk: "hello world\n", stream: "stdout" });
  const entry = store.get("job-1");
  if (entry === undefined) throw new Error("expected entry");
  expect(formatJobOutput(entry)).toContain("hello world");
});
