import { expect, test } from "bun:test";
import {
  applyFindingsCap,
  DEFAULT_MAX_FINDINGS_PER_REVIEWER,
  DEFAULT_MAX_PARALLEL_REVIEWERS,
  DEFAULT_SPEND_CEILING_USD,
  evaluateSpendCap,
  planReviewerWaves,
  renderCapsMarkdown,
  spendFromTokens,
  type CappableFinding,
} from "./caps";
import type { ReviewFindingSeverity } from "./types";

function finding(
  id: string,
  severity: ReviewFindingSeverity = "minor",
  reviewer = "review-logic",
  blocking?: boolean,
): CappableFinding {
  return { id, reviewer, severity, ...(blocking === undefined ? {} : { blocking_merge: blocking }) };
}

function many(count: number, severity: ReviewFindingSeverity = "minor", reviewer = "review-logic"): CappableFinding[] {
  return Array.from({ length: count }, (_, index) => finding(`${reviewer}-${index + 1}`, severity, reviewer));
}

// ---------------------------------------------------------------------------
// AC5 — the findings cap, and its default in code
// ---------------------------------------------------------------------------

/**
 * The criterion literally: a default of 10, per reviewer, stated in code.
 *
 * Fails without the cap: with no cap all 25 findings survive, and with a default
 * that lives only in a skill file there is nothing here to import.
 */
test("AC5: the findings default is 10 per reviewer and lives in code", () => {
  expect(DEFAULT_MAX_FINDINGS_PER_REVIEWER).toBe(10);

  const result = applyFindingsCap(many(25));

  expect(result.retained).toHaveLength(10);
  expect(result.truncated).toHaveLength(15);
  expect(result.counts.limit).toBe(10);
});

test("AC5: the cap is PER reviewer, so a verbose reviewer cannot silence a terse one", () => {
  const result = applyFindingsCap([...many(14, "minor", "review-style"), ...many(3, "minor", "review-logic")]);

  const retainedByReviewer = (name: string) => result.retained.filter((item) => item.reviewer === name).length;
  expect(retainedByReviewer("review-style")).toBe(10);
  // Without a per-reviewer cap a single global 10 would have been spent by
  // review-style and review-logic would have kept nothing.
  expect(retainedByReviewer("review-logic")).toBe(3);
});

test("AC5: blockers are exempt and do not consume the budget", () => {
  const result = applyFindingsCap([...many(3, "blocker"), ...many(12, "minor")]);

  expect(result.retained.filter((item) => item.severity === "blocker")).toHaveLength(3);
  // 10 ordinary findings survive ALONGSIDE the three blockers, not instead of two of them.
  expect(result.retained.filter((item) => item.severity === "minor")).toHaveLength(10);
  expect(result.counts.exempt).toBe(3);
});

test("AC5: a finding the reviewer flagged blocking_merge is exempt too", () => {
  const flagged = finding("F-MERGE", "minor", "review-logic", true);
  const result = applyFindingsCap([...many(12), flagged]);

  expect(result.retained).toContain(flagged);
  expect(result.truncated).not.toContain(flagged);
});

test("AC5: truncation takes the least severe first", () => {
  const result = applyFindingsCap([...many(6, "info"), ...many(6, "major")], { limit: 6 });

  expect(result.retained.every((item) => item.severity === "major")).toBe(true);
  expect(result.truncated.every((item) => item.severity === "info")).toBe(true);
});

test("AC5: a reviewer at or under the limit is not touched and produces no drop row", () => {
  const result = applyFindingsCap(many(10));

  expect(result.truncated).toHaveLength(0);
  expect(result.drops).toHaveLength(0);
  expect(result.counts.reviewersTruncated).toBe(0);
});

// ---------------------------------------------------------------------------
// AC10 — the findings cap records what it dropped
// ---------------------------------------------------------------------------

/**
 * A count and the ids. Fails without the recording: a cap that truncates in
 * silence reads as "there was nothing more", which is the failure this whole
 * programme exists to end.
 */
