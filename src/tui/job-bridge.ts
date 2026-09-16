// Shell-task bridge: the task supervisor behind every `shell_exec` call (via
// its `onEvent` hook) → TUI Background Jobs sidebar / inspector. Since flow 263
// a task reaches the sidebar only once it has run longer than the yield and
// emitted its `phase` event — `background-job-session.ts` does that gating, so
// a short command never flashes through the panel.
// Structural mirror of `subagent-bridge.ts` (flow 162): a module-level
// `listener` variable set by the mounted TUI shell, and an `emit*` function
// the harness side calls with NO knowledge of whether a TUI is even mounted
// (readline sessions never register a listener — `emitBackgroundJob` is then
// a safe no-op).

import type { BackgroundJobEvent } from "../harness/tool/builtin/background-job-registry";

let listener: ((e: BackgroundJobEvent) => void) | undefined;

export function setBackgroundJobListener(fn: ((e: BackgroundJobEvent) => void) | undefined): void {
  listener = fn;
}

export function emitBackgroundJob(event: BackgroundJobEvent): void {
  try {
    listener?.(event);
  } catch {
    // never break the background job's own output pump
  }
}
