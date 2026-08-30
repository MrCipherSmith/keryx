/**
 * The bounds — findings, spend, concurrency — and the record each one leaves.
 *
 * # Why this file exists
 *
 * Nothing in the review pipeline was capped. `budget.max_findings` was
 * schema-required with no default anywhere, so every caller had to invent one;
 * there was no token or currency ceiling at all; and `review-orchestrator`
 * dispatched reviewers in parallel with no wave size, while itself running
 * nested under `flow-orchestrator` and `job-orchestrator`.
 *
 * # The rule every cap here obeys
 *
 * **A cap records what it dropped.** Flow 202's self-review found that the
 * component whose failure is silent by construction was the one that failed, and
 * that a real record had been overwritten by the false sentence "no pre-filter
 * scope was supplied". A findings cap that truncates without saying so reads as
 * "there was nothing more"; a concurrency cap that queues without saying so
 * reads as "that is all we dispatched"; a spend cap that stops without saying so
 * reads as "the review finished". All three are the same defect.
 *
 * `src/review/scope.ts` already does this correctly for the pre-filter, and this
 * module follows it deliberately, including the part that is easy to miss: a
 * stage that did not run prints **`not recorded`**, never `0`. "Dropped nothing"
 * and "never ran" are different facts, and a record that renders them
 * identically is the same defect as `dismissed-out-of-scope: 0` meaning "not
 * written down".
 */

import type { ReviewFindingSeverity } from "./types";

// ---------------------------------------------------------------------------
// Findings cap
// ---------------------------------------------------------------------------

/**
 * How many non-blocker findings one reviewer may put into a review record.
 *
 * **10, per reviewer, blockers exempt.** In code rather than in prose because a
 * default stated only in a skill file is a default every caller has to
 * re-implement, and `budget.max_findings` has been schema-required with no
 * stated default long enough to prove that nobody does.
 *
 * Per *reviewer* rather than per *review*: a single global cap on a 14-reviewer
 * fan-out is decided by dispatch order — the reviewers that happen to run first
 * spend the whole budget and the rest are truncated whatever they found. A
 * per-reviewer cap bounds the report without letting one verbose reviewer
 * silence a terse one.
 *
 * 10 is a reading budget, not a quality claim: it is roughly what an operator
 * will actually read from one reviewer before triaging, and the point of a cap
 * is to make the report finishable. It is deliberately not tuned to a measured
 * distribution, because none exists — flow 202 established that the recorded
 * corpus measures the triage, not the reviewers.
 */
export const DEFAULT_MAX_FINDINGS_PER_REVIEWER = 10;

/**
 * Most severe first. Used only to decide what a truncating reviewer keeps, so
 * that a cap never drops a `major` in favour of an `info`.
 */
const SEVERITY_RANK: Record<ReviewFindingSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/** The finding shape the findings cap needs, structurally. */
export type CappableFinding = {
  id: string;
  reviewer: string;
  severity: ReviewFindingSeverity;
  /** A finding the reviewer declared merge-blocking. Exempt like `blocker`. */
  blocking_merge?: boolean | undefined;
};

/**
 * What one reviewer's cap removed.
 *
 * `truncatedIds` is present for the same reason `ScopeDrop.detail` is: a count
 * says how much vanished and never which, and "truncated: 7" is
 * indistinguishable from seven duplicates and seven real findings.
 */
export type FindingsCapDrop = {
  reviewer: string;
  /** Findings this reviewer produced, before the cap. */
  seen: number;
  /** Kept: every exempt finding, plus the first `limit` of the rest. */
  retained: number;
  truncated: number;
  /** Exempt findings — blockers, and anything flagged `blocking_merge`. */
  exempt: number;
  /** Display ids of the truncated findings, most severe first. */
  truncatedIds: string[];
  truncatedBySeverity: Record<ReviewFindingSeverity, number>;
};

export type FindingsCapCounts = {
  limit: number;
  seen: number;
  retained: number;
  truncated: number;
  /** Findings the cap was forbidden to touch. */
  exempt: number;
  /** Reviewers that hit the cap. 0 with `seen > 0` means "ran, truncated nothing". */
  reviewersTruncated: number;
};

export type FindingsCapResult<T> = {
  retained: T[];
  truncated: T[];
  drops: FindingsCapDrop[];
  counts: FindingsCapCounts;
};

export type FindingsCapOptions = {
  /** Defaults to {@link DEFAULT_MAX_FINDINGS_PER_REVIEWER}. */
  limit?: number | undefined;
};