test("AC10: the findings cap records the reviewer, the count and every truncated id", () => {
  const result = applyFindingsCap(many(13, "minor", "review-style"), { limit: 10 });

  expect(result.drops).toHaveLength(1);
  const drop = result.drops[0] as (typeof result.drops)[number];
  expect(drop.reviewer).toBe("review-style");
  expect(drop.seen).toBe(13);
  expect(drop.retained).toBe(10);
  expect(drop.truncated).toBe(3);
  expect(drop.truncatedIds).toHaveLength(3);
  expect(drop.truncatedBySeverity.minor).toBe(3);
  // Every truncated finding is named, not just counted.
  expect(new Set(drop.truncatedIds)).toEqual(new Set(result.truncated.map((item) => item.id)));
});

test("AC10: the rendered record names the truncated ids and the counts", () => {
  const result = applyFindingsCap(many(12, "minor", "review-style"), { limit: 10 });
  const markdown = renderCapsMarkdown({ findings: { counts: result.counts, drops: result.drops } });

  expect(markdown).toContain("### Findings cap");
  expect(markdown).toContain("findings_truncated: 2");
  expect(markdown).toContain("limit_per_reviewer: 10");
  for (const id of result.drops[0]?.truncatedIds ?? []) {
    expect(markdown).toContain(id);
  }
});

/** "Dropped nothing" and "never ran" are different facts — the scope.ts rule. */
test("AC10: a findings cap that never ran renders `not recorded`, not zero", () => {
  const markdown = renderCapsMarkdown({});

  expect(markdown).toContain("not recorded — no findings cap ran over this package.");
  expect(markdown).not.toContain("findings_truncated: 0");
});

test("AC10: a findings cap that ran and truncated nothing says exactly that", () => {
  const result = applyFindingsCap(many(4));
  const markdown = renderCapsMarkdown({ findings: { counts: result.counts, drops: result.drops } });

  expect(markdown).toContain("_the findings cap ran and truncated nothing_");
  expect(markdown).not.toContain("not recorded — no findings cap ran");
});

test("a negative or fractional findings cap is refused rather than rounded", () => {
  expect(() => applyFindingsCap([], { limit: -1 })).toThrow(/non-negative integer/);
  expect(() => applyFindingsCap([], { limit: 2.5 })).toThrow(/non-negative integer/);
});

// ---------------------------------------------------------------------------
// AC6 — the spend ceiling stops rather than proceeding
// ---------------------------------------------------------------------------

test("AC6: the default spend ceiling is 3 USD and lives in code", () => {
  expect(DEFAULT_SPEND_CEILING_USD).toBe(3);
  expect(evaluateSpendCap(0.5).ceiling).toBe(3);
  expect(evaluateSpendCap(0.5).currency).toBe("USD");
});

/** Fails without the cap: nothing would ever report `stop`. */
test("AC6: spend at or past the ceiling stops", () => {
  expect(evaluateSpendCap(3.4).stop).toBe(true);
  expect(evaluateSpendCap(3.4).status).toBe("over");
  expect(evaluateSpendCap(3.4).overBy).toBeCloseTo(0.4, 6);

  // A ceiling is the first value that is too much, so `>=` and not `>`.
  expect(evaluateSpendCap(3).stop).toBe(true);
  expect(evaluateSpendCap(2.99).stop).toBe(false);
});

test("AC6: unreported spend is `not-recorded`, never `under`", () => {
  const evaluation = evaluateSpendCap(undefined);

  expect(evaluation.status).toBe("not-recorded");
  expect(evaluation.spent).toBeUndefined();
  expect(evaluation.stop).toBe(false);
});

test("AC6: a caller holding token counts converts to the ceiling's unit", () => {
  const spend = spendFromTokens({
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    inputRatePerMillion: 3,
    outputRatePerMillion: 15,
  });

  expect(spend).toBeCloseTo(6, 6);
  expect(evaluateSpendCap(spend).stop).toBe(true);
});

