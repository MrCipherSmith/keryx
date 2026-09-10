// Blind pairwise judging for T2, and the three things that keep it from being theatre.
//
// **The diff is filtered, and the blinding is asserted rather than intended.**
// `keryx ctx` writes `.metaproject/data/gdctx/raw/*.log` on every routed command, so
// a context arm's worktree diff carries hundreds of keryx artifacts. A judge shown
// `git diff` identifies the arm in the first second, and "blind pairwise" becomes a
// label. So the judge sees tracked source only, and the harness REFUSES the cell if
// the filtered text still names the system under test.
//
// **The question is nearly objective, because the root cause is known.** The ticket's
// bug is that `clampInnerStepPosition` runs before the escape test, so
// `isInsideParent` is always true and `moveOutOfIterator` is unreachable. A correct
// fix must let the escape test see an unclamped position while still clamping the
// stays-inside case. That is checkable by reading a diff, which is a far better
// question than "is this a good implementation".
//
// **A judge that fails calibration invalidates its own cell.** The same diff is
// shown as both A and B; the only defensible answer is a tie. A judge that picks a
// winner there is measuring presentation order, and its verdict on the real pair
// carries no information.
//
// The model call is injected, so every rule above is exercised without spending.

export type JudgeChoice = "A" | "B" | "tie" | "neither";

export interface JudgeQuestion {
  readonly criterion: string;
  readonly diffA: string;
  readonly diffB: string;
}

export interface JudgeAnswer {
  readonly choice: JudgeChoice;
  readonly reason: string;
}

export interface JudgeModel {
  (question: JudgeQuestion): Promise<JudgeAnswer>;
}

/** Substrings whose presence means the diff was not blinded. */
export const BLINDING_MARKERS: readonly string[] = ["keryx", "metaproject", "gdgraph", "gdwiki", "gdctx"];

/** Path prefixes excluded from a judged diff: workspace artifacts, not the arm's work. */
export const JUDGE_EXCLUDED_PREFIXES: readonly string[] = [".metaproject/", ".claude/"];

/**
 * Keep only hunks for paths the arm was asked to change.
 *
 * Parsed on `diff --git` boundaries rather than with a patch library: the input is
 * git's own output, the rule is "drop whole files", and a dependency that silently
 * reflows a hunk would change what the judge reads.
 */
export function filterDiffForJudge(diff: string, excluded: readonly string[] = JUDGE_EXCLUDED_PREFIXES): string {
  const kept: string[] = [];
  let keeping = true;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header !== null) {
      const candidate = header[2] ?? header[1] ?? "";
      keeping = !excluded.some((prefix) => candidate.startsWith(prefix));
    }
    if (keeping) kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Refuse a diff that tells the judge which arm produced it.
 *
 * Checked after filtering, because filtering is what is supposed to have removed
 * the tell. A cell that fails here is dropped and reported as dropped — not judged
 * with a caveat, because there is no way to subtract the knowledge afterwards.
 */
export function assertBlinded(diff: string, label: string): void {
  const lowered = diff.toLowerCase();
  const found = BLINDING_MARKERS.filter((marker) => lowered.includes(marker));
  if (found.length > 0) {
    throw new Error(
      `${label} still names ${found.join(", ")} after filtering — the judge would identify the arm, ` +
        "so this cell is dropped rather than judged with a caveat",
    );
  }
}

/**
 * The criterion, written before any arm ran and narrow enough to check by reading.
 *
 * Deliberately describes the OUTCOME rather than an implementation. A fix that moves
 * the clamp, one that computes the action from the raw position, and one that splits
 * the function all satisfy it; a fix that merely mentions the escape branch does not.
 */
