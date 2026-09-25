// Flow 331, AC5/AC6 — the benchmark's cost cap.
//
// HOW "ABORTS BEFORE EXCEEDING IT" WORKS HERE: a component's Jev spend is
// only known once the component has finished running (`keryx review
// ci-triage --eval --live`, for instance, is one external process whose
// cost is reported in its own JSON at the end — there is no mid-flight hook
// to interrupt). So the cap is enforced in two places, not one:
//
//   1. PRE-FLIGHT (`assertEstimateWithinCap`): every live component is run
//      offline first (`run.ts` does this unconditionally — the offline
//      result IS the cost estimate, because the same tokens go to Jev
//      either way, offline just replays a recorded answer instead of
//      fetching a fresh one). If replaying the offline fixtures already
//      costed more than the cap allows, live mode is refused before a
//      single live network call is made.
//   2. POST-FLIGHT (`CostCapTracker.record`): every completed component's
//      REAL usage is added to a running total. The moment adding one more
//      component's usage would cross the cap, `record` throws before that
//      total is accepted — the caller (`run.ts`) catches this, discards the
//      just-finished component's contribution to the committed results,
//      and stops running further live components. A run that broke the cap
//      never gets its results written to `bench/jev-review/results-*`.
export const DEFAULT_MAX_COST_USD = 0.1;
export const DEFAULT_MAX_CALLS = 300;

export interface CostCapConfig {
  readonly maxCostUsd: number;
  readonly maxCalls: number;
}

export function defaultCostCap(): CostCapConfig {
  return { maxCostUsd: DEFAULT_MAX_COST_USD, maxCalls: DEFAULT_MAX_CALLS };
}

export class CostCapExceededError extends Error {
  constructor(
    readonly dimension: "cost" | "calls",
    readonly attempted: number,
    readonly limit: number,
  ) {
    const unit = dimension === "cost" ? "USD" : "calls";
    super(
      `bench/jev-review cost cap exceeded: ${dimension} would reach ${attempted}${dimension === "cost" ? "" : ` ${unit}`} against a limit of ${limit}${dimension === "cost" ? " USD" : ` ${unit}`} — refusing to commit this run's results.`,
    );
    this.name = "CostCapExceededError";
  }
}

export interface UsageLike {
  readonly cost: number;
  readonly jevCalls: number;
}

export class CostCapTracker {
  private costUsd = 0;
  private calls = 0;

  constructor(private readonly config: CostCapConfig = defaultCostCap()) {}

  /** Adds `usage` to the running total, or throws {@link CostCapExceededError} and adds nothing. */
  record(usage: UsageLike): void {
    const nextCost = this.costUsd + usage.cost;
    const nextCalls = this.calls + usage.jevCalls;
    if (nextCost > this.config.maxCostUsd) throw new CostCapExceededError("cost", nextCost, this.config.maxCostUsd);
    if (nextCalls > this.config.maxCalls) throw new CostCapExceededError("calls", nextCalls, this.config.maxCalls);
    this.costUsd = nextCost;
    this.calls = nextCalls;
  }

  get totals(): { readonly costUsd: number; readonly calls: number } {
    return { costUsd: this.costUsd, calls: this.calls };
  }
}

/**
 * The pre-flight half: refuse to attempt a live run at all when the offline
 * estimate (the same component, replayed) already implies breaking the cap.
 * `safetyFactor` inflates the estimate — a live call's real token count can
 * differ slightly from the recorded fixture it replays offline — so this
 * refuses a little earlier than strictly necessary rather than a little
 * later.
 */
export function assertEstimateWithinCap(
  estimatedUsage: UsageLike,
  config: CostCapConfig = defaultCostCap(),
  safetyFactor = 2,
): void {
  const projectedCost = estimatedUsage.cost * safetyFactor;
  const projectedCalls = estimatedUsage.jevCalls;
  if (projectedCost > config.maxCostUsd) {
    throw new CostCapExceededError("cost", projectedCost, config.maxCostUsd);
  }
  if (projectedCalls > config.maxCalls) {
    throw new CostCapExceededError("calls", projectedCalls, config.maxCalls);
  }
}
