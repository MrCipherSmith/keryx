// Adaptive model escalation policy (flow 094, multi-agent engine Phase 5).
//
// "Try cheap, escalate on evidence": a dispatch declares a model LADDER
// (low→high, e.g. cheap→standard→deep). A pure classifier picks the starting
// rung from the task description; a pure predicate decides — from the canonical
// `subagent-result` disposition — whether to escalate; and a driver runs rungs
// (each a new `attempt.number` on the SAME `branchId`), emitting `tier_escalated`
// decision events and admitting each rung's reservation to the shared
// `RemainingBudgetLedger` so the ladder SELF-TRUNCATES when budget runs out.
//
// This module is a pure decision layer: the actual rung execution is injected via
// `deps.runRung`, so the whole thing is deterministic and offline-testable — no
// clock/RNG/network/fs (timestamps/ids come from injected `deps.clock`/`idSeq`).
// It reuses the existing attempt/branch + ledger + tier machinery; no new
// subsystem.
import type { CanonicalSubagentResult } from "./contract";
import type { BudgetReservation } from "./isolation";
import type { RemainingBudgetLedger } from "./ledger";

/** Why an escalation fired. Mirrors the `trigger` on `tier_escalated`. */
export type EscalationTrigger =
  | "status:NEEDS_CONTEXT"
  | "status:BLOCKED"
  | "status:FAILED"
  | "acceptance:not_met"
  | "metrics-threshold";

/** High-signal terms that route a task to the strongest tier. */
const HIGH_SIGNAL: readonly RegExp[] = [
  /\bcritical\b/i,
  /\bsecurity\b/i,
  /\bvulnerab/i,
  /\bproduction\b/i,
  /\bincident\b/i,
  /\bdata[- ]?loss\b/i,
  /\burgent\b/i,
];

/** Low-signal terms that route a task to the cheapest tier. */
const LOW_SIGNAL: readonly RegExp[] = [
  /\btrivial\b/i,
  /\btypo\b/i,
  /\brename\b/i,
  /\bformat(ting)?\b/i,
  /\bwhitespace\b/i,
  /\bcomment\b/i,
  /\bsimple\b/i,
];

/**
 * Pick the starting tier for a task from its description. `tierOrder` is low→high.
 * High-signal terms pick the highest tier, low-signal terms the lowest, and
 * anything else the middle (default) tier. Pure and deterministic. Throws only on
 * an empty `tierOrder` (a ladder must have at least one rung).
 */
export function classifyInitialTier(description: string, tierOrder: readonly string[]): string {
  if (tierOrder.length === 0) {
    throw new Error("classifyInitialTier: tierOrder must have at least one tier");
  }
  const lowest = tierOrder[0] as string;
  const highest = tierOrder[tierOrder.length - 1] as string;
  const middle = tierOrder[Math.floor((tierOrder.length - 1) / 2)] as string;
  if (HIGH_SIGNAL.some((re) => re.test(description))) return highest;
  if (LOW_SIGNAL.some((re) => re.test(description))) return lowest;
  return middle;
}

/** The escalate decision produced by {@link shouldEscalate}. */
export interface EscalationDecision {
  escalate: boolean;
  trigger?: EscalationTrigger;
}

/** Options for {@link shouldEscalate}: an optional metrics-threshold predicate. */
export interface ShouldEscalateOptions {
  metricsThreshold?: (metrics: Record<string, unknown>) => boolean;
}

/**
 * Decide whether a rung result warrants escalation. Escalate on a status of
 * NEEDS_CONTEXT / BLOCKED / FAILED, on any `acceptance[].status === "not_met"`,
 * or when the optional `metricsThreshold` predicate fires. A DONE /
 * DONE_WITH_CONCERNS result with all acceptance met does NOT escalate. Pure — the
 * single source of the escalate decision.
 */
export function shouldEscalate(
  result: CanonicalSubagentResult,
  options: ShouldEscalateOptions = {},
): EscalationDecision {
  if (result.status === "NEEDS_CONTEXT") return { escalate: true, trigger: "status:NEEDS_CONTEXT" };
  if (result.status === "BLOCKED") return { escalate: true, trigger: "status:BLOCKED" };
  if (result.status === "FAILED") return { escalate: true, trigger: "status:FAILED" };
  if (result.acceptance.some((entry) => entry.status === "not_met")) {
    return { escalate: true, trigger: "acceptance:not_met" };
  }
  if (options.metricsThreshold?.(result.metrics) === true) {
    return { escalate: true, trigger: "metrics-threshold" };
  }
  return { escalate: false };
}

/** The model ladder to climb (low→high). */
export interface Ladder {
  tiers: readonly string[];
}

