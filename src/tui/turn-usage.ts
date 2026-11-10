// One turn's usage accounting for the TUI shell (flow 483).
//
// The shell used to WRAP `io.onUsage` inside every `runLine` and never restore it. `io` lives for the
// whole shell, so the wrappers stacked up: a usage event on turn N went through N wrappers and each one
// called `usageTracker.addUsage`, counting turn N's tokens N times (session totals and cost in the footer
// and `/status` grew faster than the real spend). The oldest wrapper also rewrote the per-turn footer
// figures from its own cumulative closure.
//
// Now the hook is installed ONCE per shell (`installTurnUsageSink`) and forwards to whichever turn sink is
// current; a turn swaps its sink in and out instead of wrapping `io` again.

import type { UsageReport, UsageTracker } from "./usage-tracker";

export interface TurnUsageSinkSlot<U extends UsageReport> {
  /** Make `sink` the current turn's receiver, replacing any previous one. */
  set(sink: (usage: U) => void): void;
  /** Drop `sink` — only if it is still the current one, so a late turn cannot unseat the next. */
  clear(sink: (usage: U) => void): void;
}

/**
 * Wrap `io.onUsage` once. The existing hook runs first (transcript line, context counter), then the
 * current turn sink, so the sink sees the state those hooks already updated.
 */
export function installTurnUsageSink<U extends UsageReport>(io: {
  onUsage?: ((usage: U) => void) | undefined;
}): TurnUsageSinkSlot<U> {
  const base = io.onUsage?.bind(io);
  let current: ((usage: U) => void) | undefined;
  io.onUsage = (usage) => {
    base?.(usage);
    current?.(usage);
  };
  return {
    set: (sink) => {
      current = sink;
    },
    clear: (sink) => {
      if (current === sink) current = undefined;
    },
  };
}

/** One turn's token sums. Cache counters are SUBSETS of `input`, never added to it. */
export interface TurnUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TurnUsage {
  readonly totals: Readonly<TurnUsageTotals>;
  /** Feed one provider usage report: sums it, prices the turn so far, tells the tracker. */
  onUsage(usage: UsageReport): void;
}

export function createTurnUsage(opts: {
  /** Read fresh on every report: `/new`, `/clear` and `/resume` replace the tracker. */
  tracker: () => Pick<UsageTracker, "addUsage" | "setTurnCost">;
  /** The turn's cost so far, or undefined when the model has no known price. */
  cost: (totals: Readonly<TurnUsageTotals>) => number | undefined;
  /** Called after each report with the new totals and cost (the busy footer repaints from it). */
  onUpdate?: (totals: Readonly<TurnUsageTotals>, costUsd: number | undefined) => void;
}): TurnUsage {
  const totals: TurnUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    totals,
    onUsage(usage) {
      totals.input += usage.inputTokens ?? 0;
      totals.output += usage.outputTokens ?? 0;
      totals.cacheRead += usage.cacheReadTokens ?? 0;
      totals.cacheWrite += usage.cacheWriteTokens ?? 0;
      const costUsd = opts.cost(totals);
      const tracker = opts.tracker();
      tracker.addUsage(usage);
      tracker.setTurnCost(costUsd);
      opts.onUpdate?.(totals, costUsd);
    },
  };
}
