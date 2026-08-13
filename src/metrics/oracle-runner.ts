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
  judgePanel,
  type BenchmarkLadder,
  type BenchmarkValue,
  type CacheState,
  type JudgePanel,
  type JudgeScore,
  type LeakageAssertion,
  type OracleMetrics,
  type PairedBenchmarkManifestV2,
  type PairedBenchmarkRunV2,
  type RateWithCI,
} from "./benchmark";
import { f1, factPreservation, ndcg, precision, recall, recallAtK } from "./ir";
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
// Multi-gold scoring (decision (a)+(b)): score ONE system affected-set against
// SEVERAL independently-derived golds and emit a separate, labeled oracle result
// per gold kind. The two golds measure DIFFERENT things and are NEVER averaged:
//   - "co-change"  → reframed/labeled as "co-change prediction": does gdgraph's
//     dependency-based affected set predict the files that REALLY change together
//     with the target (git-history gold, goldAffectedSet in ./gold.ts).
//   - "dependency" → "graph correctness": does gdgraph's affected set match the
//     independent transitive import closure (goldDependencyClosure in ./gold.ts).
//     Precision here is graph-edge correctness; see DEFAULT_DEPTH_SEMANTICS on the
//     honest one-hop-vs-transitive depth gap.
// ---------------------------------------------------------------------------

export type GoldKind = "co-change" | "dependency";

/** Human-facing label carried on every emitted oracle result for a gold kind. */
export const GOLD_KIND_LABELS: Record<GoldKind, string> = {
  "co-change": "co-change prediction",
  dependency: "graph correctness",
};

// The metric `source` string records WHICH gold a result was scored against, so a
// reader can never confuse the two independent notions of "affected".
const GOLD_KIND_SOURCE: Record<GoldKind, string> = {
  "co-change": "gdgraph affected <target> vs git-history co-change gold (goldAffectedSet)",
  dependency: "gdgraph affected <target> vs transitive import-closure gold (goldDependencyClosure)",
};

// Default depth-semantics notes, emitted verbatim as `notes` on every oracle metric
// so the comparison is never silently misleading. gdgraph's affected output is
// ONE-HOP (its forward `dependencies` is structurally one-hop — see
// src/gdgraph/affected.ts — and the committed gdgraph-affected fixture uses depth=1
// dependents), while the dependency gold is the FULL transitive import closure. That
// gap is real and cannot be closed on the forward side (gdgraph cannot emit a
// transitive forward closure), so we report both numbers WITH this note rather than
// fabricating a silently-aligned score.
export const DEFAULT_DEPTH_SEMANTICS: Record<GoldKind, string> = {
  "co-change":
    "not depth-dependent: gold is git co-change history; the system set is gdgraph's " +
    "one-hop dependency-based affected set. Measures whether that set predicts real co-change.",
  dependency:
    "depth-mismatched (honest): gdgraph affected is one-hop (forward dependencies are " +
    "structurally one-hop; committed fixture uses depth=1 dependents) while this gold is the " +
    "FULL transitive import closure. Precision = graph-edge correctness (are gdgraph's edges " +
    "real closure members); recall = one-hop coverage of the transitive closure, NOT a defect " +
    "rate. A depth-aligned score would require gdgraph to emit a transitive forward closure, or " +
    "scoring against a maxDepth-1 closure (goldDependencyClosure({ maxDepth: 1 })).",
};

export type NamedGold = {
  readonly kind: GoldKind;
  /** Gold ID set for this kind (deduped internally by the scorer). */
  readonly gold: readonly string[];
  /** Optional label override; defaults to GOLD_KIND_LABELS[kind]. */
  readonly label?: string;
  /**
   * Honest note on how the system output's depth relates to this gold's depth,
   * emitted verbatim as `notes` on every oracle metric for this gold. Defaults to
   * DEFAULT_DEPTH_SEMANTICS[kind] when omitted.
   */
  readonly depthSemantics?: string;
};

/** One target's system output plus the several named golds to score it against. */
export type MultiGoldScoreInput = {
  readonly target: string;
  readonly system: readonly string[];
  /** One entry per gold kind to score `system` against; two entries are not averaged. */
  readonly golds: readonly NamedGold[];
};

