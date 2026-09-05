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

// The leading `/?` is load-bearing. Without it an absolute answer like
// `/tmp/wt-1/src/a.ts` is captured as `tmp/wt-1/src/a.ts`, which no longer
// starts with the worktree root, so the prefix strip silently fails and a
// correct answer scores as a miss. Caught by its own test.
const PATH_PATTERN = /\/?(?:[\w.@-]+\/)+[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs)\b/g;

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
  readonly score: RetrievalScore;
  readonly toolCalls: number;
  readonly contextTokens: number;
  /** Tool calls before the first gold file was named; null if never named. */
  readonly stepsToFirstGold: number | null;
}

export interface Verdict {
  readonly tasks: number;
  readonly recallOn: number;
  readonly recallOff: number;
  readonly recallGainPoints: number;
  readonly tokensOn: number;
  readonly tokensOff: number;
  readonly meetsThreshold: boolean;
  readonly reason: string;
}

/** The pre-registered decision rule, in code so it cannot drift from the document. */
export const RECALL_GAIN_THRESHOLD_POINTS = 10;

/**
 * Apply the pre-registered rule to paired results.
 *
 * Two conditions, both required: recall at least ten points higher, AND context
 * cost no greater. The second is not a formality — a recall gain bought with
 * more tokens is available to anyone without a code graph, so it does not
 * support the claim under test.
 */
export function decide(results: readonly ArmResult[]): Verdict {
  const on = results.filter((r) => r.arm === "context-on");
  const off = results.filter((r) => r.arm === "context-off");

  const paired = on.filter((a) => off.some((b) => b.taskId === a.taskId)).map((a) => a.taskId);
  if (paired.length === 0) {
    return {
      tasks: 0,
      recallOn: 0,
      recallOff: 0,
      recallGainPoints: 0,
      tokensOn: 0,
      tokensOff: 0,
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
  const tokensOn = mean(onPaired.map((r) => r.contextTokens));
  const tokensOff = mean(offPaired.map((r) => r.contextTokens));

  const recallGainPoints = (recallOn - recallOff) * 100;
  const cheaper = tokensOn <= tokensOff;
  const meetsThreshold = recallGainPoints >= RECALL_GAIN_THRESHOLD_POINTS && cheaper;

  const reason = meetsThreshold
    ? `recall +${recallGainPoints.toFixed(1)} points at no greater context cost`
    : recallGainPoints < RECALL_GAIN_THRESHOLD_POINTS
      ? `recall gain ${recallGainPoints.toFixed(1)} points is below the pre-registered ${RECALL_GAIN_THRESHOLD_POINTS}`
      : `recall gain ${recallGainPoints.toFixed(1)} points was bought with more context (${tokensOn.toFixed(0)} vs ${tokensOff.toFixed(0)} tokens)`;

  return { tasks: paired.length, recallOn, recallOff, recallGainPoints, tokensOn, tokensOff, meetsThreshold, reason };
}
