// Pure, deterministic ORACLE scorer for the metastore ladder (see
// docs/requirements/keryx-benchmark-suite/metrics-and-validation.md "Metastore ladder →
// Oracle / IR metrics" and specification.md §5.1 "Evidence bundle"). Given a system-output
// affected-set (e.g. the file/dependent IDs `gdgraph affected <target>` returns) and the
// git-history-derived gold affected-set for that target, it computes IR metrics via ./ir.ts
// and assembles a `paired-3-5-v2` manifest for `ladder: "metastore"` that passes
// validatePairedBenchmark.
//
// This module NEVER clones a repo, shells out to git, or invokes gdgraph — that is the job
// of the thin producer scripts/benchmark/run-express-oracle.ts. Keeping the scorer pure is
// what makes it unit-testable offline and reproducible per spec AC-2 ("two runs produce
// identical numbers"): the same inputs always yield the same manifest, byte for byte.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deriveRate,
  type BenchmarkLadder,
  type BenchmarkValue,
  type CacheState,
  type LeakageAssertion,
  type OracleMetrics,
  type PairedBenchmarkManifestV2,
  type PairedBenchmarkRunV2,
  type RateWithCI,
} from "./benchmark";
import { f1, precision, recall } from "./ir";
import type { Reliability } from "./types";

/** One target's system-output affected-set scored against its gold affected-set. */
export type OracleScoreInput = {
  /** Target file/symbol under test, e.g. "lib/application.js". */
  readonly target: string;
  /** System output: the affected ID set the tool produced (deduped internally). */
  readonly system: readonly string[];
  /** Gold: the git-history-derived affected ID set for this target (deduped internally). */
  readonly gold: readonly string[];
};

/** The raw IR measurement for one target — plain numbers plus the set-arithmetic behind them. */
export type OracleTargetScore = {
  readonly target: string;
  readonly taskId: string;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly systemSize: number;
  readonly goldSize: number;
  /** |system ∩ gold|. */
  readonly truePositives: number;
  /** |system \ gold|. */
  readonly falsePositives: number;
  /** |gold \ system|. */
  readonly falseNegatives: number;
};

// The metastore oracle is agent-free and git-gold-derived: every number is measured
// directly, so its reliability is always `exact` (metrics-and-validation.md's reliability
// ladder — "exact: measured directly … git-derived gold").
const ORACLE_RELIABILITY: Reliability = "exact";
const METRIC_SOURCE = "gdgraph affected <target> vs git-history gold (goldAffectedSet)";

/** Stable, collision-free task id for a target so the manifest reads back to its source. */
export function oracleTaskId(target: string): string {
  return `metastore:gdgraph-affected:${target}`;
}

/**
 * Score one target's system output against gold. Pure set arithmetic + ./ir.ts; the IR
 * numbers come from the library (so its documented empty-set conventions hold) while the
 * intersection counts are computed here for the rate/CI blocks and the grading rationale.
 */
export function scoreOracleTarget(input: OracleScoreInput): OracleTargetScore {
  const systemSet = new Set(input.system);
  const goldSet = new Set(input.gold);
  let truePositives = 0;
  for (const id of systemSet) if (goldSet.has(id)) truePositives += 1;
  return {
    target: input.target,
    taskId: oracleTaskId(input.target),
    precision: precision(input.system, input.gold),
    recall: recall(input.system, input.gold),
    f1: f1(input.system, input.gold),
    systemSize: systemSet.size,
    goldSize: goldSet.size,
    truePositives,
    falsePositives: systemSet.size - truePositives,
    falseNegatives: goldSet.size - truePositives,
  };
}

function measured(value: number): BenchmarkValue {
  return { value, reliability: ORACLE_RELIABILITY, source: METRIC_SOURCE };
}

function oracleMetrics(score: OracleTargetScore): OracleMetrics {
  return {
    precision: measured(score.precision),
    recall: measured(score.recall),
    f1: measured(score.f1),
  };
}

