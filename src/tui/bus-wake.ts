// Flow 274 (agent bus P3, T7; specification §5.3): the TUI's bus-wake
// decision, factored out of `tui-shell.ts` as a small pure function so it is
// unit-testable without a renderer. Mirrors the existing task-notification
// wake (`resolveMaxAutoWake`, `consecutiveAutoWakes` — see
// `deps.jobRegistry?.onCompletion` in `tui-shell.ts`): a bus wake shares the
// SAME counter and the SAME cap, it just has its own eligibility source
// (`BusInbox.hasWakeEligible()` — specification §4.2 — instead of a finished
// task).

export interface BusWakeInput {
  /**
   * `!chrome.isBusy() && !foregroundOperation.isActive && mainQueue.length === 0`
   * (specification §5.3) — the SAME idle test the task-notification wake
   * uses. The caller is responsible for also checking the "destroyed" guard
   * (Ctrl+C) before ever constructing this input; this function has no
   * renderer to ask.
   */
  idle: boolean;
  /** `busInbox.hasWakeEligible()` (specification §4.2: question/reply/handoff, or a notice addressed by name — never a broadcast). */
  eligible: boolean;
  /** The current `consecutiveAutoWakes` count. */
  wakes: number;
  /** `resolveMaxAutoWake()`. */
  cap: number;
}

/**
 * - `"none"`: not idle, or nothing wake-eligible pending — do nothing.
 * - `"capped"`: idle and eligible, but `wakes >= cap` — print the capped
 *   message; do NOT increment the counter and do NOT start a turn (the
 *   message stays queued in the inbox for the next real turn to drain).
 * - `"wake"`: idle, eligible, under the cap — increment the counter and call
 *   `runLine("", "bus-message")`.
 */
export type BusWakeDecision = "none" | "capped" | "wake";

/** Pure decision table (specification §5.3) — see {@link BusWakeInput} for each field's meaning. */
export function decideBusWake(input: BusWakeInput): BusWakeDecision {
  if (!input.idle || !input.eligible) return "none";
  if (input.wakes >= input.cap) return "capped";
  return "wake";
}