function emptySeverityHistogram(): Record<ReviewFindingSeverity, number> {
  return { blocker: 0, major: 0, minor: 0, info: 0 };
}

/**
 * Cap each reviewer's findings at `limit`, exempting the merge-blocking ones.
 *
 * Two exemptions, not one. `severity: "blocker"` is the canonical rubric's
 * merge-blocking class. `blocking_merge: true` is the reviewer saying the same
 * thing on the record itself, and a cap that dropped one of those would remove
 * the single finding the whole round exists to surface. Neither exempt finding
 * consumes the budget, so a reviewer with three blockers still gets its full ten
 * ordinary findings — the cap bounds reading effort, and a blocker was never the
 * part that made a report unreadable.
 *
 * Order within a reviewer is severity-major, input-order-minor, so what a
 * truncating reviewer loses is always its least severe work and the choice does
 * not depend on which order the caller happened to concatenate its findings in.
 * Input order is otherwise preserved in `retained`, because the report reads in
 * the order the reviewer wrote it.
 */
export function applyFindingsCap<T extends CappableFinding>(
  findings: readonly T[],
  options: FindingsCapOptions = {},
): FindingsCapResult<T> {
  const limit = options.limit ?? DEFAULT_MAX_FINDINGS_PER_REVIEWER;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `Invalid findings cap: ${limit}. Expected a non-negative integer; the default is ${DEFAULT_MAX_FINDINGS_PER_REVIEWER} per reviewer.`,
    );
  }

  const byReviewer = new Map<string, T[]>();
  for (const finding of findings) {
    const key = finding.reviewer;
    const bucket = byReviewer.get(key);
    if (bucket === undefined) {
      byReviewer.set(key, [finding]);
    } else {
      bucket.push(finding);
    }
  }

  const truncatedSet = new Set<T>();
  const drops: FindingsCapDrop[] = [];

  for (const [reviewer, bucket] of byReviewer) {
    const exempt = bucket.filter(isExemptFromFindingsCap);
    const capped = bucket.filter((finding) => !isExemptFromFindingsCap(finding));
    if (capped.length <= limit) {
      continue;
    }
    // Stable by construction: `index` breaks every severity tie in input order.
    const ordered = capped
      .map((finding, index) => ({ finding, index }))
      .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index);
    const dropped = ordered.slice(limit).map((entry) => entry.finding);
    const truncatedBySeverity = emptySeverityHistogram();
    for (const finding of dropped) {
      truncatedSet.add(finding);
      truncatedBySeverity[finding.severity] += 1;
    }
    drops.push({
      reviewer,
      seen: bucket.length,
      retained: bucket.length - dropped.length,
      truncated: dropped.length,
      exempt: exempt.length,
      truncatedIds: dropped.map((finding) => finding.id),
      truncatedBySeverity,
    });
  }

  const retained = findings.filter((finding) => !truncatedSet.has(finding));
  const truncated = findings.filter((finding) => truncatedSet.has(finding));
  return {
    retained,
    truncated,
    drops,
    counts: {
      limit,
      seen: findings.length,
      retained: retained.length,
      truncated: truncated.length,
      exempt: findings.filter(isExemptFromFindingsCap).length,
      reviewersTruncated: drops.length,
    },
  };
}

/** Merge-blocking, and therefore never truncated. */
function isExemptFromFindingsCap(finding: CappableFinding): boolean {
  return finding.severity === "blocker" || finding.blocking_merge === true;
}

// ---------------------------------------------------------------------------
// Spend cap
// ---------------------------------------------------------------------------

/**
 * The spend ceiling for one review round, in US dollars.
 *
 * **Currency, not tokens.** The argument, recorded here rather than only in the
 * flow journal because this is the line a later reader will want to change:
 *
 * - A token count is not comparable across models. The same 200k tokens differ
 *   by more than an order of magnitude in cost between the cheapest and the most
 *   capable model in a single vendor's line-up, so one token ceiling is either
 *   inert for the small model or ruinous for the large one. A ceiling whose
 *   meaning depends on an unrecorded model choice is not a ceiling.
 * - Currency is the unit the operator's budget is actually denominated in, and
 *   the unit a harness reports back. It is also the unit the decision is made
 *   in: nobody stops a review because it used tokens.
 * - Steps and rounds are already bounded (AC8, and the round bound is 3). A
 *   token cap would be a third bound in the same shape as the first two —
 *   "how much work" — while leaving "how much money" unbounded, which is the
 *   only one of the three that can surprise anybody.
 * - The conversion runs one way. Token counts plus a stated per-model rate give
 *   currency; currency alone cannot be turned back into tokens. So take the
 *   convertible unit and let a caller that holds only token counts convert.
 *
 * $3.00 follows SWE-agent, which chose a $3/instance dollar cap over a step
 * budget for these reasons, and the unit matches: a keryx review round is one
 * target and one reviewer fan-out, the analogue of one SWE-agent instance.
 */
