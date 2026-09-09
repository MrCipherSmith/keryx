// Scoring for the context-retrieval measurement
// (docs/requirements/keryx-context-measurement/pre-registration.md).
//
// The headline metric is RECALL: of the files the pull request actually changed,
// how many did the agent name. Precision and F1 are reported but do not decide
// the pre-registered threshold, because the two arms are asked to locate files,
// not to be terse about it — an arm that names one extra plausible file has not
// failed at retrieval.
//
// Everything here is deterministic. No model, no network, no repository access:
// given an answer and a gold set it returns the same numbers forever, which is
// what makes a disputed result re-checkable by anyone.

import type { ContextInventory } from "./retrieval-ablation";
import { sourcePathPattern } from "./retrieval-languages";

export interface RetrievalScore {
  readonly recall: number;
  readonly precision: number;
  readonly f1: number;
  readonly matched: readonly string[];
  readonly missed: readonly string[];
  readonly extra: readonly string[];
}

/**
 * Reduce a path to the form gold sets are written in: repository-relative,
 * forward slashes, no leading `./`, no surrounding punctuation.
 *
 * An agent answering from inside a worktree will often give an absolute path
 * under a temporary directory, and scoring that as a miss would measure the
 * harness rather than the agent. `worktreeRoot` strips exactly that prefix and
 * nothing else — a path that merely resembles one is left alone.
 */