test("AC10: the spend record distinguishes over, under and not recorded", () => {
  expect(renderCapsMarkdown({ spend: evaluateSpendCap(3.5) })).toContain("STOPPED at the ceiling");
  expect(renderCapsMarkdown({ spend: evaluateSpendCap(3.5) })).toContain("over_by: 0.5 USD");
  expect(renderCapsMarkdown({ spend: evaluateSpendCap(undefined) })).toContain("This is NOT `under`");
  expect(renderCapsMarkdown({})).toContain("not recorded — no spend ceiling was evaluated");
  expect(renderCapsMarkdown({ spend: evaluateSpendCap(1) })).toContain("status: under");
});

test("an invalid ceiling or spend is refused rather than silently ignored", () => {
  expect(() => evaluateSpendCap(1, { ceiling: 0 })).toThrow(/positive number/);
  expect(() => evaluateSpendCap(-1)).toThrow(/non-negative/);
});

// ---------------------------------------------------------------------------
// AC7 — the concurrency cap
// ---------------------------------------------------------------------------

const FOURTEEN_REVIEWERS = Array.from({ length: 14 }, (_, index) => `reviewer-${index + 1}`);

test("AC7: the default parallel dispatch cap is 4 and lives in code", () => {
  expect(DEFAULT_MAX_PARALLEL_REVIEWERS).toBe(4);

  const plan = planReviewerWaves(FOURTEEN_REVIEWERS);

  // Fails without the cap: an uncapped dispatch is one wave of fourteen.
  expect(plan.waves[0]).toHaveLength(4);
  expect(plan.waves).toHaveLength(4);
  expect(plan.queued).toBe(10);
});

test("AC7: a declared outstanding count shrinks the wave, which is the only way the cap reaches the nesting", () => {
  const plan = planReviewerWaves(FOURTEEN_REVIEWERS, { outstanding: 3 });

  expect(plan.effective).toBe(1);
  expect(plan.holdsAcrossNesting).toBe(true);
});

/**
 * The honest half of AC7, asserted rather than left to prose: with nothing
 * declared, the cap does NOT claim to hold across the nesting.
 */
test("AC7: with no declared outstanding count the plan states plainly that it does not hold across nesting", () => {
  const plan = planReviewerWaves(FOURTEEN_REVIEWERS);

  expect(plan.outstanding).toBeUndefined();
  expect(plan.holdsAcrossNesting).toBe(false);

  const markdown = renderCapsMarkdown({ concurrency: plan });
  expect(markdown).toContain("holds_across_nesting: no");
  expect(markdown).toContain("It does not bind the total across");
  expect(markdown).toContain("outstanding_declared: not recorded");
});

test("AC7: a caller already over the cap still gets a plan that finishes, one at a time", () => {
  const plan = planReviewerWaves(FOURTEEN_REVIEWERS, { cap: 4, outstanding: 9 });

  expect(plan.effective).toBe(1);
  expect(plan.waves).toHaveLength(14);
});

test("AC10: the concurrency cap records what it QUEUED, and queued is not dropped", () => {
  const plan = planReviewerWaves(FOURTEEN_REVIEWERS);
  const markdown = renderCapsMarkdown({ concurrency: plan });

  expect(markdown).toContain("reviewers_queued: 10");
  expect(markdown).toContain("were QUEUED, not dropped");
  // Every reviewer is still in the plan; the cap deferred, it did not discard.
  expect(plan.waves.flat()).toEqual(FOURTEEN_REVIEWERS);
});

test("AC10: an absent dispatch plan renders `not recorded`, not a one-wave plan", () => {
  const markdown = renderCapsMarkdown({});

  expect(markdown).toContain("not recorded — no dispatch plan was supplied");
  expect(markdown).not.toContain("reviewers_queued: 0");
});

test("a cap below 1 is refused: dispatching nothing is not a plan", () => {
  expect(() => planReviewerWaves(["a"], { cap: 0 })).toThrow(/positive integer/);
  expect(() => planReviewerWaves(["a"], { outstanding: -1 })).toThrow(/non-negative integer/);
});
