// Flow 173 (T4/T5) — job-bridge.ts: module-level event bridge from the
// harness's background-job runner to the TUI. Structural mirror of
// `subagent-bridge.ts` (flow 162): a module-level `listener` variable set by
// the mounted TUI shell, and an `emit*` function the harness side calls with
// NO knowledge of whether a TUI is even mounted (readline sessions never
// register a listener — `emitBackgroundJob` must be a safe no-op then).
//
// Does NOT exist yet — `background-job-registry.ts`'s own doc comment (T2/T3,
// already GREEN) names this exact extension point: `createJobRegistry`'s
// optional `onEvent?: (event: BackgroundJobEvent) => void` is "the exact
// 'emitBackgroundJob-shaped hook' plan.md's Step 2 anticipates" — this file
// is what a real TUI wiring passes as that `onEvent` callback.
//
// PINNED SHAPE (task-implementer builds exactly this):
//   import type { BackgroundJobEvent } from "../harness/tool/builtin/background-job-registry";
//   export function setBackgroundJobListener(fn: ((e: BackgroundJobEvent) => void) | undefined): void;
//   export function emitBackgroundJob(event: BackgroundJobEvent): void;
// `emitBackgroundJob` must never throw even if the registered listener
// throws (mirrors `emitSubagentFleet`'s own try/catch — "never break the
// agent turn"; here: never break the background job's own output pump).
import { expect, test } from "bun:test";
import type { BackgroundJobEvent } from "../harness/tool/builtin/background-job-registry";
import { emitBackgroundJob, setBackgroundJobListener } from "./job-bridge";

test("emitBackgroundJob is a no-op when no listener is registered (e.g. a readline session)", () => {
  setBackgroundJobListener(undefined);
  expect(() =>
    emitBackgroundJob({ type: "start", jobId: "job-1", pid: 111, command: "sleep 100", startedAt: "2026-08-19T00:00:00.000Z" }),
  ).not.toThrow();
});

test("setBackgroundJobListener registers a listener that receives every emitted event shape", () => {
  const received: BackgroundJobEvent[] = [];
  setBackgroundJobListener((e) => received.push(e));
  try {
    const start: BackgroundJobEvent = {
      type: "start",
      jobId: "job-2",
      pid: 222,
      command: "npm run dev",
      startedAt: "2026-08-19T00:00:01.000Z",
    };
    const output: BackgroundJobEvent = { type: "output", jobId: "job-2", chunk: "listening on :3000\n", stream: "stdout" };
    const exit: BackgroundJobEvent = { type: "exit", jobId: "job-2", status: "exited", exitCode: 0, endedAt: "2026-08-19T00:05:00.000Z" };
    emitBackgroundJob(start);
    emitBackgroundJob(output);
    emitBackgroundJob(exit);
    expect(received).toEqual([start, output, exit]);
  } finally {
    setBackgroundJobListener(undefined);
  }
});

test("setBackgroundJobListener(undefined) removes a previously registered listener", () => {
  const received: BackgroundJobEvent[] = [];
  setBackgroundJobListener((e) => received.push(e));
  setBackgroundJobListener(undefined);
  emitBackgroundJob({ type: "start", jobId: "job-3", pid: 333, command: "tail -f log", startedAt: "2026-08-19T00:00:02.000Z" });
  expect(received).toEqual([]);
});

test("emitBackgroundJob never throws even when the registered listener itself throws", () => {
  setBackgroundJobListener(() => {
    throw new Error("boom");
  });
  try {
    expect(() =>
      emitBackgroundJob({ type: "exit", jobId: "job-4", status: "killed", endedAt: "2026-08-19T00:00:03.000Z" }),
    ).not.toThrow();
  } finally {
    setBackgroundJobListener(undefined);
  }
});

test("a fresh setBackgroundJobListener call replaces the previous listener, not adds a second one", () => {
  const firstCalls: BackgroundJobEvent[] = [];
  const secondCalls: BackgroundJobEvent[] = [];
  setBackgroundJobListener((e) => firstCalls.push(e));
  setBackgroundJobListener((e) => secondCalls.push(e));
  try {
    const event: BackgroundJobEvent = { type: "start", jobId: "job-5", pid: 555, command: "watch build", startedAt: "2026-08-19T00:00:04.000Z" };
    emitBackgroundJob(event);
    expect(secondCalls).toEqual([event]);
    expect(firstCalls).toEqual([]);
  } finally {
    setBackgroundJobListener(undefined);
  }
});
