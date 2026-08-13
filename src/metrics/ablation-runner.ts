// Pure, deterministic manifest builder for the M1 ablation runner (see
// docs/requirements/keryx-benchmark-suite/plan.md "M1 — Metastore oracle + Ablation
// core", "Remaining in M1: Ablation runner"). Given the RAW per-seed results of running
// the SAME agent + model on the SAME task twice — once with keryx metaproject tools
// available (`context-on`) and once with only basic filesystem tools (`context-off`) —
// this module assembles a `paired-3-5-v2` manifest for `ladder: "harness"` that passes
// validatePairedBenchmark.
//
// This module NEVER runs an agent, opens a provider stream, or touches git — that is the
// job of the live producer script scripts/benchmark/run-ablation.ts (which drives
// src/commands/agent.ts's runAgentTurn in two isolated git worktrees, one per variant,
// via src/harness/child/git-worktree-port.ts). Keeping the scorer pure is what makes it
// unit-testable offline and reproducible: the same raw results always yield the same
// manifest, byte for byte.

import {
  deriveRate,
  type BenchmarkCost,
  type BenchmarkDistribution,
  type BenchmarkLadder,
  type BenchmarkRunSample,
  type BenchmarkValue,
  type BenchmarkVariantV2,
  type CacheState,
  type LeakageAssertion,
  type PairedBenchmarkManifestV2,
  type PairedBenchmarkRunV2,
  type RateWithCI,
  STOCHASTIC_MIN_RUNS,
} from "./benchmark";
import type { Reliability } from "./types";

/** The two ablation arms: same agent + model, keryx metaproject tools present or absent. */
export type AblationVariant = Extract<BenchmarkVariantV2, "context-on" | "context-off">;

export const ABLATION_VARIANTS: readonly AblationVariant[] = ["context-on", "context-off"];

/** One seed's realized outcome for one (task, variant). */
export type AblationSeedSample = {
  readonly seed: number;
  readonly success: boolean;
  /** Total tokens (input+output) the provider reported for the run, or null if unreported. */
  readonly tokens: number | null;
  readonly toolCalls: number;
};

/** All seeds captured for one (task, variant) cell. */
export type AblationVariantRuns = {
  readonly variant: AblationVariant;
  readonly samples: readonly AblationSeedSample[];
};

/** One task's paired context-on / context-off cells — the unit the manifest scores. */
export type AblationTaskInput = {
  readonly taskId: string;
  readonly contextOn: AblationVariantRuns;
  readonly contextOff: AblationVariantRuns;
};

export const ABLATION_TASK_ID_PREFIX = "harness:ablation:";

/** Stable, collision-free task id for an ablation case, distinct from the metastore oracles. */
export function ablationTaskId(name: string): string {
  return `${ABLATION_TASK_ID_PREFIX}${name}`;
}

const ABLATION_RELIABILITY: Reliability = "exact";
const ABLATION_SOURCE =
  "same agent+model run twice per seed (context-on: keryx metaproject tools present; " +
  "context-off: basic filesystem tools only), scripts/benchmark/run-ablation.ts";
const ABLATION_TOKENS_LABEL = "harness token cost (median across seeds)";

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

/** Sample standard deviation (0 for n<2 — a single sample has no spread). */
function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function measured(value: number, source: string, notes?: string): BenchmarkValue {
  return { value, reliability: ABLATION_RELIABILITY, source, ...(notes ? { notes } : {}) };
}

/** Build the tool-call-count distribution across a variant's seed samples. */
function toolCallDistribution(samples: readonly AblationSeedSample[]): BenchmarkDistribution {
  const values = samples.map((s) => s.toolCalls);
  const runSamples: BenchmarkRunSample[] = samples.map((s) => ({
    seed: s.seed,
    value: s.toolCalls,
    reliability: ABLATION_RELIABILITY,
  }));
  return {
    samples: runSamples,
    median: median(values),
    spread: spread(values),
    reliability: ABLATION_RELIABILITY,
  };
}

/** Median token cost across a variant's seed samples, as a single BenchmarkValue. Only
 * samples with a reported (non-null) token count contribute; an all-null variant reports
 * `unknown` rather than fabricating a zero. */
function tokenCost(samples: readonly AblationSeedSample[], source: string): BenchmarkCost | undefined {
  const known = samples.map((s) => s.tokens).filter((t): t is number => t !== null);
  if (known.length === 0) return undefined;
  const note = `median of ${known.length}/${samples.length} seed samples with a reported token count`;
  return { tokens: { raw: measured(median(known) as number, source, note) } };
}

