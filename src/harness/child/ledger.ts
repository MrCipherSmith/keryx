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

  constructor(initial: ParentRemainingBudget, limits: LedgerLimits = {}) {
    this.remainingBudget =
      initial.maxToolCalls !== undefined
        ? { maxRuntimeMs: initial.maxRuntimeMs, maxToolCalls: initial.maxToolCalls }
        : { maxRuntimeMs: initial.maxRuntimeMs };
    this.maxChildren = limits.maxChildren;
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
   * Admit one child reservation. On success the running remaining is decremented
   * and the child counter incremented; on ANY denial (count cap first, then the
   * fail-closed subset check) state is unchanged.
   */
  admit(request: BudgetReservation): LedgerAdmitResult {
    if (this.maxChildren !== undefined && this.admittedChildren >= this.maxChildren) {
      return { ok: false, reason: `child count cap ${this.maxChildren} reached` };
    }
    const granted = inheritBudget(this.remainingBudget, request);
    if (!granted.ok) {
      return { ok: false, reason: granted.reason };
    }
    this.remainingBudget = decrement(this.remainingBudget, granted.reservation);
    this.admittedChildren += 1;
    return { ok: true, reservation: granted.reservation };
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
