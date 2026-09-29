// What the review bot is worth, read off the managed review packages on disk. A ratio with no
// data behind it is null and prints as n/a: reporting 0% for "nobody has merged yet" would be a
// statement about the bot that nothing measured.

import { findingDispositionState } from "../managed";
import { callGitHub, type GitHubPort } from "../pr-comments";
import type { StructuredReviewFinding } from "../types";
import { readPullFacts } from "./fork-guard";
import { listReviewPackages, type ListedReview } from "./packages";
import { pullRecord, readBotState, writeBotState } from "./run";

export type ReviewRow = {
  reviewId: string;
  pull: string;
  round: number;
  head: string | null;
  findings: number;
  actedOn: number;
  dismissed: number;
  answeredDisagree: number;
  unknown: number;
  precision: number | null;
  mergedAt: string | null;
  resolvedBeforeMerge: number | null;
};

export type BotMetrics = {
  reviews: number;
  pulls: number;
  raised: number;
  actedOn: number;
  dismissed: { incorrect: number; wontFix: number; outOfScope: number; deprioritised: number };
  answeredDisagree: number;
  unknown: number;
  open: number;
  precision: number | null;
  resolvedBeforeMerge: { resolved: number; total: number; ratio: number | null };
  rows: ReviewRow[];
};

export function formatRatio(ratio: number | null): string {
  return ratio === null ? "n/a" : `${Math.round(ratio * 100)}%`;
}