/** Task-success rate across a variant's seed samples, with a 95% Wilson CI. */
function successRate(samples: readonly AblationSeedSample[]): RateWithCI {
  const successes = samples.filter((s) => s.success).length;
  return deriveRate(successes, samples.length, ABLATION_RELIABILITY);
}

export type AblationManifestOptions = {
  readonly ladder?: BenchmarkLadder;
  readonly model?: string;
  readonly cacheState?: CacheState;
  readonly leakageAssertion?: LeakageAssertion;
  readonly tokenCap?: number | null;
};

/** Build one variant's `PairedBenchmarkRunV2` from its raw seed samples. */
export function buildAblationRun(
  taskId: string,
  runs: AblationVariantRuns,
  options: AblationManifestOptions = {},
): PairedBenchmarkRunV2 {
  const source = `${ABLATION_SOURCE} [variant=${runs.variant}]`;
  const run: PairedBenchmarkRunV2 = {
    task_id: taskId,
    variant: runs.variant,
    run_id: `${taskId}:${runs.variant}#1`,
    ladder: options.ladder ?? "harness",
    model: options.model ?? "unknown",
    cacheState: options.cacheState ?? "unknown",
    leakageAssertion: options.leakageAssertion ?? "not-applicable",
    caseKind: "stochastic",
    tokenCap: options.tokenCap ?? null,
    seeds: runs.samples.map((s) => s.seed),
    quality: "measured",
    distribution: toolCallDistribution(runs.samples),
    rates: { taskSuccess: successRate(runs.samples) },
    human_interventions: null,
  };
  const cost = tokenCost(runs.samples, `${source} — ${ABLATION_TOKENS_LABEL}`);
  if (cost) run.cost = cost;
  return run;
}

/**
 * Assemble a `paired-3-5-v2` manifest for the harness ladder from 3-5 ablation tasks'
 * raw context-on/context-off seed results. Requires >= STOCHASTIC_MIN_RUNS seeds per
 * variant (the protocol's stochastic-case floor) and 3-5 tasks (the protocol's
 * task-count bound); the returned manifest is designed to pass validatePairedBenchmark.
 */
export function buildAblationManifest(
  inputs: readonly AblationTaskInput[],
  options: AblationManifestOptions = {},
): PairedBenchmarkManifestV2 {
  const ladder = options.ladder ?? "harness";
  const runs: PairedBenchmarkRunV2[] = [];
  for (const input of inputs) {
    for (const variantRuns of [input.contextOn, input.contextOff]) {
      if (variantRuns.samples.length < STOCHASTIC_MIN_RUNS) {
        throw new Error(
          `ablation task "${input.taskId}" variant "${variantRuns.variant}" has ` +
            `${variantRuns.samples.length} seed samples, needs >= ${STOCHASTIC_MIN_RUNS}`,
        );
      }
      runs.push(buildAblationRun(input.taskId, variantRuns, options));
    }
  }
  const taskIds = [...new Set(runs.map((run) => run.task_id))].sort();
  return {
    protocol: "paired-3-5-v2",
    ladder,
    task_ids: taskIds,
    runs,
    speedClaim: { claimed: false },
  };
}

/**
 * Per-task delta summary (context-on vs context-off), for human-readable reporting
 * alongside the manifest — NOT part of the schema-validated manifest itself (the
 * protocol makes no speed/quality claim; a delta is reported honestly as a
 * measurement, not asserted as a conclusion).
 */
export type AblationDelta = {
  readonly taskId: string;
  readonly successRateOn: number;
  readonly successRateOff: number;
  readonly medianToolCallsOn: number | null;
  readonly medianToolCallsOff: number | null;
  readonly medianTokensOn: number | null;
  readonly medianTokensOff: number | null;
};

export function computeAblationDelta(input: AblationTaskInput): AblationDelta {
  const onToolCalls = input.contextOn.samples.map((s) => s.toolCalls);
  const offToolCalls = input.contextOff.samples.map((s) => s.toolCalls);
  const onTokens = input.contextOn.samples.map((s) => s.tokens).filter((t): t is number => t !== null);
  const offTokens = input.contextOff.samples.map((s) => s.tokens).filter((t): t is number => t !== null);
  return {
    taskId: input.taskId,
    successRateOn: successRate(input.contextOn.samples).rate,
    successRateOff: successRate(input.contextOff.samples).rate,
    medianToolCallsOn: median(onToolCalls),
    medianToolCallsOff: median(offToolCalls),
    medianTokensOn: onTokens.length > 0 ? median(onTokens) : null,
    medianTokensOff: offTokens.length > 0 ? median(offTokens) : null,
  };
}
