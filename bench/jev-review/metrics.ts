// Flow 331, AC3/AS4 — metric computation over a component/arm's predictions.
//
// Reuses `src/metrics/benchmark.ts`'s `wilsonInterval`/`deriveRate` rather
// than inventing a second confidence-interval implementation: that module
// already encodes this repository's honesty norm (metrics-and-validation.md
// §M07/§M08) that an absence of trials must never render as a measured
// zero — `deriveRate(0, 0, r)` returns an `UnmeasuredRate`, not `{rate: 0}`.
// AC4 asks for exactly that discipline applied to this benchmark.
import { deriveRate, isMeasuredRate, type RateWithCI } from "../../src/metrics/benchmark";
import type { Reliability } from "../../src/metrics/types";
import type { ComponentPrediction, ComponentResult, ComponentUsage } from "./types";

/** AC4: a rate built from fewer than this many trials is anecdotal, not a finding. */
export const ANECDOTAL_THRESHOLD_N = 10;

export interface ComponentArmMetrics {
  readonly component: string;
  readonly arm: "without-jev" | "with-jev";
  readonly available: true;
  readonly n: number;
  readonly anecdotal: boolean;
  /** correct / attempted, for a closed-world classification component (every case has a known truth). */
  readonly accuracy: RateWithCI | null;
  /** true-positive / (true-positive + false-positive), among flagged items with a known label. */
  readonly precision: RateWithCI | null;
  /** false-positive / (true-positive + false-positive) — AC3's "noise": findings later refuted/dismissed. Same denominator family as `precision`, reported separately because AC3 names it separately. */
  readonly noise: RateWithCI | null;
  /** AC3's "added true positives ... (hand-labelled sample)" — carried through verbatim from the adapter result; `null` means no hand-labelling pass ran (see `ComponentArmResult.addedTruePositives`). */
  readonly addedTruePositives: number | null;
  readonly usage: ComponentUsage;
}

export interface ComponentArmUnavailable {
  readonly component: string;
  readonly arm: "without-jev" | "with-jev";
  readonly available: false;
  readonly reason: string;
}

export type ComponentMetrics = ComponentArmMetrics | ComponentArmUnavailable;

function reliabilityFor(predictions: readonly ComponentPrediction[]): Reliability {
  return predictions.length === 0 ? "unknown" : "exact";
}

/**
 * `accuracy`: attempted (n>0, closed-world, e.g. one verdict per labelled CI-
 * triage case) with a known-correct/known-wrong outcome for every attempt.
 * `null` when any prediction carries `correct: null` — an accuracy figure
 * with an unscored item silently folded in is worse than no figure.
 */
function computeAccuracy(predictions: readonly ComponentPrediction[]): RateWithCI | null {
  if (predictions.length === 0) return null;
  if (predictions.some((p) => p.correct === null)) return null;
  const correct = predictions.filter((p) => p.correct === true).length;
  return deriveRate(correct, predictions.length, reliabilityFor(predictions));
}

/** `precision`/`noise`: only over FLAGGED predictions whose correctness is known — an open-world detector's silence is not a claim. */
function computeFlaggedRates(predictions: readonly ComponentPrediction[]): { precision: RateWithCI | null; noise: RateWithCI | null } {
  const flagged = predictions.filter((p) => p.flagged && p.correct !== null);
  if (flagged.length === 0) return { precision: null, noise: null };
  const truePositive = flagged.filter((p) => p.correct === true).length;
  const falsePositive = flagged.length - truePositive;
  const reliability = reliabilityFor(flagged);
  return {
    precision: deriveRate(truePositive, flagged.length, reliability),
    noise: deriveRate(falsePositive, flagged.length, reliability),
  };
}

export function computeMetrics(result: ComponentResult): ComponentMetrics {
  if (!result.available) {
    return { component: result.component, arm: result.arm, available: false, reason: result.reason };
  }
  const { precision, noise } = computeFlaggedRates(result.predictions);
  return {
    component: result.component,
    arm: result.arm,
    available: true,
    n: result.n,
    anecdotal: result.n < ANECDOTAL_THRESHOLD_N,
    accuracy: computeAccuracy(result.predictions),
    precision,
    noise,
    addedTruePositives: result.addedTruePositives,
    usage: result.usage,
  };
}

/** True when a metrics row actually carries a number (vs. an `UnmeasuredRate`/unavailable row) — the report's one place to decide whether to print a percentage at all (AC4). */
export function hasMeasuredRate(rate: RateWithCI | null): boolean {
  return rate !== null && isMeasuredRate(rate);
}

// ---------------------------------------------------------------------------
// Variance across repeats (AC4: "run-to-run variance is measured by
// repeating the Jev arm at least 2 times on a subset and reported")
// ---------------------------------------------------------------------------

export interface VarianceReport {
  readonly component: string;
  readonly repeats: number;
  readonly values: readonly number[];
  readonly mean: number;
  /** Population standard deviation across the repeats — 0 when there is only one distinct value or one repeat. */
  readonly stddev: number;
  readonly bootstrapCi95: { readonly lower: number; readonly upper: number } | null;
}

/**
 * A percentile bootstrap over the mean of `values` — the "bootstrap ...
 * confidence interval" AC3 asks for, used specifically for the repeated-run
 * variance AC4 requires (Wilson covers the single-run proportion CIs
 * everywhere else in this module). Deterministic: a seeded LCG, not
 * `Math.random()`, so a benchmark run is reproducible from its recorded
 * inputs.
 */
export function bootstrapMeanCi95(values: readonly number[], iterations = 2000, seed = 1): { lower: number; upper: number } | null {
  if (values.length === 0) return null;
  if (values.length === 1) return { lower: values[0]!, upper: values[0]! };

  let state = seed >>> 0;
  const next = (): number => {
    // Numerical Recipes LCG — fast, deterministic, good enough for a resampling index.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };

  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) {
      const index = Math.floor(next() * values.length);
      sum += values[Math.min(index, values.length - 1)]!;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lowerIndex = Math.max(0, Math.floor(iterations * 0.025));
  const upperIndex = Math.min(iterations - 1, Math.ceil(iterations * 0.975) - 1);
  return { lower: means[lowerIndex]!, upper: means[upperIndex]! };
}

export function varianceReport(component: string, values: readonly number[]): VarianceReport {
  const n = values.length;
  const mean = n === 0 ? 0 : values.reduce((a, b) => a + b, 0) / n;
  const variance = n === 0 ? 0 : values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    component,
    repeats: n,
    values,
    mean,
    stddev: Math.sqrt(variance),
    bootstrapCi95: bootstrapMeanCi95(values),
  };
}
