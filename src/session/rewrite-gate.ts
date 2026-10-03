// Flow 393 AC12 / AC14: when is rewriting the request worth it?
//
// Every rewrite of old history (rebuilding the slate frame, pruning, packing an observation,
// compacting) changes the request prefix, so the provider's prompt cache is invalidated from the
// first changed message to the end. The next request re-bills that whole tail at the UNCACHED
// price instead of the cached one. A rewrite pays for itself only when the tokens it removes,
// re-billed (at the cached price) on every remaining round, cost more than that one re-billing.
//
// This module is pure: it takes numbers and returns a decision plus the numbers behind it, so the
// caller can log it and a test can pin each branch.

/** Newest tool-result tokens that are never pruned, on a large window (flow 387 T11). */
export const PRUNE_PROTECT_MAX_TOKENS = 40_000;
/** Smallest saving that justifies a batch, on a large window (flow 387 T11). */
export const PRUNE_MIN_SAVING_MAX_TOKENS = 20_000;
/** Share of the window protected from pruning. */
export const PRUNE_PROTECT_WINDOW_SHARE = 0.3;
/** Share of the window a batch must save at least. */
export const PRUNE_MIN_SAVING_WINDOW_SHARE = 0.15;

export interface PruneThresholds {
  protectTokens: number;
  minSavingTokens: number;
}

/**
 * Flow 393 AC12: the prune thresholds for a context window. Protect = min(40K, 30% of the window),
 * batch saving = min(20K, 15% of the window), so a small window is not asked to hold 40K of
 * protected output. An unknown window keeps the fixed flow 394 values.
 */
export function pruneThresholdsForWindow(contextWindow: number | undefined): PruneThresholds {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { protectTokens: PRUNE_PROTECT_MAX_TOKENS, minSavingTokens: PRUNE_MIN_SAVING_MAX_TOKENS };
  }
  return {
    protectTokens: Math.min(PRUNE_PROTECT_MAX_TOKENS, Math.floor(contextWindow * PRUNE_PROTECT_WINDOW_SHARE)),
    minSavingTokens: Math.min(PRUNE_MIN_SAVING_MAX_TOKENS, Math.floor(contextWindow * PRUNE_MIN_SAVING_WINDOW_SHARE)),
  };
}

/**
 * Price of a cached input token relative to an uncached one. A conservative table: a provider
 * that does not publish a cheap cached rate (or one we do not know) is treated as caching half-way,
 * which keeps rewrites rare enough not to thrash and frequent enough to bound the request.
 */
export function cachedPriceRatio(providerId: string | undefined): number {
  const id = (providerId ?? "").toLowerCase();
  if (id.includes("anthropic") || id.includes("claude")) return 0.1;
  if (id.includes("openai") || id.includes("codex")) return 0.25;
  if (id.includes("gemini") || id.includes("google")) return 0.25;
  return 0.5;
}

export type RewriteKind = "frame" | "prune" | "pack" | "compaction";

export interface RewriteInput {
  kind: RewriteKind;
  /** Estimated tokens the rewrite removes from every later request. */
  savedTokens: number;
  /** Tokens from the first changed message to the end of the request (what gets re-billed). */
  invalidatedTokens: number;
  /** Estimated rounds still to run (see {@link estimateRemainingRounds}). */
  remainingRounds: number;
  /** Cached price over uncached price, in (0, 1]. */
  cachedRatio: number;
  /** The plan advanced a step since the last rewrite: the cache is about to go stale anyway. */
  atPlanBoundary?: boolean;
  /** The request would not fit otherwise (window overflow): always applied, still logged. */
  forced?: boolean;
}

export type RewriteReason = "forced" | "saving-exceeds-cost" | "boundary" | "cost-exceeds-saving" | "nothing-to-save";

export interface RewriteDecision {
  apply: boolean;
  reason: RewriteReason;
  kind: RewriteKind;
  /** Uncached-equivalent tokens the rewrite is expected to save over the remaining rounds. */
  saving: number;
  /** Uncached-equivalent tokens re-billing the invalidated prefix costs, after the boundary discount. */
  cost: number;
  remainingRounds: number;
  atPlanBoundary: boolean;
}

/** At a plan-step boundary the cost counts for this much: rewriting there is preferred. */
export const BOUNDARY_COST_FACTOR = 0.5;

/**
 * Flow 393 AC14: apply a rewrite only if saving over the remaining rounds beats the cost of
 * re-billing the invalidated prefix.
 *
 *   saving = savedTokens x cachedRatio x remainingRounds   (each round would have re-sent those
 *                                                           tokens from cache)
 *   cost   = invalidatedTokens x (1 - cachedRatio)         (the one request after the rewrite pays
 *                                                           the uncached price for the whole tail)
 *
 * A provider with no cache discount (ratio 1) has zero cost, so any saving applies.
 */
export function decideRewrite(input: RewriteInput): RewriteDecision {
  const ratio = Math.min(1, Math.max(0.01, input.cachedRatio));
  const rounds = Math.max(1, Math.floor(input.remainingRounds));
  const atPlanBoundary = input.atPlanBoundary === true;
  const saving = Math.max(0, input.savedTokens) * ratio * rounds;
  const baseCost = Math.max(0, input.invalidatedTokens) * (1 - ratio);
  const cost = atPlanBoundary ? baseCost * BOUNDARY_COST_FACTOR : baseCost;
  const base = { kind: input.kind, saving, cost, remainingRounds: rounds, atPlanBoundary };
  if (input.forced === true) {
    return { ...base, apply: true, reason: "forced" };
  }
  if (input.savedTokens <= 0) {
    return { ...base, apply: false, reason: "nothing-to-save" };
  }
  if (saving > cost) {
    return { ...base, apply: true, reason: atPlanBoundary && saving <= baseCost ? "boundary" : "saving-exceeds-cost" };
  }
  return { ...base, apply: false, reason: "cost-exceeds-saving" };
}

/** One line for the routing log: what was decided and the numbers behind it. */
export function describeRewriteDecision(d: RewriteDecision): string {
  return (
    `[rewrite] ${d.kind}: ${d.apply ? "applied" : "skipped"} (${d.reason}); ` +
    `saving ~${Math.round(d.saving)} vs rebill ~${Math.round(d.cost)} uncached-equivalent tokens over ` +
    `${d.remainingRounds} rounds${d.atPlanBoundary ? ", at a plan-step boundary" : ""}.`
  );
}

/** Rounds assumed left when nothing says otherwise. */
export const DEFAULT_REMAINING_ROUNDS = 12;
/** Rounds one pending plan step is assumed to take. */
export const ROUNDS_PER_PLAN_STEP = 4;

/**
 * Rounds still to run: a few per unfinished plan step when there is a plan, else a default;
 * never more than the turn's remaining round budget, never less than 1.
 */
export function estimateRemainingRounds(opts: {
  pendingPlanSteps?: number;
  round: number;
  maxRounds: number;
}): number {
  const guess =
    opts.pendingPlanSteps !== undefined && opts.pendingPlanSteps > 0
      ? opts.pendingPlanSteps * ROUNDS_PER_PLAN_STEP
      : DEFAULT_REMAINING_ROUNDS;
  const budget = Number.isFinite(opts.maxRounds) ? Math.max(1, opts.maxRounds - opts.round) : guess;
  return Math.max(1, Math.min(guess, budget));
}
