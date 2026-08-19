// Background-job bridge: `shell_exec({background:true})` runner (via
// `JobRegistry`'s `onEvent` hook) → TUI Background Jobs sidebar / inspector.
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