/** Task id for a (gold-kind, target) pair — distinct per kind so both fit one report. */
export function oracleTaskIdForGold(kind: GoldKind, target: string): string {
  return `metastore:gdgraph-affected:${kind}:${target}`;
}

function measuredValue(value: number, source: string, notes?: string): BenchmarkValue {
  return { value, reliability: ORACLE_RELIABILITY, source, ...(notes ? { notes } : {}) };
}

function oracleMetricsForGold(score: OracleTargetScore, source: string, notes: string): OracleMetrics {
  return {
    precision: measuredValue(score.precision, source, notes),
    recall: measuredValue(score.recall, source, notes),
    f1: measuredValue(score.f1, source, notes),
  };
}

/** Score one target's system output against ONE named gold and build a labeled run. */
export function scoreGoldRun(
  input: MultiGoldScoreInput,
  named: NamedGold,
  options: OracleManifestOptions = {},
): PairedBenchmarkRunV2 {
  const kind = named.kind;
  const score = scoreOracleTarget({ target: input.target, system: input.system, gold: named.gold });
  const label = named.label ?? GOLD_KIND_LABELS[kind];
  const depthSemantics = named.depthSemantics ?? DEFAULT_DEPTH_SEMANTICS[kind];
  const source = `${GOLD_KIND_SOURCE[kind]} [gold=${kind}: ${label}]`;
  const taskId = oracleTaskIdForGold(kind, input.target);
  const rates = oracleRates(score);
  return {
    task_id: taskId,
    variant: "baseline",
    run_id: `${taskId}#1`,
    ladder: options.ladder ?? "metastore",
    model: options.model ?? DEFAULT_MODEL,
    cacheState: options.cacheState ?? "unknown",
    leakageAssertion: options.leakageAssertion ?? "not-applicable",
    caseKind: "deterministic",
    tokenCap: null,
    seeds: [1],
    quality: "measured",
    oracle: oracleMetricsForGold(score, source, depthSemantics),
    ...(rates ? { rates } : {}),
    human_interventions: null,
  };
}

/**
 * Build a SEPARATE `paired-3-5-v2` manifest per gold kind from per-target multi-gold
 * inputs. Each manifest is scored against exactly one gold kind (so its 3-5 tasks are
 * a clean, single-notion set that passes validatePairedBenchmark) and every run's
 * oracle metric carries the gold-kind label (in `source`) and the depth-semantics
 * note (in `notes`). The two golds are reported side by side, never averaged.
 *
 * The returned object is keyed by gold kind; a kind is present only if at least one
 * input supplied a gold of that kind. Note that validatePairedBenchmark still requires
 * 3-5 tasks per manifest, so each requested gold kind must cover 3-5 targets.
 */
