// Scoring, as a port rather than a hardwired metric.
//
// The pilot's score type is file recall, statically: `RetrievalScore` is embedded
// in `ArmResult.score`, which is embedded in `Verdict.recallOn/recallOff` and in
// `decide`. There is no scorer interface, and `scoreRetrieval` THROWS on an empty
// gold set — so an implementation task, which has no gold file list at all, cannot
// pass through it.
//
// The arena needs two metrics that share nothing: file recall for research, and a
// gate verdict plus a judge preference for implementation. They are kept in a
// discriminated union rather than flattened into one wide record, because a row
// carrying `recall: 0` for a task that was never scored on recall is the kind of
// field a later reader averages by accident.
//
// `scoreRetrieval` and `extractPaths` are reused verbatim, including the throw on
// an empty gold set: that guard is correct and is not relaxed here. A research
// task with no gold is a broken task record, not a zero.

import { extractPaths, scoreRetrieval, type RetrievalScore } from "../benchmark/retrieval-scoring";
import type { GateVerdict } from "./arena-gates";
import type { ArenaTask } from "./arena-tasks";

export interface ResearchScore {
  readonly kind: "research";
  readonly retrieval: RetrievalScore;
}

export interface ImplementScore {
  readonly kind: "implement";
  readonly gates: GateVerdict;
  readonly changedSourceFiles: number;
  /**
   * Whether `moveOutOfIterator` appears anywhere in the arm's diff.
   *
   * Diagnostic only, never part of a verdict. The root cause of the ticket is
   * known — the escape branch exists and is unreachable because the position is
   * clamped before the test — so "did the arm touch the unreachable branch" is
   * informative about HOW it worked. It is not evidence that it worked: a diff can
   * mention the symbol and fix nothing, and a correct fix might not mention it at
   * all because the bug is in the caller.
   */
  readonly touchedEscapeBranch: boolean;
}

export type ArenaScore = ResearchScore | ImplementScore;

export interface ArenaScorer {
  readonly kind: ArenaScore["kind"];
  score(input: {
    readonly task: ArenaTask;
    readonly answerText: string;
    readonly treePath: string;
    readonly gates?: GateVerdict;
    readonly changedSourceFiles?: number;
    readonly diffText?: string;
  }): ArenaScore;
}

export const researchScorer: ArenaScorer = {
  kind: "research",
  score({ task, answerText, treePath }) {
    if (task.gold.length === 0) {
      throw new Error(
        `task ${task.id} is a research task with an empty gold set — that is a broken task record, not a zero`,
      );
    }
    return { kind: "research", retrieval: scoreRetrieval(extractPaths(answerText, treePath), task.gold) };
  },
};

export const ESCAPE_BRANCH_MARKER = "moveOutOfIterator";

export const implementScorer: ArenaScorer = {
  kind: "implement",
  score({ gates, changedSourceFiles, diffText }) {
    if (gates === undefined || changedSourceFiles === undefined) {
      throw new Error("an implement task must be scored with gate results and a changed-file count");
    }
    return {
      kind: "implement",
      gates,
      changedSourceFiles,
      touchedEscapeBranch: (diffText ?? "").includes(ESCAPE_BRANCH_MARKER),
    };
  },
};

export function scorerFor(task: ArenaTask): ArenaScorer {
  return task.type === "implement" ? implementScorer : researchScorer;
}

// ---------------------------------------------------------------------------
// Per-harness verdicts
// ---------------------------------------------------------------------------

export interface ArenaPair<T> {
  readonly taskId: string;
  readonly on: T;
  readonly off: T;
}

/**
 * Pair arms by task, dropping any task that does not have both.
 *
 * An orphan arm must never reach a mean. The pilot learned this the hard way: a
 * half-recorded task left one arm in the results file, and averaging it compares a
 * context arm against nothing.
 */