export const T2_CRITERION = [
  "A step that is inside an iterator and is dragged outside the iterator's bounds must become unassigned from it.",
  "",
  "Concretely: the code path that decides whether the dragged step left its parent must receive the drag position",
  "as the user produced it, NOT a position that has already been constrained to lie inside the parent. The",
  "constraint must still apply to the case where the step stays inside the parent.",
  "",
  "Answer A or B for the diff that achieves this. Answer `tie` if both achieve it or both fail equally.",
  "Answer `neither` if neither diff achieves it — that is a real and expected outcome, not a cop-out.",
].join("\n");

export interface PairwiseVerdict {
  readonly choice: JudgeChoice;
  /** Both presentation orders agreed. When false the result is a tie by rule. */
  readonly consistent: boolean;
  readonly calibrated: boolean;
  readonly forward: JudgeAnswer;
  readonly reverse: JudgeAnswer;
  readonly calibration: JudgeAnswer;
  readonly reason: string;
}

/**
 * Judge one pair, in both orders, with a calibration probe.
 *
 * Order matters to models, so a winner is only a winner if it wins as A and as B.
 * Anything else is recorded as a tie — not as a weak preference, because a weak
 * preference at n=1 is indistinguishable from position bias.
 */
export async function judgePair(options: {
  readonly model: JudgeModel;
  readonly onDiff: string;
  readonly offDiff: string;
  readonly criterion?: string;
}): Promise<PairwiseVerdict> {
  const criterion = options.criterion ?? T2_CRITERION;
  const onDiff = filterDiffForJudge(options.onDiff);
  const offDiff = filterDiffForJudge(options.offDiff);
  assertBlinded(onDiff, "the context-on diff");
  assertBlinded(offDiff, "the context-off diff");

  // Calibration first, so a judge that cannot pass it never sees the real pair and
  // cannot contaminate the record with an answer that will be discarded anyway.
  const calibration = await options.model({ criterion, diffA: onDiff, diffB: onDiff });
  const calibrated = calibration.choice === "tie" || calibration.choice === "neither";

  const forward = await options.model({ criterion, diffA: onDiff, diffB: offDiff });
  const reverse = await options.model({ criterion, diffA: offDiff, diffB: onDiff });

  // In the forward order the context arm is A; in the reverse it is B. A consistent
  // preference for the context arm therefore reads "A" then "B".
  const forwardPrefersOn = forward.choice === "A";
  const reversePrefersOn = reverse.choice === "B";
  const forwardPrefersOff = forward.choice === "B";
  const reversePrefersOff = reverse.choice === "A";

  let choice: JudgeChoice = "tie";
  let consistent = true;
  if (forward.choice === "neither" && reverse.choice === "neither") {
    choice = "neither";
  } else if (forwardPrefersOn && reversePrefersOn) {
    choice = "A";
  } else if (forwardPrefersOff && reversePrefersOff) {
    choice = "B";
  } else if (forward.choice === "tie" && reverse.choice === "tie") {
    choice = "tie";
  } else {
    consistent = false;
  }

  const reason = !calibrated
    ? `calibration failed: the same diff shown as both A and B returned ${calibration.choice}, ` +
      "so this judge is reading presentation order and its verdict carries no information"
    : consistent
      ? `both orders agreed: ${choice}`
      : `orders disagreed (${forward.choice} then ${reverse.choice}) — recorded as a tie, because a ` +
        "preference that flips with position is position bias, not a preference";

  return {
    choice: calibrated && consistent ? choice : "tie",
    consistent,
    calibrated,
    forward,
    reverse,
    calibration,
    reason,
  };
}

/**
 * Which arm a verdict favours, in the arena's own vocabulary.
 *
 * Separate from the letter so no caller has to remember that A was the context arm
 * in the forward order — the kind of off-by-one that silently inverts a result.
 */
export function favours(verdict: PairwiseVerdict): "context-on" | "context-off" | "neither" | "tie" {
  if (!verdict.calibrated || !verdict.consistent) return "tie";
  if (verdict.choice === "A") return "context-on";
  if (verdict.choice === "B") return "context-off";
  return verdict.choice;
}