function ratioOf(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function isOwn(finding: StructuredReviewFinding): boolean {
  return finding.source !== "external";
}

type Counts = { actedOn: number; incorrect: number; wontFix: number; outOfScope: number; deprioritised: number; answeredDisagree: number; unknown: number };

function emptyCounts(): Counts {
  return { actedOn: 0, incorrect: 0, wontFix: 0, outOfScope: 0, deprioritised: 0, answeredDisagree: 0, unknown: 0 };
}

function tally(counts: Counts, finding: StructuredReviewFinding): void {
  switch (findingDispositionState(finding)) {
    case "acted-on":
      counts.actedOn += 1;
      break;
    case "dismissed-incorrect":
      counts.incorrect += 1;
      break;
    case "dismissed-wont-fix":
      counts.wontFix += 1;
      break;
    case "dismissed-out-of-scope":
      counts.outOfScope += 1;
      break;
    case "dismissed-deprioritised":
      counts.deprioritised += 1;
      break;
    case "answered-disagree":
      counts.answeredDisagree += 1;
      break;
    default:
      counts.unknown += 1;
  }
}

function precisionOf(counts: Counts): number | null {
  return ratioOf(counts.actedOn, counts.actedOn + counts.incorrect);
}

function stampOf(review: ListedReview): string {
  return review.manifest.updatedAt ?? review.manifest.createdAt ?? "";
}

// The package's updatedAt stands in for "when the outcome was recorded": a disposition carries
// no timestamp of its own, and every write to a package refreshes updatedAt.
export async function computeBotMetrics(cwd: string): Promise<BotMetrics> {
  const listed = (await listReviewPackages(cwd)).filter((review) => review.repo !== null && review.number !== null);
  const seen = new Set<string>();
  const total = emptyCounts();
  const rows: ReviewRow[] = [];
  const roundOf = new Map<string, number>();
  const oldestFirst = [...listed].sort((a, b) => (a.manifest.createdAt ?? stampOf(a)).localeCompare(b.manifest.createdAt ?? stampOf(b)));
  for (const review of oldestFirst) {
    const key = `${review.repo}#${review.number}`;
    roundOf.set(review.reviewId, (roundOf.get(key) ?? 0) + 1);
    roundOf.set(key, (roundOf.get(key) ?? 0) + 1);
  }

  const mergedAtByPull = new Map<string, string | null>();
  for (const review of listed) {
    const key = `${review.repo}#${review.number}`;
    if (mergedAtByPull.has(key)) continue;
    const state = await readBotState(cwd, review.repo as string, review.number as number);
    mergedAtByPull.set(key, state.pull?.mergedAt ?? null);
  }

  let resolved = 0;
  let mergedFindings = 0;
  for (const review of listed) {
    const pull = `${review.repo}#${review.number}`;
    const own = review.findings.filter(isOwn).filter((finding) => {
      const identity = finding.global_id ?? `${review.reviewId}#${finding.id}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    const counts = emptyCounts();
    for (const finding of own) {
      tally(counts, finding);
      tally(total, finding);
    }
    const mergedAt = mergedAtByPull.get(pull) ?? null;
    let rowResolved: number | null = null;
    if (mergedAt !== null) {
      const before = stampOf(review) <= mergedAt;
      rowResolved = own.filter((finding) => before && findingDispositionState(finding) !== "unknown").length;
      mergedFindings += own.length;
      resolved += rowResolved;
    }
    rows.push({
      reviewId: review.reviewId,
      pull,
      round: roundOf.get(review.reviewId) ?? 1,
      head: review.manifest.target.head ?? null,
      findings: own.length,
      actedOn: counts.actedOn,
      dismissed: counts.incorrect + counts.wontFix + counts.outOfScope + counts.deprioritised,
      answeredDisagree: counts.answeredDisagree,
      unknown: counts.unknown,
      precision: precisionOf(counts),
      mergedAt,
      resolvedBeforeMerge: rowResolved,
    });
  }

  const raised = total.actedOn + total.incorrect + total.wontFix + total.outOfScope + total.deprioritised + total.answeredDisagree + total.unknown;
  return {
    reviews: listed.length,
    pulls: new Set(listed.map((review) => `${review.repo}#${review.number}`)).size,
    raised,
    actedOn: total.actedOn,
    dismissed: { incorrect: total.incorrect, wontFix: total.wontFix, outOfScope: total.outOfScope, deprioritised: total.deprioritised },
    answeredDisagree: total.answeredDisagree,
    unknown: total.unknown,
    open: total.unknown,
    precision: precisionOf(total),
    resolvedBeforeMerge: { resolved, total: mergedFindings, ratio: ratioOf(resolved, mergedFindings) },
    rows,
  };
}

export function renderBotMetrics(metrics: BotMetrics): string {
  const precisionNote =
    metrics.precision === null ? "" : ` (${metrics.actedOn} acted on, ${metrics.dismissed.incorrect} dismissed as incorrect)`;
  const mergedNote =
    metrics.resolvedBeforeMerge.ratio === null
      ? " (no merged pull request on record; run with --refresh to read merge state)"
      : ` (${metrics.resolvedBeforeMerge.resolved} of ${metrics.resolvedBeforeMerge.total} findings on merged pull requests had an outcome recorded by the merge)`;
  return `${[
    `Review metrics: ${metrics.reviews} review(s) on ${metrics.pulls} pull request(s).`,
    `Findings raised: ${metrics.raised}`,
    `  acted on: ${metrics.actedOn}`,
    `  dismissed: incorrect ${metrics.dismissed.incorrect}, won't fix ${metrics.dismissed.wontFix}, out of scope ${metrics.dismissed.outOfScope}, deprioritised ${metrics.dismissed.deprioritised}`,
    `  answered, disagree: ${metrics.answeredDisagree}`,
    `  still unknown (open): ${metrics.unknown}`,
    `Precision: ${formatRatio(metrics.precision)}${precisionNote}`,
    `Resolved before merge: ${formatRatio(metrics.resolvedBeforeMerge.ratio)}${mergedNote}`,
  ].join("\n")}\n`;
}

export async function refreshPullStates(
  cwd: string,
  port: GitHubPort,
  now: Date,
): Promise<{ refreshed: number; failed: string[] }> {
  const pulls = new Map<string, { repo: string; number: number }>();
  for (const review of await listReviewPackages(cwd)) {
    if (review.repo !== null && review.number !== null) pulls.set(`${review.repo}#${review.number}`, { repo: review.repo, number: review.number });
  }
  let refreshed = 0;
  const failed: string[] = [];
  for (const [key, pull] of pulls) {
    try {
      const raw = await callGitHub(port, { method: "GET", path: `repos/${pull.repo}/pulls/${pull.number}` });
      const state = await readBotState(cwd, pull.repo, pull.number);
      state.pull = pullRecord(readPullFacts(raw), now);
      await writeBotState(cwd, state);
      refreshed += 1;
    } catch (error) {
      failed.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { refreshed, failed };
}
