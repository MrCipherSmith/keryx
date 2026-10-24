import { wilsonInterval } from "../metrics/benchmark";

export type ProbeCounts = { seeds: number; successes: number };
export type ProbeArmCounts = ProbeCounts & {
  answered: number;
  failed: number;
  tokens?: number;
  toolCalls?: number;
};
export type ProbeScoreInput = {
  taskKind: "deterministic" | "stochastic" | null;
  /** Requested seeds per arm; actual counts must match before scoring. */
  seeds: number;
  goldClean: boolean;
  /** Caller verifies both arm environments and the pre-publication snapshot. */
  environmentMatches: boolean;
  budgetExceeded: boolean;
  arms: { base: ProbeArmCounts; probe: ProbeArmCounts };
};
export type ProbeUnmeasurableReason =
  | "no-task" | "underpowered" | "gold-leak"
  | "environment-drift" | "budget-exceeded" | "run-failed";
export type ProbeMeasuredVerdict = "improved" | "regressed" | "indistinguishable";
export type ProbeDelta = { rate: number; ci: [number, number]; tokens?: number; toolCalls?: number };
export type ProbeArmScore = ProbeDelta & ProbeCounts;
export type ProbeScore =
  | { verdict: "unmeasurable"; reason: ProbeUnmeasurableReason; arms: { base: null; probe: null }; delta: null }
  | { verdict: ProbeMeasuredVerdict; reason?: never; arms: { base: ProbeArmScore; probe: ProbeArmScore }; delta: ProbeDelta };

function validCounts(counts: ProbeCounts): boolean {
  return Number.isSafeInteger(counts.seeds) && counts.seeds > 0
    && Number.isSafeInteger(counts.successes) && counts.successes >= 0 && counts.successes <= counts.seeds;
}

/** Newcombe hybrid-score (method 10), probe minus base; conservative for paired seeds. */
export function newcombeInterval(base: ProbeCounts, probe: ProbeCounts): ProbeDelta | null {
  if (!validCounts(base) || !validCounts(probe)) return null;
  const b = wilsonInterval(base.successes, base.seeds);
  const p = wilsonInterval(probe.successes, probe.seeds);
  if (!b || !p) return null;
  const rate = p.rate - b.rate;
  return { rate, ci: [
    Math.max(-1, rate - Math.hypot(p.rate - p.lower, b.upper - b.rate)),
    Math.min(1, rate + Math.hypot(p.upper - p.rate, b.rate - b.lower)),
  ] };
}

/** Zero on either endpoint is inconclusive: no rounding or epsilon threshold. */
export function verdictForDelta(ci: readonly [number, number]): ProbeMeasuredVerdict {
  if (ci[0] > 0) return "improved";
  if (ci[1] < 0) return "regressed";
  return "indistinguishable";
}

function armScore(counts: ProbeArmCounts): ProbeArmScore | null {
  if (!validCounts(counts) || counts.answered !== counts.seeds || counts.failed !== 0) return null;
  const interval = wilsonInterval(counts.successes, counts.seeds);
  if (!interval) return null;
  return { seeds: counts.seeds, successes: counts.successes, rate: interval.rate,
    ci: [interval.lower, interval.upper],
    ...(counts.tokens === undefined ? {} : { tokens: counts.tokens }),
    ...(counts.toolCalls === undefined ? {} : { toolCalls: counts.toolCalls }),
  };
}

function unmeasurable(reason: ProbeUnmeasurableReason): ProbeScore {
  return { verdict: "unmeasurable", reason, arms: { base: null, probe: null }, delta: null };
}

/** Pure counts-in/numbers-out. No runs, persistence, evidence or provider dependencies. */
export function scoreProbe(input: ProbeScoreInput): ProbeScore {
  // Frozen specification section 7: precedence is intentional, including truncated budget runs.
  if (input.taskKind === null) return unmeasurable("no-task");
  const minimum = input.taskKind === "stochastic" ? 3 : 1;
  if (!Number.isSafeInteger(input.seeds) || input.seeds < minimum) return unmeasurable("underpowered");
  if (!input.goldClean) return unmeasurable("gold-leak");
  if (!input.environmentMatches) return unmeasurable("environment-drift");
  if (input.budgetExceeded) return unmeasurable("budget-exceeded");
  const base = armScore(input.arms.base);
  const probe = armScore(input.arms.probe);
  if (!base || !probe || base.seeds !== input.seeds || probe.seeds !== input.seeds) return unmeasurable("run-failed");
  const delta = newcombeInterval(base, probe);
  if (!delta) return unmeasurable("run-failed");
  // Unknown telemetry stays absent; usage has no part in the verdict decision.
  if (base.tokens !== undefined && probe.tokens !== undefined) delta.tokens = probe.tokens - base.tokens;
  if (base.toolCalls !== undefined && probe.toolCalls !== undefined) delta.toolCalls = probe.toolCalls - base.toolCalls;
  return { verdict: verdictForDelta(delta.ci), arms: { base, probe }, delta };
}
