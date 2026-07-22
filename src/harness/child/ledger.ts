// Run-scoped shared budget + child-count ledger (flow 090, multi-agent engine
// Phase 3 / AC1, AC2).
//
// `inheritBudget` (./isolation) proves a SINGLE child reservation is a subset of
// a static remaining budget, but explicitly disclaims aggregate accounting:
// "Aggregate accounting across multiple children is the CALLER's responsibility."
// Two independent `spawnChild` calls each measured against the same static
// parent-remaining would each pass and TOGETHER over-grant.
//
// `RemainingBudgetLedger` is that single caller-side authority. It is the ONE
// mutable object a parent threads through every spawn path — `planWaves`
// reservations AND ad-hoc `spawnChild` — decrementing a running remaining budget
// so the sum of admitted reservations can never exceed the parent's original
// budget (fail-closed), and enforcing an optional total child-count cap.
//
// Determinism: no clock/RNG/network/fs. State transitions are a pure function of
// the admit sequence; the same sequence yields the same decisions. Reuses the
// frozen `inheritBudget` subset check verbatim — the ledger only owns aggregation.
import { inheritBudget } from "./isolation";
import type { BudgetReservation, ParentRemainingBudget } from "./isolation";

/** Optional ceilings enforced by the ledger beyond the running budget. */
export interface LedgerLimits {
  /** Maximum total children admitted over the ledger's lifetime. */
  maxChildren?: number;
  /**
   * Optional provider-neutral cost ceiling (flow 101). When set, the ledger
   * decrements a cost dimension by each reservation's `costUnits` and denies a
   * reservation whose cost would breach the remaining ceiling. When absent, cost
   * is not tracked at all (byte-for-byte the pre-hook behavior).
   */
  maxCostUnits?: number;
}

/** Result of {@link RemainingBudgetLedger.admit}: a granted reservation or a denial. */
export type LedgerAdmitResult =
  | { ok: true; reservation: BudgetReservation }
  | { ok: false; reason: string };

/** Decrement a running remaining budget by a granted reservation (mirrors the scheduler fold). */
function decrement(
  remaining: ParentRemainingBudget,
  reservation: BudgetReservation,
): ParentRemainingBudget {
  const maxRuntimeMs = remaining.maxRuntimeMs - reservation.maxRuntimeMs;
  if (remaining.maxToolCalls !== undefined && reservation.maxToolCalls !== undefined) {
    return { maxRuntimeMs, maxToolCalls: remaining.maxToolCalls - reservation.maxToolCalls };
  }
  return remaining.maxToolCalls !== undefined
    ? { maxRuntimeMs, maxToolCalls: remaining.maxToolCalls }
    : { maxRuntimeMs };
}

/**
 * The single run-scoped authority that aggregates child budget reservations and
 * child count across every spawn path. Fail-closed: an admission that would
 * breach the running remaining budget (via {@link inheritBudget}) or the
 * `maxChildren` cap is DENIED and leaves ledger state UNCHANGED (no partial
 * decrement, no count increment).
 */
export class RemainingBudgetLedger {
  private remainingBudget: ParentRemainingBudget;
  private admittedChildren = 0;
  private readonly maxChildren: number | undefined;
  /** Remaining cost budget; `undefined` when cost is not tracked (no ceiling). */
  private costUnitsRemaining: number | undefined;
  /** Live grants, keyed by reservation id, so a release can be bounded by them. */
  private readonly outstanding = new Map<string, BudgetReservation>();

  constructor(initial: ParentRemainingBudget, limits: LedgerLimits = {}) {
    this.remainingBudget =
      initial.maxToolCalls !== undefined
        ? { maxRuntimeMs: initial.maxRuntimeMs, maxToolCalls: initial.maxToolCalls }
        : { maxRuntimeMs: initial.maxRuntimeMs };
    this.maxChildren = limits.maxChildren;
    this.costUnitsRemaining = limits.maxCostUnits;
  }

  /** Remaining cost budget, or `undefined` when cost is not tracked. */
  get costRemaining(): number | undefined {
    return this.costUnitsRemaining;
  }

  /** A copy of the currently-remaining budget (never the internal reference). */
  get remaining(): ParentRemainingBudget {
    return this.remainingBudget.maxToolCalls !== undefined
      ? { maxRuntimeMs: this.remainingBudget.maxRuntimeMs, maxToolCalls: this.remainingBudget.maxToolCalls }
      : { maxRuntimeMs: this.remainingBudget.maxRuntimeMs };
  }

  /** How many children have been admitted so far. */
  get childCount(): number {
    return this.admittedChildren;
  }