// Precision and recall are genuine binomial proportions (successes/n), so where a real
// denominator exists we also report them as rates carrying a 95% Wilson CI via deriveRate.
// A denominator of 0 (empty retrieved => no precision n; empty gold => no recall n) is
// skipped rather than fabricated — validateRate rejects a rate without an explicit n.
function oracleRates(score: OracleTargetScore): Record<string, RateWithCI> | undefined {
  const rates: Record<string, RateWithCI> = {};
  if (score.systemSize > 0) rates.precision = deriveRate(score.truePositives, score.systemSize, ORACLE_RELIABILITY);
  if (score.goldSize > 0) rates.recall = deriveRate(score.truePositives, score.goldSize, ORACLE_RELIABILITY);
  return Object.keys(rates).length > 0 ? rates : undefined;
}

export type OracleManifestOptions = {
  readonly ladder?: BenchmarkLadder;
  /** Non-empty identifier for the tool/config that produced the system output. */
  readonly model?: string;
  readonly cacheState?: CacheState;
  readonly leakageAssertion?: LeakageAssertion;
};

const DEFAULT_MODEL = "gdgraph-oracle";

function oracleRun(score: OracleTargetScore, options: OracleManifestOptions): PairedBenchmarkRunV2 {
  const rates = oracleRates(score);
  const run: PairedBenchmarkRunV2 = {
    task_id: score.taskId,
    variant: "baseline",
    run_id: `${score.taskId}#1`,
    ladder: options.ladder ?? "metastore",
    model: options.model ?? DEFAULT_MODEL,
    // Deterministic, agent-free oracle: no cache and no leakage surface by construction.
    cacheState: options.cacheState ?? "unknown",
    leakageAssertion: options.leakageAssertion ?? "not-applicable",
    caseKind: "deterministic",
    tokenCap: null,
    // Deterministic case: exactly one run (spec §5.2, DETERMINISTIC_MIN_RUNS).
    seeds: [1],
    quality: "measured",
    oracle: oracleMetrics(score),
    ...(rates ? { rates } : {}),
    human_interventions: null,
  };
  return run;
}

/**
 * Assemble a `paired-3-5-v2` manifest for the metastore ladder from per-target scores.
 * Requires 3-5 targets (the protocol's task-count bound); the returned manifest is designed
 * to pass validatePairedBenchmark — every oracle metric is measured (never zero-filled with
 * `unknown`), each rate carries its Wilson CI, and no speed claim is made.
 */
export function buildOracleManifest(
  inputs: readonly OracleScoreInput[],
  options: OracleManifestOptions = {},
): PairedBenchmarkManifestV2 {
  const ladder = options.ladder ?? "metastore";
  const scores = inputs.map(scoreOracleTarget);
  const runs = scores.map((score) => oracleRun(score, options));
  const taskIds = [...new Set(runs.map((run) => run.task_id))].sort();
  return {
    protocol: "paired-3-5-v2",
    ladder,
    task_ids: taskIds,
    runs,
    speedClaim: { claimed: false },
  };
}

// ---------------------------------------------------------------------------
// Evidence bundle (spec §5.1) — the on-disk audit trail for each scored target.
// ---------------------------------------------------------------------------

export type EvidenceBundleContext = {
  readonly repo?: string;
  readonly commit?: string;
  /** Path to the gold-label reference, which lives OUTSIDE the agent-visible tree. */
  readonly goldReference?: string;
  readonly driver?: string;
  readonly model?: string;
  readonly cacheState?: CacheState;
  readonly leakageAssertion?: LeakageAssertion;
  /** Injectable timestamp so bundles are byte-for-byte reproducible in tests. */
  readonly timestamp?: string;
};

// A fixed default timestamp keeps the bundle deterministic when no clock is injected; the
// producer passes a real ISO timestamp at generation time.
const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export type EvidenceBundle = {
  readonly target: string;
  readonly caseId: string;
  readonly variant: string;
  readonly seed: number;
  readonly inputs: {
    readonly caseId: string;
    readonly ladder: BenchmarkLadder;
    readonly driver: string;
    readonly repo: string | null;
    readonly commit: string | null;
    readonly goldReference: string | null;
    readonly leakageAssertion: LeakageAssertion;
  };
  readonly run: {
    readonly target: string;
    readonly variant: string;
    readonly model: string;
    readonly seed: number;
    readonly cacheState: CacheState;
    readonly startedAt: string;
    readonly finishedAt: string;
  };
  readonly grading: {
    readonly metrics: OracleMetrics;
    readonly raw: {
      readonly systemAffected: string[];
      readonly goldAffected: string[];
      readonly truePositives: number;
      readonly falsePositives: number;
      readonly falseNegatives: number;
    };
    readonly rationale: string;
  };
};

