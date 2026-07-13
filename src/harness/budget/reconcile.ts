// Fail-closed budget reconciliation (flow 017, W15 / H-01, reviewer track:
// security). Closes the AC4 deferred @release-0 concern: reconcile a
// planned/reserved/consumed budget into a `remaining` figure, tagged with the
// W7 source-reliability vocabulary, and FAIL CLOSED on over-consumption, an
// over-reservation, or a negative input (SC_R16_BUDGET_RESERVATION).
//
// PURE and deterministic: reads only its input, mutates nothing, and has NO
// `Date.now`/`Math.random`/network/fs. Same input twice -> deep-equal output.
// Reuses `SourceReliability` (W7) rather than inventing a new vocabulary.
import type { SourceReliability } from "../context/manifest";

/** A planned/reserved/consumed budget to reconcile, tagged with source reliability. */
export interface ReconcileBudgetInput {
  planned: number;
  reserved: number;
  consumed: number;
  reliability: SourceReliability;
}

/** A reconciliation decision: the remaining budget, or a fail-closed denial. */
export type ReconcileBudgetResult =
  | { ok: true; remaining: number; reliability: SourceReliability }
  | { ok: false; reason: string };

/**
 * Reconcile `planned`/`reserved`/`consumed` into `remaining = reserved -
 * consumed`, passing `reliability` through unchanged on the ok path.
 *
 * Fail-closed (SC_R16_BUDGET_RESERVATION), boundary-equal permitted:
 *   - any negative `planned`/`reserved`/`consumed` -> deny
 *   - `reserved > planned` (a reservation cannot exceed the plan) -> deny
 *   - `consumed > reserved` (would produce a negative remaining) -> deny
 * Pure and deterministic.
 */
export function reconcileBudget(input: ReconcileBudgetInput): ReconcileBudgetResult {
  const { planned, reserved, consumed, reliability } = input;

  if (planned < 0 || reserved < 0 || consumed < 0) {
    return { ok: false, reason: "Budget denied: planned, reserved, and consumed must be non-negative." };
  }
  if (reserved > planned) {
    return { ok: false, reason: "Budget denied: reserved exceeds planned." };
  }
  if (consumed > reserved) {
    return { ok: false, reason: "Budget denied: consumed exceeds reserved (over-consumption)." };
  }

  return { ok: true, remaining: reserved - consumed, reliability };
}