export const DEFAULT_SPEND_CEILING_USD = 3;

export type SpendCapStatus =
  /** Spend was reported and is below the ceiling. */
  | "under"
  /** Spend was reported and has met or passed the ceiling. STOP AND ASK. */
  | "over"
  /** Nobody reported a spend. NOT the same fact as `under`. */
  | "not-recorded";

export type SpendCapEvaluation = {
  ceiling: number;
  currency: "USD";
  /** `undefined` when nobody reported one. Never coerced to 0. */
  spent: number | undefined;
  status: SpendCapStatus;
  /** How far past the ceiling. `undefined` unless `status` is `over`. */
  overBy: number | undefined;
  /**
   * True only for `over`. The pipeline must stop and ask the operator rather
   * than proceed: this is a cap that refuses, not a cap that trims.
   */
  stop: boolean;
};

export type SpendCapOptions = {
  /** Defaults to {@link DEFAULT_SPEND_CEILING_USD}. */
  ceiling?: number | undefined;
};

/**
 * Compare reported spend against the ceiling.
 *
 * `spent === undefined` is `not-recorded`, and deliberately not `under`. A
 * pipeline that never reported its spend has not demonstrated it stayed inside
 * the ceiling; it has demonstrated nothing, and a record that prints `under` for
 * it is making a claim nobody checked.
 *
 * The comparison is `>=`, not `>`: a ceiling is the first value that is too
 * much. Spending exactly the ceiling and continuing is how a bound gets crossed
 * on the next call with nothing having reported it.
 */
export function evaluateSpendCap(
  spent: number | undefined,
  options: SpendCapOptions = {},
): SpendCapEvaluation {
  const ceiling = options.ceiling ?? DEFAULT_SPEND_CEILING_USD;
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    throw new Error(
      `Invalid spend ceiling: ${ceiling}. Expected a positive number of US dollars; the default is ${DEFAULT_SPEND_CEILING_USD}.`,
    );
  }
  if (spent === undefined) {
    return { ceiling, currency: "USD", spent: undefined, status: "not-recorded", overBy: undefined, stop: false };
  }
  if (!Number.isFinite(spent) || spent < 0) {
    throw new Error(`Invalid reported spend: ${spent}. Expected a non-negative number of US dollars.`);
  }
  if (spent >= ceiling) {
    return {
      ceiling,
      currency: "USD",
      spent,
      status: "over",
      overBy: Number((spent - ceiling).toFixed(6)),
      stop: true,
    };
  }
  return { ceiling, currency: "USD", spent, status: "under", overBy: undefined, stop: false };
}