export function buildOracleManifestsByGold(
  inputs: readonly MultiGoldScoreInput[],
  options: OracleManifestOptions = {},
): Partial<Record<GoldKind, PairedBenchmarkManifestV2>> {
  const ladder = options.ladder ?? "metastore";
  const byKind = new Map<GoldKind, PairedBenchmarkRunV2[]>();
  for (const input of inputs) {
    for (const named of input.golds) {
      const run = scoreGoldRun(input, named, options);
      const list = byKind.get(named.kind) ?? [];
      list.push(run);
      byKind.set(named.kind, list);
    }
  }
  const out: Partial<Record<GoldKind, PairedBenchmarkManifestV2>> = {};
  for (const [kind, runs] of byKind) {
    const taskIds = [...new Set(runs.map((run) => run.task_id))].sort();
    out[kind] = {
      protocol: "paired-3-5-v2",
      ladder,
      task_ids: taskIds,
      runs,
      speedClaim: { claimed: false },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Testing / TIA oracle (metrics-and-validation.md "testing" row; specification.md §1.1).
// Score a SYSTEM test-impact set — the test ids `keryx test related <file>` (naming +
// import heuristic) or the coverage-map TIA emit for a changed file, parsed into an id
// set — against the GOLD impacted-test set derived from a REAL coverage map via
// goldTestImpact (src/metrics/gold.ts: a test is gold-impacted iff its covered-files set
// intersects the changed files). Emits precision/recall/f1 in a labeled paired-3-5-v2
// manifest for ladder "metastore", layer "testing".
//
// This is a SEPARATE oracle from the gdgraph one above: different task-id namespace
// (metastore:test-impact:*), different metric source label, and it is NEVER averaged with
// the gdgraph co-change / dependency numbers. Reliability is `exact` — the gold is
// coverage-derived impact (metrics-and-validation.md reliability ladder: "coverage-derived
// impact" is measured directly).
// ---------------------------------------------------------------------------

/** Human-facing label carried on every emitted testing-oracle metric. */
export const TEST_IMPACT_LABEL = "test-impact analysis";

// The metric `source` records HOW the system set was produced and WHICH gold it was
// scored against, so a reader can never confuse it with the gdgraph affected-set oracle.
const TEST_IMPACT_SOURCE =
  "keryx test related <file> / coverage-map TIA vs coverage-derived impacted-test gold (goldTestImpact)";
const TEST_IMPACT_MODEL = "keryx-test-related";

/** One changed file's system test-impact set scored against its gold impacted-test set. */
export type TestImpactScoreInput = {
  /** The changed source file whose impacted tests are predicted, e.g. "src/metrics/ir.ts". */
  readonly changedFile: string;
  /** System output: the impacted-test id set the tool produced (deduped internally). */
  readonly system: readonly string[];
  /** Gold: coverage-derived impacted-test id set (goldTestImpact), deduped internally. */
  readonly gold: readonly string[];
};

/** Stable, collision-free task id for a testing-oracle target, distinct from the gdgraph one. */
export function testImpactTaskId(changedFile: string): string {
  return `metastore:test-impact:${changedFile}`;
}

/** Score one changed file's system test-impact set against its gold and build a labeled run. */
export function scoreTestImpactRun(
  input: TestImpactScoreInput,
  options: OracleManifestOptions = {},
): PairedBenchmarkRunV2 {
  const score = scoreOracleTarget({ target: input.changedFile, system: input.system, gold: input.gold });
  const taskId = testImpactTaskId(input.changedFile);
  const source = `${TEST_IMPACT_SOURCE} [layer=testing: ${TEST_IMPACT_LABEL}]`;
  const rates = oracleRates(score);
  return {
    task_id: taskId,
    variant: "baseline",
    run_id: `${taskId}#1`,
    ladder: options.ladder ?? "metastore",
    model: options.model ?? TEST_IMPACT_MODEL,
    cacheState: options.cacheState ?? "unknown",
    leakageAssertion: options.leakageAssertion ?? "not-applicable",
    caseKind: "deterministic",
    tokenCap: null,
    seeds: [1],
    quality: "measured",
    oracle: {
      precision: measuredValue(score.precision, source),
      recall: measuredValue(score.recall, source),
      f1: measuredValue(score.f1, source),
    },
    ...(rates ? { rates } : {}),
    human_interventions: null,
  };
}

/**
 * Assemble a `paired-3-5-v2` manifest for the metastore ladder's testing/TIA layer from
 * per-changed-file scores. Requires 3-5 changed files (the protocol's task-count bound);
 * the returned manifest is designed to pass validatePairedBenchmark — every oracle metric
 * is measured (`exact`), each rate carries its Wilson CI, and no speed claim is made.
 */
export function buildTestImpactManifest(
  inputs: readonly TestImpactScoreInput[],
  options: OracleManifestOptions = {},
): PairedBenchmarkManifestV2 {
  const ladder = options.ladder ?? "metastore";
  const runs = inputs.map((input) => scoreTestImpactRun(input, options));
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
// Memory oracle (metrics-and-validation.md "memory" row; specification.md §1.1).
// Score a SYSTEM ranked memory-id list — the ranked `path` order `keryx memory search <q>`
// returns (highest score first) — against a curated GOLD set of relevant memory ids for
// that query (hand-labeled, fixtures/benchmark/keryx/memory-gold.json, one line of
// justification per query). Emits recall@k, the row's headline metric (via ./ir.ts
// recallAtK), plus the unranked precision/recall over the full retrieved set (via
// scoreOracleTarget, reusing the same set-arithmetic every other oracle here uses) in a
// labeled paired-3-5-v2 manifest for ladder "metastore", layer "memory".
//
// This is a SEPARATE oracle from the gdgraph and testing ones above: different task-id
// namespace (metastore:memory-search:*), different metric source label, and it is NEVER
// averaged with them. Reliability is `exact` — the gold is a direct human label of
// applicable-decision relevance for a query (metrics-and-validation.md reliability ladder:
// "exact" covers a directly-measured value; a hand-curated, per-query relevance label,
// unlike an LLM judge score, is not a derived estimate).
// ---------------------------------------------------------------------------

/** Human-facing label carried on every emitted memory-oracle metric. */
export const MEMORY_SEARCH_LABEL = "memory recall@k";

// The metric `source` records HOW the system list was produced, WHICH gold it was scored
// against, and the k used, so a reader can never confuse it with the other two oracles.
const MEMORY_SEARCH_SOURCE =
  "keryx memory search <query> (ranked path list) vs curated applicable-decision gold " +
  "(fixtures/benchmark/keryx/memory-gold.json)";
const MEMORY_SEARCH_MODEL = "keryx-memory-search";

/** One query's ranked system memory-id list scored against its curated gold id set. */
export type MemoryScoreInput = {
  /** The search query, e.g. "shell allowlist not a security boundary". */
  readonly query: string;
  /** System output: `keryx memory search <query>` results, ranked best-first (`path`s). */
  readonly system: readonly string[];
  /** Gold: curated relevant memory id(s) for this query (deduped internally). */
  readonly gold: readonly string[];
  /** Cutoff for recall@k, fixed per query in the gold fixture. */
  readonly k: number;
};

/** Stable, collision-free task id for a memory-oracle target, distinct from the others. */
export function memorySearchTaskId(query: string): string {
  return `metastore:memory-search:${query}`;
}

/** Score one query's ranked system output against its gold and build a labeled run. */
export function scoreMemorySearchRun(
  input: MemoryScoreInput,
  options: OracleManifestOptions = {},
): PairedBenchmarkRunV2 {
  const score = scoreOracleTarget({ target: input.query, system: input.system, gold: input.gold });
  const atK = recallAtK(input.system, input.gold, input.k);
  const taskId = memorySearchTaskId(input.query);
  const source = `${MEMORY_SEARCH_SOURCE} [layer=memory: ${MEMORY_SEARCH_LABEL}, k=${input.k}]`;
  const rates = oracleRates(score);
  return {
    task_id: taskId,
    variant: "baseline",
    run_id: `${taskId}#1`,
    ladder: options.ladder ?? "metastore",
    model: options.model ?? MEMORY_SEARCH_MODEL,
    cacheState: options.cacheState ?? "unknown",
    leakageAssertion: options.leakageAssertion ?? "not-applicable",
    caseKind: "deterministic",
    tokenCap: null,
    seeds: [1],
    quality: "measured",
    oracle: {
      precision: measuredValue(score.precision, source),
      recall: measuredValue(score.recall, source),
      recallAtK: measuredValue(atK, source),
    },
    ...(rates ? { rates } : {}),
    human_interventions: null,
  };
}

/**
 * Assemble a `paired-3-5-v2` manifest for the metastore ladder's memory layer from
 * per-query scores. Requires 3-5 queries (the protocol's task-count bound); the returned
 * manifest is designed to pass validatePairedBenchmark — every oracle metric is measured
 * (`exact`), each rate carries its Wilson CI, and no speed claim is made.
 */
export function buildMemorySearchManifest(
  inputs: readonly MemoryScoreInput[],
  options: OracleManifestOptions = {},
): PairedBenchmarkManifestV2 {
  const ladder = options.ladder ?? "metastore";
  const runs = inputs.map((input) => scoreMemorySearchRun(input, options));
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
// gdctx fact-preservation oracle (metrics-and-validation.md "gdctx" row; specification.md
// §1.1). Score a gdctx COMPACT form — the summary `keryx ctx run -- <command>` prints —
// against the FACTS extracted from the RAW output it compacted, via factPreservation
// (./ir.ts): what fraction of the raw output's discrete, verifiable facts survive into the
// compact form. This is a lossless-fidelity check on gdctx itself (dogfood): compaction is
// allowed to DROP volume, never to drop a fact a faithful reader would need.
//
// Fact-extraction rule (fixed here so it is reproducible and never hand-tuned per case —
// the SAME extractFacts() pass runs over the RAW command output and over the gdctx COMPACT
// text). A FACT is one line of the given text, trimmed, that is either:
//   (a) a bare relative file-path token: the WHOLE trimmed line matches
//       /^[\w.][\w./-]*\.[A-Za-z0-9]+$/ (starts with a word character OR a leading dot — so
//       keryx's own dotdir tree, e.g. ".metaproject/skills/catalog.md", counts — contains
//       only word characters/dot/slash/hyphen, ends in a `.<extension>`) — e.g.
//       "src/metrics/ir.ts"; OR any individual whitespace-delimited token on the line matches the same pattern
//       once surrounding punctuation (backticks/quotes/parens/trailing `,` `.` `:` `)`) is
//       stripped — so a path quoted inline in a header line (`` Command: `ls src/metrics` ``)
//       is still recovered; or
//   (b) a `key: value` metadata/count line: the WHOLE trimmed line matches
//       /^([A-Za-z][\w -]*):\s*`?(-?\d+)`?\s*$/, normalized to the string
//       `"<lowercased trimmed key>:<value>"` — e.g. "Exit code: 0" and "Raw lines: `18`" both
//       normalize to "exit code:0" / "raw lines:18" so a fact preserved verbatim (even
//       re-wrapped in backticks by the compactor) normalizes to the identical string.
// Facts are deduped (a `Set`) and case (a) / (b) are mutually exclusive per line (whole-line
// key:value is checked first). This rule is intentionally narrow — file paths and numeric
// metadata lines — because it is meant to be checked by exact string match, not judged.
// ---------------------------------------------------------------------------

const FACT_PATH_RE = /^[\w.][\w./-]*\.[A-Za-z0-9]+$/;
const FACT_KV_RE = /^([A-Za-z][\w -]*):\s*`?(-?\d+)`?\s*$/;

/** Strip surrounding punctuation a compactor might add/quote a token with (backticks, quotes,
 * parens, trailing `,`/`.`/`:`) before testing it against FACT_PATH_RE. */
function stripTokenPunctuation(token: string): string {
  return token.replace(/^[`"'(]+/, "").replace(/[`"'),.:]+$/, "");
}

/**
 * Extract the fixed, reproducible fact set from a text (see module comment above for the
 * exact rule). Used identically on the RAW command output and on the gdctx COMPACT text so
 * `factPreservation(extractFacts(raw), extractFacts(compact))` is an exact-string-match rate,
 * never a fuzzy one.
 */
export function extractFacts(text: string): string[] {
  const facts = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const kv = line.match(FACT_KV_RE);
    if (kv) {
      const key = (kv[1] ?? "").trim().toLowerCase();
      facts.add(`${key}:${kv[2]}`);
      continue;
    }

    if (FACT_PATH_RE.test(line)) {
      facts.add(line);
      continue;
    }

    for (const token of line.split(/\s+/)) {
      const cleaned = stripTokenPunctuation(token);
      if (FACT_PATH_RE.test(cleaned)) facts.add(cleaned);
    }
  }
  return [...facts].sort();
}

/** Human-facing label carried on every emitted gdctx-oracle metric. */
export const GDCTX_FACT_PRESERVATION_LABEL = "gdctx fact-preservation";

// The metric `source` records HOW both sides were produced (compaction + the shared,
// documented extraction rule), so a reader can never confuse it with the other oracles.
const GDCTX_SOURCE =
  "keryx ctx run -- <command> compact summary vs raw command output, both passed through " +
  "extractFacts (src/metrics/oracle-runner.ts) — fact-preservation rate (./ir.ts factPreservation)";
const GDCTX_MODEL = "keryx-ctx-run";

/** One compacted input's raw-vs-compact fact sets (already extracted via extractFacts). */
export type GdctxScoreInput = {
  /** Identifier for the scored input, e.g. the source command that was compacted. */
  readonly input: string;
  /** Facts extracted from the RAW output extractFacts sees before compaction (gold). */
  readonly rawFacts: readonly string[];
  /** Facts extracted from the gdctx COMPACT form extractFacts sees (system). */
  readonly compactFacts: readonly string[];
};

/** Stable, collision-free task id for a gdctx-oracle target, distinct from the others. */
export function gdctxTaskId(input: string): string {
  return `metastore:gdctx-fact-preservation:${input}`;
}

/** Score one input's raw-vs-compact fact sets and build a labeled run. */
export function scoreGdctxRun(
  input: GdctxScoreInput,
  options: OracleManifestOptions = {},
): PairedBenchmarkRunV2 {
  const rawSet = new Set(input.rawFacts);
  const compactSet = new Set(input.compactFacts);
  let preserved = 0;
  for (const fact of rawSet) if (compactSet.has(fact)) preserved += 1;
  const rate = factPreservation(rawSet, compactSet);
  const taskId = gdctxTaskId(input.input);
  const source = `${GDCTX_SOURCE} [layer=gdctx: ${GDCTX_FACT_PRESERVATION_LABEL}]`;
  // Same "no fabricated denominator" convention as oracleRates: only report a Wilson-CI'd
  // rate when there is a real n (a non-empty raw-facts set).
  const rates: Record<string, RateWithCI> | undefined =
    rawSet.size > 0 ? { factPreservation: deriveRate(preserved, rawSet.size, ORACLE_RELIABILITY) } : undefined;
  return {
    task_id: taskId,
    variant: "baseline",
    run_id: `${taskId}#1`,
    ladder: options.ladder ?? "metastore",
    model: options.model ?? GDCTX_MODEL,
    cacheState: options.cacheState ?? "unknown",
    leakageAssertion: options.leakageAssertion ?? "not-applicable",
    caseKind: "deterministic",
    tokenCap: null,
    seeds: [1],
    quality: "measured",
    oracle: {
      factPreservation: measuredValue(rate, source),
    },
    ...(rates ? { rates } : {}),
    human_interventions: null,
  };
}

/**
 * Assemble a `paired-3-5-v2` manifest for the metastore ladder's gdctx layer from per-input
 * raw-vs-compact fact-set scores. Requires 3-5 inputs (the protocol's task-count bound); the
 * returned manifest is designed to pass validatePairedBenchmark — the fact-preservation
 * metric is measured (`exact`), its rate carries a Wilson CI when the denominator is real,
 * and no speed claim is made.
 */
export function buildGdctxManifest(
  inputs: readonly GdctxScoreInput[],
  options: OracleManifestOptions = {},
): PairedBenchmarkManifestV2 {
  const ladder = options.ladder ?? "metastore";
  const runs = inputs.map((input) => scoreGdctxRun(input, options));
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
// gdwiki oracle (metrics-and-validation.md "gdwiki" row; specification.md §1.1).
// Score a SYSTEM ranked passage list — the ranked citation `path`s `keryx wiki ask <q>`
// returns (best match first; src/wiki/ask.ts wikiAsk → WikiAskResult.citations) — against a
// curated GOLD set of relevant passage ids for that query (hand-labeled,
// fixtures/benchmark/keryx/wiki-gold.json, one line of justification per query). Emits
// **nDCG** and **recall@k** (both via ./ir.ts, the gdwiki row's retrieval metrics) in a
// labeled paired-3-5-v2 manifest for ladder "metastore", layer "gdwiki".
//
// GROUNDEDNESS ("does the cited passage support the answer") is represented by a 3-judge
// panel scoring 0-2 (benchmark.ts judgePanel → strict = all three score 2, lenient = at
// least two). Since a LIVE-LLM judge is out of scope here, the three scores are a
// HAND-LABELED, per-query groundedness fixture (fixtures/benchmark/keryx/wiki-groundedness.json,
// one line of justification each) — deterministic and auditable. A live-LLM judge panel is a
// documented follow-up; the panel shape is identical, so swapping in real judge scores later
// is a fixture change, not a scorer change.
//
// This is a SEPARATE oracle from the gdgraph, testing, memory, and gdctx ones above:
// different task-id namespace (metastore:gdwiki-ask:*), different metric source label, and it
// is NEVER averaged with them. Reliability of nDCG/recall@k is `exact` — the gold is a direct
// human label of passage relevance for a query (same argument as the memory oracle: a
// hand-curated, per-query relevance label is a direct measurement, not a derived estimate).
// The groundedness judge scores are hand-labeled and carried on the run's `judge` panel (with
// per-panel rationale), NOT presented as a measured BenchmarkValue.
// ---------------------------------------------------------------------------

/** Human-facing label carried on every emitted gdwiki-oracle metric. */
export const GDWIKI_ASK_LABEL = "gdwiki nDCG/recall@k";

// The metric `source` records HOW the ranked list was produced, WHICH gold it was scored
// against, and the k used, so a reader can never confuse it with the other oracles.
const GDWIKI_ASK_SOURCE =
  "keryx wiki ask <query> (ranked citation path list) vs curated Q→passage gold " +
  "(fixtures/benchmark/keryx/wiki-gold.json)";
const GDWIKI_ASK_MODEL = "keryx-wiki-ask";

/** A hand-labeled 3-judge groundedness panel for one query (0-2 each) + one-line rationale. */
export type WikiGroundedness = {
  /** Exactly three hand-labeled judge scores (0-2). */
  readonly scores: readonly [JudgeScore, JudgeScore, JudgeScore];
  /** One-line justification for the hand label (carried on the emitted judge panel). */
  readonly rationale?: string;
};

/** One query's ranked system passage list scored against its curated gold passage set. */
export type WikiScoreInput = {
  /** The wiki question, e.g. "how does the OS sandbox contain a running process". */
  readonly query: string;
  /** System output: `keryx wiki ask <query>` ranked citation `path`s, best match first. */
  readonly system: readonly string[];
  /** Gold: curated relevant passage id(s) for this query (deduped internally). */
  readonly gold: readonly string[];
  /** Cutoff for nDCG@k and recall@k, fixed per query in the gold fixture. */
  readonly k: number;
  /** Hand-labeled groundedness judge panel for this query (3 scores 0-2 + rationale). */
  readonly groundedness: WikiGroundedness;
};

/** Stable, collision-free task id for a gdwiki-oracle target, distinct from the others. */
export function wikiAskTaskId(query: string): string {
  return `metastore:gdwiki-ask:${query}`;
}

/** Score one query's ranked system output against its gold and build a labeled run. */
export function scoreWikiAskRun(
  input: WikiScoreInput,
  options: OracleManifestOptions = {},
): PairedBenchmarkRunV2 {
  const nd = ndcg(input.system, input.gold, input.k);
  const atK = recallAtK(input.system, input.gold, input.k);
  const taskId = wikiAskTaskId(input.query);
  const source = `${GDWIKI_ASK_SOURCE} [layer=gdwiki: ${GDWIKI_ASK_LABEL}, k=${input.k}]`;
  // Groundedness: a HAND-LABELED 3-judge panel (strict = all three score 2, lenient = >= two).
  // A live-LLM judge panel is a documented follow-up; the shape here is identical.
  const panel: JudgePanel = judgePanel(
    [input.groundedness.scores[0], input.groundedness.scores[1], input.groundedness.scores[2]],
    input.groundedness.rationale,
  );
  return {
    task_id: taskId,
    variant: "baseline",
    run_id: `${taskId}#1`,
    ladder: options.ladder ?? "metastore",
    model: options.model ?? GDWIKI_ASK_MODEL,
    cacheState: options.cacheState ?? "unknown",
    leakageAssertion: options.leakageAssertion ?? "not-applicable",
    caseKind: "deterministic",
    tokenCap: null,
    seeds: [1],
    quality: "measured",
    oracle: {
      ndcg: measuredValue(nd, source),
      recallAtK: measuredValue(atK, source),
    },
    judge: panel,
    human_interventions: null,
  };
}

/**
 * Assemble a `paired-3-5-v2` manifest for the metastore ladder's gdwiki layer from per-query
 * scores. Requires 3-5 queries (the protocol's task-count bound); the returned manifest is
 * designed to pass validatePairedBenchmark — nDCG/recall@k are measured (`exact`), the
 * hand-labeled groundedness rides on each run's `judge` panel with strict/lenient derived,
 * and no speed claim is made.
 */
export function buildWikiAskManifest(
  inputs: readonly WikiScoreInput[],
  options: OracleManifestOptions = {},
): PairedBenchmarkManifestV2 {
  const ladder = options.ladder ?? "metastore";
  const runs = inputs.map((input) => scoreWikiAskRun(input, options));
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