/** A `tier_escalated` agent-event (mirrors agent-event-extensions.schema.json). */
export interface TierEscalatedEvent {
  schemaVersion: 1;
  type: "tier_escalated";
  dispatch_id: string;
  run_id?: string;
  recorded_at: string;
  data: { from_tier: string; to_tier: string; trigger: string; attempt_number: number };
}

/** One executed rung of the ladder. */
export interface EscalationAttempt {
  tier: string;
  attemptNumber: number;
  attemptId: string;
  result: CanonicalSubagentResult;
}

/** Why the driver stopped climbing. */
export type EscalationStop = "success" | "ladder-exhausted" | "budget-exhausted";

/** Context for {@link escalate}: identity, budget, and per-rung reservation. */
export interface EscalationContext {
  runId: string;
  dispatchId: string;
  branchId: string;
  /** Task description used for the initial-tier classification. */
  description: string;
  /** The budget reservation to admit for a given tier's rung. */
  reservationFor: (tier: string) => BudgetReservation;
  /** The single run-scoped authority; each rung is admitted through it. */
  ledger: RemainingBudgetLedger;
  metricsThreshold?: (metrics: Record<string, unknown>) => boolean;
  /** Attempt number of the first rung (defaults to 1). */
  startAttemptNumber?: number;
}

/** Injected, deterministic dependencies for {@link escalate}. */
export interface EscalationDeps {
  /** Execute one rung; returns its canonical result. Injected (offline/testable). */
  runRung: (tier: string, attemptNumber: number) => CanonicalSubagentResult;
  idSeq: () => string;
  clock: () => string;
}

/** Result of {@link escalate}: the final result plus the full attempt/event trace. */
export interface EscalationResult {
  finalResult: CanonicalSubagentResult | null;
  finalTier: string | null;
  attempts: EscalationAttempt[];
  events: TierEscalatedEvent[];
  stopped: EscalationStop;
}

/**
 * Run a model ladder adaptively. Starts at the classified rung; before each rung
 * it admits that rung's reservation to `ctx.ledger` (a denial stops the climb —
 * budget self-truncation), then runs the rung via `deps.runRung`. If
 * {@link shouldEscalate} says escalate and a higher rung exists, it emits a
 * `tier_escalated` event and advances (a new `attempt.number` on the same
 * `branchId`); otherwise it stops (`success` on a non-escalating result,
 * `ladder-exhausted` at the top). Pure aside from the injected `deps`.
 */
export function escalate(ladder: Ladder, ctx: EscalationContext, deps: EscalationDeps): EscalationResult {
  const tiers = ladder.tiers;
  const attempts: EscalationAttempt[] = [];
  const events: TierEscalatedEvent[] = [];

  if (tiers.length === 0) {
    return { finalResult: null, finalTier: null, attempts, events, stopped: "ladder-exhausted" };
  }

  const startTier = classifyInitialTier(ctx.description, tiers);
  let index = Math.max(0, tiers.indexOf(startTier));
  let attemptNumber = ctx.startAttemptNumber ?? 1;
  let finalResult: CanonicalSubagentResult | null = null;
  let finalTier: string | null = null;
  // A committed-but-not-yet-emitted escalation into the current rung. The event
  // is emitted only once that rung is affordably admitted and run, so a
  // budget-denied rung produces NO escalation event (AC5).
  let pending: { from: string; trigger: EscalationTrigger; fromAttempt: number } | null = null;

  while (index < tiers.length) {
    const tier = tiers[index] as string;

    const admitted = ctx.ledger.admit(ctx.reservationFor(tier));
    if (!admitted.ok) {
      return { finalResult, finalTier, attempts, events, stopped: "budget-exhausted" };
    }

    if (pending !== null) {
      events.push({
        schemaVersion: 1,
        type: "tier_escalated",
        dispatch_id: ctx.dispatchId,
        run_id: ctx.runId,
        recorded_at: deps.clock(),
        data: {
          from_tier: pending.from,
          to_tier: tier,
          trigger: pending.trigger,
          attempt_number: pending.fromAttempt,
        },
      });
      pending = null;
    }

    const result = deps.runRung(tier, attemptNumber);
    attempts.push({ tier, attemptNumber, attemptId: deps.idSeq(), result });
    finalResult = result;
    finalTier = tier;

    const decision = shouldEscalate(
      result,
      ctx.metricsThreshold !== undefined ? { metricsThreshold: ctx.metricsThreshold } : {},
    );
    if (!decision.escalate) {
      return { finalResult, finalTier, attempts, events, stopped: "success" };
    }

    const nextIndex = index + 1;
    if (nextIndex >= tiers.length) {
      return { finalResult, finalTier, attempts, events, stopped: "ladder-exhausted" };
    }

    pending = { from: tier, trigger: decision.trigger ?? "status:FAILED", fromAttempt: attemptNumber };
    index = nextIndex;
    attemptNumber += 1;
  }

  return { finalResult, finalTier, attempts, events, stopped: "ladder-exhausted" };
}