/** What a caller holding token counts and a rate must do to use the ceiling. */
export function spendFromTokens(input: {
  inputTokens: number;
  outputTokens: number;
  /** USD per million input tokens. */
  inputRatePerMillion: number;
  /** USD per million output tokens. */
  outputRatePerMillion: number;
}): number {
  const { inputTokens, outputTokens, inputRatePerMillion, outputRatePerMillion } = input;
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${name}: ${value}. Expected a non-negative number.`);
    }
  }
  return (inputTokens * inputRatePerMillion + outputTokens * outputRatePerMillion) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Concurrency cap
// ---------------------------------------------------------------------------

/**
 * How many reviewer subagents one dispatch plan may have in flight.
 *
 * **4.** Chosen with the nesting in mind and with the honest limit of that
 * choice stated below.
 *
 * The numbers it is chosen against: the harness allows on the order of 20
 * concurrent subagents; `review-orchestrator` has fourteen reviewers to
 * dispatch; and it runs nested under `flow-orchestrator`, which runs nested
 * under `job-orchestrator`. Three levels each opening an unbounded fan-out is
 * how a fourteen-way dispatch becomes a rate-limit incident. 4 gives four
 * waves for a full reviewer set and leaves room for two enclosing levels to
 * hold work of their own without the total approaching the harness limit.
 *
 * It is not tuned to a measured throughput number, and claiming otherwise would
 * be the kind of unbacked precision this programme exists to remove. It is a
 * conservative bound picked so that the *nested worst case* stays inside a limit
 * that is known.
 */
export const DEFAULT_MAX_PARALLEL_REVIEWERS = 4;

export type ConcurrencyPlan = {
  cap: number;
  /**
   * Subagents the CALLER declared it already has in flight, `undefined` when it
   * declared nothing.
   *
   * This is the whole nesting story, and it is a declaration rather than an
   * observation. See {@link ConcurrencyPlan.holdsAcrossNesting}.
   */
  outstanding: number | undefined;
  /** Wave size after subtracting `outstanding`. Never below 1. */
  effective: number;
  /** The dispatch waves, in order. Wave 1 runs first; the rest are queued. */
  waves: string[][];
  /** Reviewers not in wave 1 — deferred, not dropped, and counted. */
  queued: number;
  /**
   * Whether the cap binds the total number of live reviewer subagents across the
   * `job-orchestrator` -> `flow-orchestrator` -> `review-orchestrator` nesting.
   *
   * **It does not, unless every enclosing orchestrator declares its in-flight
   * count.** Said plainly rather than implied: keryx is a CLI invoked once per
   * command. It has no view of subagents running inside another orchestrator's
   * process, the harness reports no live subagent count to it, and there is no
   * lease or lock between the three levels. What this plan bounds with certainty
   * is one dispatch plan. It bounds the nested total only when a parent passes
   * its own in-flight count as `outstanding` — and even then it is bounded by a
   * number the parent asserted, which nothing here verifies.
   *
   * `false` with `outstanding: undefined` therefore means "the cap held for this
   * plan and nobody told us what else was running", which is exactly what the
   * record says.
   */
  holdsAcrossNesting: boolean;
};

export type ConcurrencyPlanOptions = {
  /** Defaults to {@link DEFAULT_MAX_PARALLEL_REVIEWERS}. */
  cap?: number | undefined;
  /** Subagents the caller already has in flight, if it knows. */
  outstanding?: number | undefined;
};

/**
 * Partition reviewers into dispatch waves of at most the effective cap.
 *
 * Nothing is dropped: a reviewer past the first wave is *queued*, and `queued`
 * is on the record so a plan that deferred ten reviewers cannot read as a plan
 * that dispatched four and found nothing else to run.
 *
 * `effective` floors at 1 rather than 0. A caller that declares more outstanding
 * subagents than the cap allows has already exceeded it, and answering "dispatch
 * nothing" would deadlock the round; one at a time is the slowest plan that
 * still finishes, and the `outstanding` figure is on the record for whoever
 * wants to explain why it crawled.
 */
export function planReviewerWaves(
  reviewers: readonly string[],
  options: ConcurrencyPlanOptions = {},
): ConcurrencyPlan {
  const cap = options.cap ?? DEFAULT_MAX_PARALLEL_REVIEWERS;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(
      `Invalid concurrency cap: ${cap}. Expected a positive integer; the default is ${DEFAULT_MAX_PARALLEL_REVIEWERS}.`,
    );
  }
  const outstanding = options.outstanding;
  if (outstanding !== undefined && (!Number.isInteger(outstanding) || outstanding < 0)) {
    throw new Error(`Invalid outstanding subagent count: ${outstanding}. Expected a non-negative integer.`);
  }
  const effective = Math.max(1, cap - (outstanding ?? 0));
  const waves: string[][] = [];
  for (let index = 0; index < reviewers.length; index += effective) {
    waves.push([...reviewers.slice(index, index + effective)]);
  }
  return {
    cap,
    outstanding,
    effective,
    waves,
    queued: Math.max(0, reviewers.length - (waves[0]?.length ?? 0)),
    holdsAcrossNesting: outstanding !== undefined,
  };
}

// ---------------------------------------------------------------------------
// The record (AC10)
// ---------------------------------------------------------------------------

/**
 * Everything the caps did, in the form the review record carries.
 *
 * Every field is optional and every absent one renders as `not recorded`, never
 * as a zero. A cap that did not run and a cap that removed nothing are different
 * facts about a review, and only one of them means "the report is complete".
 */
export type ReviewCapsRecord = {
  findings?: { counts: FindingsCapCounts; drops: readonly FindingsCapDrop[] } | undefined;
  spend?: SpendCapEvaluation | undefined;
  concurrency?: ConcurrencyPlan | undefined;
};

/**
 * `## Caps` — what each cap dropped, deferred or stopped, with a count.
 *
 * Written on every package, including the ones where nothing was capped, for the
 * same reason the stage counts are: the sentence "nothing was truncated" is only
 * worth anything if it is written by something that would have said otherwise.
 */
export function renderCapsMarkdown(record: ReviewCapsRecord): string {
  const lines: string[] = [];
  lines.push("## Caps");
  lines.push("");
  lines.push("Each cap says what it removed, deferred or stopped, with a count. An");
  lines.push("absent cap prints `not recorded`, never `0`: a cap that never ran and a");
  lines.push("cap that dropped nothing are different facts.");
  lines.push("");

  lines.push("### Findings cap");
  lines.push("");
  if (record.findings === undefined) {
    lines.push("not recorded — no findings cap ran over this package.");
    lines.push("This is NOT `truncated 0`: nothing was bounded, so nothing is known.");
  } else {
    const { counts, drops } = record.findings;
    lines.push(`limit_per_reviewer: ${counts.limit}`);
    lines.push(`findings_seen: ${counts.seen}`);
    lines.push(`findings_retained: ${counts.retained}`);
    lines.push(`findings_truncated: ${counts.truncated}`);
    lines.push(`blockers_exempt: ${counts.exempt}`);
    lines.push(`reviewers_truncated: ${counts.reviewersTruncated}`);
    lines.push("");
    if (drops.length === 0) {
      lines.push("_the findings cap ran and truncated nothing_");
    } else {
      lines.push("| reviewer | seen | retained | truncated | exempt | truncated ids |");
      lines.push("|---|---|---|---|---|---|");
      for (const drop of drops) {
        lines.push(
          `| ${escapePipes(drop.reviewer)} | ${drop.seen} | ${drop.retained} | ${drop.truncated} | ${drop.exempt} | ${escapePipes(
            drop.truncatedIds.join(", "),
          )} |`,
        );
      }
      lines.push("");
      lines.push(
        "Truncated findings are removed from `findings.json`. The ids above are the whole of what was dropped — a truncating cap that named no ids would read as \"there was nothing more\".",
      );
    }
  }
  lines.push("");

  lines.push("### Spend ceiling");
  lines.push("");
  if (record.spend === undefined) {
    lines.push("not recorded — no spend ceiling was evaluated for this package.");
  } else {
    const spend = record.spend;
    lines.push(`ceiling: ${spend.ceiling} ${spend.currency}`);
    lines.push(`spent: ${spend.spent === undefined ? "not recorded" : `${spend.spent} ${spend.currency}`}`);
    lines.push(`status: ${spend.status}`);
    if (spend.status === "not-recorded") {
      lines.push("");
      lines.push("Nobody reported a spend. This is NOT `under`: staying inside the");
      lines.push("ceiling was never demonstrated, only never contradicted.");
    } else if (spend.status === "over") {
      lines.push(`over_by: ${spend.overBy} ${spend.currency}`);
      lines.push("");
      lines.push("STOPPED at the ceiling and asked the operator. Work after this point");
      lines.push("was not done, and the report is incomplete by that much.");
    }
  }
  lines.push("");

  lines.push("### Concurrency cap");
  lines.push("");
  if (record.concurrency === undefined) {
    lines.push("not recorded — no dispatch plan was supplied for this package.");
  } else {
    const plan = record.concurrency;
    lines.push(`cap: ${plan.cap}`);
    lines.push(`outstanding_declared: ${plan.outstanding === undefined ? "not recorded" : plan.outstanding}`);
    lines.push(`effective_wave_size: ${plan.effective}`);
    lines.push(`waves: ${plan.waves.length}`);
    lines.push(`reviewers_queued: ${plan.queued}`);
    lines.push(`holds_across_nesting: ${plan.holdsAcrossNesting ? "yes (against the declared count)" : "no"}`);
    if (!plan.holdsAcrossNesting) {
      lines.push("");
      lines.push("The cap bound THIS dispatch plan. It does not bind the total across");
      lines.push("`job-orchestrator` -> `flow-orchestrator` -> `review-orchestrator`: no");
      lines.push("enclosing orchestrator declared its in-flight count, and keryx has no");
      lines.push("way to observe one. Said plainly rather than implied.");
    }
    if (plan.waves.length > 1) {
      lines.push("");
      lines.push("| wave | reviewers |");
      lines.push("|---|---|");
      plan.waves.forEach((wave, index) => {
        lines.push(`| ${index + 1} | ${escapePipes(wave.join(", "))} |`);
      });
      lines.push("");
      lines.push(`${plan.queued} reviewer(s) were QUEUED, not dropped: they run in a later wave.`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}