  /**
   * Admit one child reservation. All checks run BEFORE any mutation, so ANY
   * denial (count cap, then the fail-closed runtime/tool-call subset check via
   * `inheritBudget`, then the optional cost ceiling) leaves ledger state entirely
   * unchanged. On success the running budget, cost (when tracked), and child
   * counter are decremented together.
   */
  admit(request: BudgetReservation): LedgerAdmitResult {
    if (this.maxChildren !== undefined && this.admittedChildren >= this.maxChildren) {
      return { ok: false, reason: `child count cap ${this.maxChildren} reached` };
    }
    const granted = inheritBudget(this.remainingBudget, request);
    if (!granted.ok) {
      return { ok: false, reason: granted.reason };
    }
    // Cost ceiling (only when tracked). `costUnits` is a caller estimate that
    // `inheritBudget` deliberately ignores; the ledger owns its aggregation.
    const cost = request.costUnits ?? 0;
    if (this.costUnitsRemaining !== undefined && cost > this.costUnitsRemaining) {
      return {
        ok: false,
        reason: `cost cap exceeded: reservation costUnits ${cost} > remaining ${this.costUnitsRemaining}`,
      };
    }

    this.remainingBudget = decrement(this.remainingBudget, granted.reservation);
    this.admittedChildren += 1;
    this.outstanding.set(granted.reservation.reservationId, granted.reservation);
    if (this.costUnitsRemaining !== undefined) {
      this.costUnitsRemaining -= cost;
    }
    return {
      ok: true,
      reservation:
        request.costUnits !== undefined
          ? { ...granted.reservation, costUnits: request.costUnits }
          : granted.reservation,
    };
  }

  /**
   * Return the UNUSED remainder of a finished child's reservation.
   *
   * Without this, a reservation is a permanent debit rather than a reservation:
   * a child that ran for two seconds still held its whole five-minute grant, so
   * an interactive session could start only three children before the runtime
   * budget was exhausted — with the child-count cap never approached (stress
   * finding M1).
   *
   * Bounded and fail-closed in both directions:
   * - the refund never exceeds what was granted, so an under-reported `used`
   *   cannot inflate the parent's budget beyond its original total;
   * - a negative `used` is clamped to zero;
   * - the reservation is dropped after the first release, so a repeated or
   *   duplicated call cannot refund twice;
   * - an unknown reservation id is a no-op.
   *
   * `maxChildren` is a LIFETIME cap on children started and is deliberately not
   * undone: finishing a child does not buy the right to start another.
   *
   * Deterministic — the caller measures the actual consumption and passes it;
   * the ledger still reads no clock.
   */
  release(reservationId: string, used: { maxRuntimeMs?: number; maxToolCalls?: number }): void {
    const granted = this.outstanding.get(reservationId);
    if (granted === undefined) {
      return;
    }
    this.outstanding.delete(reservationId);

    const usedRuntime = Math.max(0, used.maxRuntimeMs ?? granted.maxRuntimeMs);
    const refundRuntime = Math.max(0, granted.maxRuntimeMs - usedRuntime);

    if (this.remainingBudget.maxToolCalls !== undefined && granted.maxToolCalls !== undefined) {
      const usedCalls = Math.max(0, used.maxToolCalls ?? granted.maxToolCalls);
      const refundCalls = Math.max(0, granted.maxToolCalls - usedCalls);
      this.remainingBudget = {
        maxRuntimeMs: this.remainingBudget.maxRuntimeMs + refundRuntime,
        maxToolCalls: this.remainingBudget.maxToolCalls + refundCalls,
      };
      return;
    }
    this.remainingBudget =
      this.remainingBudget.maxToolCalls !== undefined
        ? {
            maxRuntimeMs: this.remainingBudget.maxRuntimeMs + refundRuntime,
            maxToolCalls: this.remainingBudget.maxToolCalls,
          }
        : { maxRuntimeMs: this.remainingBudget.maxRuntimeMs + refundRuntime };
  }

  /**
   * Admit a whole `planWaves` plan's reservations in order. Folds {@link admit}
   * across every wave; the FIRST denial short-circuits and returns it (callers
   * that need all-or-nothing should check `ok` before acting). Reservations
   * already admitted before a mid-plan denial stay decremented — the plan-level
   * subset guarantee is `planWaves`' job; the ledger only guarantees no
   * over-grant beyond the original budget.
   */
  admitWaves(waves: ReadonlyArray<{ reservations: readonly BudgetReservation[] }>): LedgerAdmitResult {
    let last: LedgerAdmitResult = { ok: true, reservation: { reservationId: "none", maxRuntimeMs: 0 } };
    for (const wave of waves) {
      for (const reservation of wave.reservations) {
        last = this.admit(reservation);
        if (!last.ok) return last;
      }
    }
    return last;
  }
}