export function pairByTask<T extends { readonly taskId: string; readonly arm: "context-on" | "context-off" }>(
  rows: readonly T[],
): ArenaPair<T>[] {
  const on = new Map<string, T>();
  const off = new Map<string, T>();
  for (const row of rows) (row.arm === "context-on" ? on : off).set(row.taskId, row);
  const pairs: ArenaPair<T>[] = [];
  for (const [taskId, onRow] of on) {
    const offRow = off.get(taskId);
    if (offRow !== undefined) pairs.push({ taskId, on: onRow, off: offRow });
  }
  return pairs.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

export const RECALL_GAIN_THRESHOLD_POINTS = 10;
export const COST_TIE_BAND = 0.2;

export interface ResearchVerdict {
  readonly harness: string;
  readonly tasks: number;
  readonly recallOn: number;
  readonly recallOff: number;
  readonly recallGainPoints: number;
  readonly tokensOn: number | null;
  readonly tokensOff: number | null;
  readonly costRatio: number | null;
  readonly meetsThreshold: boolean;
  readonly reason: string;
}

/**
 * The one confirmatory claim the arena makes.
 *
 * Threshold inherited from the pilot's pre-registration: +10 points of recall at no
 * greater context cost, over 13 paired tasks — the sample size at which that
 * threshold is the minimum detectable effect. Anything less is "no difference", not
 * "a promising trend".
 *
 * The cost half is reported as a ratio with its own tie band rather than folded
 * into the same boolean. At this sample size a conjunction of two noisy conditions
 * roughly doubles the noise while looking like one confident verdict, so the two
 * are kept separate and both are printed.
 *
 * A null on either side of the cost comparison is not a zero and does not mean
 * free: it means that leg could not establish what it read, and the cost half is
 * then unevaluated while recall still stands.
 */
export function decideResearch(
  harness: string,
  pairs: readonly ArenaPair<{ taskId: string; arm: "context-on" | "context-off"; recall: number; tokens: number | null }>[],
): ResearchVerdict {
  if (pairs.length === 0) {
    return {
      harness,
      tasks: 0,
      recallOn: 0,
      recallOff: 0,
      recallGainPoints: 0,
      tokensOn: null,
      tokensOff: null,
      costRatio: null,
      meetsThreshold: false,
      reason: "no paired tasks — nothing to compare",
    };
  }

  const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  const recallOn = mean(pairs.map((pair) => pair.on.recall));
  const recallOff = mean(pairs.map((pair) => pair.off.recall));
  const recallGainPoints = (recallOn - recallOff) * 100;

  const tokensKnown = pairs.every((pair) => pair.on.tokens !== null && pair.off.tokens !== null);
  const tokensOn = tokensKnown ? mean(pairs.map((pair) => pair.on.tokens as number)) : null;
  const tokensOff = tokensKnown ? mean(pairs.map((pair) => pair.off.tokens as number)) : null;
  const costRatio = tokensOn !== null && tokensOff !== null && tokensOff > 0 ? tokensOn / tokensOff : null;

  const meetsThreshold = recallGainPoints >= RECALL_GAIN_THRESHOLD_POINTS;
  const costNote =
    costRatio === null
      ? "context cost could not be established on at least one arm, so the cost half is unevaluated"
      : costRatio <= 1 + COST_TIE_BAND
        ? `context cost ratio ${costRatio.toFixed(2)}, within the ±20% tie band`
        : `context cost ratio ${costRatio.toFixed(2)}, above the tie band — the gain was not free`;

  return {
    harness,
    tasks: pairs.length,
    recallOn,
    recallOff,
    recallGainPoints,
    tokensOn,
    tokensOff,
    costRatio,
    meetsThreshold,
    reason: meetsThreshold
      ? `+${recallGainPoints.toFixed(1)} points over ${pairs.length} paired tasks, at or above the +${RECALL_GAIN_THRESHOLD_POINTS} threshold; ${costNote}`
      : `${recallGainPoints >= 0 ? "+" : ""}${recallGainPoints.toFixed(1)} points over ${pairs.length} paired tasks, below the +${RECALL_GAIN_THRESHOLD_POINTS} threshold — no difference, not a trend; ${costNote}`,
  };
}