/** Build the per-target evidence bundle described in spec §5.1 (inputs / run / grading). */
export function buildEvidenceBundle(
  input: OracleScoreInput,
  options: OracleManifestOptions & EvidenceBundleContext = {},
): EvidenceBundle {
  const score = scoreOracleTarget(input);
  const ladder = options.ladder ?? "metastore";
  const caseId = score.taskId;
  const variant = "baseline";
  const seed = 1;
  const timestamp = options.timestamp ?? DEFAULT_TIMESTAMP;
  const leakageAssertion = options.leakageAssertion ?? "not-applicable";
  const rationale =
    `precision=${score.precision} recall=${score.recall} f1=${score.f1} ` +
    `(tp=${score.truePositives}, fp=${score.falsePositives}, fn=${score.falseNegatives}; ` +
    `system=${score.systemSize}, gold=${score.goldSize}). ` +
    `IR metrics computed by src/metrics/ir.ts against git-history gold (src/metrics/gold.ts).`;
  return {
    target: score.target,
    caseId,
    variant,
    seed,
    inputs: {
      caseId,
      ladder,
      driver: options.driver ?? "keryx gdgraph affected <target>",
      repo: options.repo ?? null,
      commit: options.commit ?? null,
      goldReference: options.goldReference ?? null,
      leakageAssertion,
    },
    run: {
      target: score.target,
      variant,
      model: options.model ?? DEFAULT_MODEL,
      seed,
      cacheState: options.cacheState ?? "unknown",
      startedAt: timestamp,
      finishedAt: timestamp,
    },
    grading: {
      metrics: oracleMetrics(score),
      raw: {
        systemAffected: [...new Set(input.system)].sort(),
        goldAffected: [...new Set(input.gold)].sort(),
        truePositives: score.truePositives,
        falsePositives: score.falsePositives,
        falseNegatives: score.falseNegatives,
      },
      rationale,
    },
  };
}

/**
 * Persist an evidence bundle to disk under `<outDir>/bench/<ladder>/<target>/<case-id>/
 * <variant>/<seed>/` (spec §5.1), writing inputs.json, run.json, and grading.json. Returns
 * the directory written. `target` is path-sanitised so a target like "lib/application.js"
 * nests cleanly instead of escaping the bundle root.
 */
export async function persistEvidenceBundle(
  outDir: string,
  bundle: EvidenceBundle,
  ladder: BenchmarkLadder = "metastore",
): Promise<string> {
  const safeTarget = bundle.target.replace(/[^A-Za-z0-9._/-]/g, "_");
  const safeCase = bundle.caseId.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = path.join(outDir, "bench", ladder, safeTarget, safeCase, bundle.variant, String(bundle.seed));
  await mkdir(dir, { recursive: true });
  const write = (name: string, value: unknown): Promise<void> =>
    writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await Promise.all([
    write("inputs.json", bundle.inputs),
    write("run.json", bundle.run),
    write("grading.json", bundle.grading),
  ]);
  return dir;
}

/** Score every target, build the manifest, and persist all evidence bundles under `outDir`. */
export async function runOracleAndPersist(
  inputs: readonly OracleScoreInput[],
  outDir: string,
  options: OracleManifestOptions & EvidenceBundleContext = {},
): Promise<{ manifest: PairedBenchmarkManifestV2; bundleDirs: string[] }> {
  const manifest = buildOracleManifest(inputs, options);
  const bundleDirs: string[] = [];
  for (const input of inputs) {
    const bundle = buildEvidenceBundle(input, options);
    bundleDirs.push(await persistEvidenceBundle(outDir, bundle, options.ladder ?? "metastore"));
  }
  return { manifest, bundleDirs };
}