export function normalizePath(raw: string, worktreeRoot?: string): string {
  let value = raw.trim().replace(/\\/g, "/");
  // Answers arrive wrapped in prose punctuation far more often than not.
  value = value.replace(/^[`'"([<]+/, "").replace(/[`'")\]>,.;:]+$/, "");
  if (worktreeRoot !== undefined && worktreeRoot.length > 0) {
    const root = worktreeRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (value === root) return "";
    if (value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  }
  value = value.replace(/^\.\//, "").replace(/^\/+/, "");
  return value;
}

// Built from the shared language list rather than written out here. The two
// copies had already drifted — this one accepted `.cjs`, the task extractor's
// did not — so a gold file one side rejected could still be matched by the
// other. See retrieval-languages.ts for why the list contains what it does.
const PATH_PATTERN = sourcePathPattern();

/**
 * Every repository-relative source path an answer mentions, de-duplicated and in
 * first-seen order.
 *
 * Extraction rather than a strict output format on purpose: forcing an exact
 * reply shape measures instruction-following as much as retrieval, and the two
 * arms would not be equally affected — the arm with a routing index is being
 * told what to do by more text than the arm without one.
 */
export function extractPaths(answer: string, worktreeRoot?: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of answer.matchAll(PATH_PATTERN)) {
    const normalized = normalizePath(match[0], worktreeRoot);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

/**
 * Score one arm of one task.
 *
 * An empty gold set is refused rather than scored: recall over nothing is
 * undefined, and returning 1 or 0 for it would quietly move the aggregate in a
 * direction nobody chose. The extractor's filters make this unreachable, which
 * is exactly why it should throw if it ever happens.
 */
export function scoreRetrieval(
  predicted: readonly string[],
  gold: readonly string[],
): RetrievalScore {
  if (gold.length === 0) {
    throw new Error("scoreRetrieval: an empty gold set has no recall — this task should have been filtered out");
  }

  const goldSet = new Set(gold.map((file) => normalizePath(file)));
  const predictedSet = new Set(predicted.map((file) => normalizePath(file)).filter((file) => file.length > 0));

  const matched = [...goldSet].filter((file) => predictedSet.has(file));
  const missed = [...goldSet].filter((file) => !predictedSet.has(file));
  const extra = [...predictedSet].filter((file) => !goldSet.has(file));

  const recall = matched.length / goldSet.size;
  const precision = predictedSet.size === 0 ? 0 : matched.length / predictedSet.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);

  return { recall, precision, f1, matched, missed, extra };
}

export interface ArmResult {
  readonly taskId: string;
  readonly arm: "context-on" | "context-off";
  readonly model: string;
  /**
   * Which agent CLI produced this. The claim under test is about keryx, not
   * about one harness, so the harness is an axis and never an average: two
   * harnesses' recalls pooled into one number would answer a question nobody
   * asked, and would also pair `context-on` under one CLI with `context-off`
   * under another, since a task id alone does not distinguish them.
   *
   * Absent on every line written before this field existed. See LEGACY_HARNESS.
   */
  readonly harness: string;
  readonly score: RetrievalScore;
  readonly toolCalls: number;
  /**
   * Everything the model read, cache included — or null where the harness
   * cannot say.
   *
   * Null rather than zero, and the distinction decides a verdict. The
   * pre-registered rule has two halves, and the second is "at no greater
   * context cost"; a zero would satisfy it unconditionally and report a win
   * bought with an unknown. `codex exec --json` reports `input_tokens` and
   * `output_tokens` with no cache breakdown, and claude's own numbers show why
   * that is not the same quantity: a four-word prompt measured 2 input tokens
   * beside 43,000 cached. Where the quantity cannot be established, the verdict
   * says the second half could not be evaluated.
   */
  readonly contextTokens: number | null;
  /**
   * What the arm actually cost. Recorded because the pre-registration says it is
   * — and it was not, until this was added: the adapter read `total_cost_usd`
   * and `runArm` dropped it on the floor, so the document promised a number
   * nothing kept. Reported, never part of the rule; prices change, tokens do not.
   *
   * Null where the harness does not price its own turns. `keryx shell` reports
   * token counts and no dollar figure, and a zero there would understate its
   * cost in the write-up while looking like a measurement.
   */
  readonly costUsd: number | null;
  /**
   * Tool calls made before the agent first HELD a gold path — named in a tool
   * input or returned in a tool result. Null if it never did. See the 2026-09-05
   * amendment in the pre-registration for why inputs alone were not enough.
   */
  readonly stepsToFirstGold: number | null;
  /**
   * What the arm actually held. `keryx init` creates an empty wiki skeleton, so
   * "the directory exists" is not evidence a wiki does; the page count is.
   */
  readonly inventory: ContextInventory;
  /**
   * The same, taken AFTER the agent finished.
   *
   * The `keryx` binary is on PATH for both arms by design — the advantage under
   * test is supposed to come from the context being present, not from one side
   * holding a tool the other lacks. But that leaves the control arm able to run
   * `keryx gdgraph build` and hand itself a graph, which would dilute the effect
   * without appearing anywhere. If `context-off` ends a task holding a graph
   * database it did not start with, it built one, and this is where that shows.
   */
  readonly inventoryAfter: ContextInventory;
}

export interface Verdict {
  /** The one harness this verdict is about. Verdicts are never pooled. */
  readonly harness: string;
  readonly tasks: number;
  readonly recallOn: number;
  readonly recallOff: number;
  readonly recallGainPoints: number;
  /** Null when any paired arm could not report what it read. See ArmResult. */
  readonly tokensOn: number | null;
  readonly tokensOff: number | null;
  /**
   * Mean dollar cost per arm. Reported for the write-up; not part of the rule.
   * Null when any paired arm's harness does not price its turns.
   */
  readonly costOn: number | null;
  readonly costOff: number | null;
  readonly meetsThreshold: boolean;
  readonly reason: string;
}

/** The pre-registered decision rule, in code so it cannot drift from the document. */
export const RECALL_GAIN_THRESHOLD_POINTS = 10;

/**
 * The harness a result line with no `harness` field came from.
 *
 * Every line written before the field existed came from the claude adapter,
 * because it was the only one. Reading such a line as `claude` recovers the
 * 2026-09-05 sweep instead of stranding it under an "unknown" label that no
 * verdict could use.
 *
 * This is a claim about history, and history is not a guard. What makes it safe
 * is that new lines cannot reach this path: the writer sets the field from the
 * agent port, the field is required on the type, and a test appends a result
 * through the real writer and fails if the field is absent.
 */
export const LEGACY_HARNESS = "claude";

/**
 * Apply the pre-registered rule to paired results.
 *
 * Two conditions, both required: recall at least ten points higher, AND context
 * cost no greater. The second is not a formality — a recall gain bought with
 * more tokens is available to anyone without a code graph, so it does not
 * support the claim under test.
 */
export function decide(results: readonly ArmResult[]): Verdict {
  // Refused rather than averaged. Pooling two harnesses would also pair the
  // arms wrongly: `paired` matches on task id, and the same task run under two
  // CLIs has two `context-on` rows that a task id cannot tell apart.
  const harnesses = [...new Set(results.map((r) => r.harness))];
  if (harnesses.length > 1) {
    throw new Error(
      `decide: results span ${harnesses.length} harnesses (${harnesses.join(", ")}) — ` +
        "verdicts are per-harness; use decideByHarness",
    );
  }
  const harness = harnesses[0] ?? "none";

  const on = results.filter((r) => r.arm === "context-on");
  const off = results.filter((r) => r.arm === "context-off");

  const paired = on.filter((a) => off.some((b) => b.taskId === a.taskId)).map((a) => a.taskId);
  if (paired.length === 0) {
    return {
      harness,
      tasks: 0,
      recallOn: 0,
      recallOff: 0,
      recallGainPoints: 0,
      tokensOn: null,
      tokensOff: null,
      costOn: null,
      costOff: null,
      meetsThreshold: false,
      reason: "no task has both arms — nothing to compare",
    };
  }

  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

  // Only paired tasks count. An arm that crashed on one side would otherwise
  // shift the other side's mean by dropping its hardest cases.
  const onPaired = on.filter((r) => paired.includes(r.taskId));
  const offPaired = off.filter((r) => paired.includes(r.taskId));

  const recallOn = mean(onPaired.map((r) => r.score.recall));
  const recallOff = mean(offPaired.map((r) => r.score.recall));

  // One unknown poisons the mean, and must: a mean taken over the arms that
  // happened to report would compare a subset of one arm against a subset of
  // the other, and the rule would be applied to a comparison nobody made.
  const tokenValues = (rows: readonly ArmResult[]): number[] | null => {
    const known: number[] = [];
    for (const row of rows) {
      if (row.contextTokens === null) return null;
      known.push(row.contextTokens);
    }
    return known;
  };
  const onTokenValues = tokenValues(onPaired);
  const offTokenValues = tokenValues(offPaired);
  const tokensOn = onTokenValues === null ? null : mean(onTokenValues);
  const tokensOff = offTokenValues === null ? null : mean(offTokenValues);
  // Computed alongside tokens and deliberately absent from every line below
  // that decides anything.
  const costValues = (rows: readonly ArmResult[]): number[] | null => {
    const known: number[] = [];
    for (const row of rows) {
      if (row.costUsd === null) return null;
      known.push(row.costUsd);
    }
    return known;
  };
  const onCostValues = costValues(onPaired);
  const offCostValues = costValues(offPaired);
  const costOn = onCostValues === null ? null : mean(onCostValues);
  const costOff = offCostValues === null ? null : mean(offCostValues);

  const recallGainPoints = (recallOn - recallOff) * 100;
  const costKnown = tokensOn !== null && tokensOff !== null;
  const cheaper = costKnown && tokensOn <= tokensOff;
  const meetsThreshold = recallGainPoints >= RECALL_GAIN_THRESHOLD_POINTS && cheaper;

  // Order matters. A recall gain the cost condition cannot judge is not a win
  // and is not a plain miss either, and saying "below the threshold" for it
  // would describe the wrong failure.
  const reason = meetsThreshold
    ? `recall +${recallGainPoints.toFixed(1)} points at no greater context cost`
    : recallGainPoints < RECALL_GAIN_THRESHOLD_POINTS
      ? `recall gain ${recallGainPoints.toFixed(1)} points is below the pre-registered ${RECALL_GAIN_THRESHOLD_POINTS}`
      : !costKnown
        ? `recall gain ${recallGainPoints.toFixed(1)} points clears the threshold, but ${harness} does not report what each arm read, ` +
          "so the pre-registered cost condition could not be evaluated and this is not recorded as a win"
        : `recall gain ${recallGainPoints.toFixed(1)} points was bought with more context (${(tokensOn as number).toFixed(0)} vs ${(tokensOff as number).toFixed(0)} tokens)`;

  return {
    harness,
    tasks: paired.length,
    recallOn,
    recallOff,
    recallGainPoints,
    tokensOn,
    tokensOff,
    costOn,
    costOff,
    meetsThreshold,
    reason,
  };
}

/**
 * One verdict per harness, in first-seen order.
 *
 * The separation is the point. "keryx helps on any model and any CLI" is not a
 * claim a pooled average can support or refute: an average can hide one harness
 * winning and another losing, which is the single most interesting thing such a
 * run could find.
 */
export function decideByHarness(results: readonly ArmResult[]): Verdict[] {
  const byHarness = new Map<string, ArmResult[]>();
  for (const result of results) {
    const rows = byHarness.get(result.harness) ?? [];
    rows.push(result);
    byHarness.set(result.harness, rows);
  }
  return [...byHarness.values()].map((rows) => decide(rows));
}
