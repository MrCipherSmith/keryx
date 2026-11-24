import type { ReviewAttemptSummary, ReviewFreshness, ReviewSource, ReviewState, ReviewSummary } from "../../../../src/review/review-entity";

export type ReviewColumn = "running" | "waiting" | "behind" | "published" | "closed";

export const COLUMNS: Record<ReviewColumn, string> = {
  running: "Running",
  waiting: "Waiting on you",
  behind: "Behind",
  published: "Published",
  closed: "Closed",
};

export const STATE_LABEL: Record<ReviewState, string> = {
  queued: "Queued",
  running: "Running",
  needs_answer: "Needs your answer",
  stopped: "Stopped",
  ready: "Ready",
  published: "Published",
  closed: "Closed",
};

export const SOURCE_LABEL: Record<ReviewSource, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  existing: "Existing review",
};

/** A freshness kind this build does not know reads as neither current nor behind. */
export function isBehind(freshness: ReviewFreshness | { kind: string }): freshness is Extract<ReviewFreshness, { kind: "behind" }> {
  return freshness.kind === "behind";
}

/** Column choice order: closed → running → needs_answer → behind → by state. */
export function reviewColumn(review: Pick<ReviewSummary, "state" | "freshness">): ReviewColumn {
  const { state } = review;
  if (state === "closed") return "closed";
  if (state === "queued" || state === "running") return "running";
  if (state === "needs_answer") return "waiting";
  if (isBehind(review.freshness)) return "behind";
  return state === "published" ? "published" : "waiting";
}

export function freshnessLabel(freshness: ReviewFreshness | { kind: string }): string {
  if (freshness.kind === "current") return "current";
  if (!isBehind(freshness)) return "";
  const amount = freshness.commits === null ? "behind" : `behind ${freshness.commits}`;
  return freshness.rewritten ? `${amount} · history rewritten` : amount;
}

/** The newest attempt that produced a reviewed result, across rounds (rounds and attempts are newest first). */
export function latestReviewed(review: Pick<ReviewSummary, "rounds">): ReviewAttemptSummary | undefined {
  for (const round of review.rounds) {
    const attempt = round.attempts.find(item => item.reviewed !== null);
    if (attempt) return attempt;
  }
  return undefined;
}

/** The reviewed head commit, short; the latest requested head when no attempt finished with a result. */
export function reviewedCommit(review: Pick<ReviewSummary, "rounds">): string {
  const head = latestReviewed(review)?.reviewed?.headSha ?? review.rounds[0]?.headSha ?? "";
  return head.slice(0, 7);
}

const SEVERITIES = ["blocker", "major", "minor", "info"] as const;

export function findingsLabel(findings: ReviewSummary["findings"]): string {
  if (!findings) return "";
  const parts = SEVERITIES.filter(severity => (findings[severity] ?? 0) > 0).map(severity => `${findings[severity]} ${severity}`);
  return parts.length ? parts.join(" · ") : "No findings";
}

export function publicationLabel(review: Pick<ReviewSummary, "publication" | "state">): string {
  if (review.publication === "published") return "Published on GitHub";
  if (review.publication === "skipped") return "Publication skipped";
  if (review.state === "ready") return "Not published";
  return "";
}

export function reviewTitle(review: Pick<ReviewSummary, "number" | "card">): string {
  return review.card?.title || `Pull request #${review.number}`;
}

export interface ReviewFilters {
  state: ReviewState | "";
  freshness: "current" | "behind" | "";
  source: ReviewSource | "";
}

export const EMPTY_REVIEW_FILTERS: ReviewFilters = { state: "", freshness: "", source: "" };

export function filtersActive(filters: ReviewFilters): boolean {
  return !!(filters.state || filters.freshness || filters.source);
}

/** Search matches the PR title, or its number with or without `#`. */
export function matchesSearch(review: Pick<ReviewSummary, "number" | "card">, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const number = text.replace(/^#/, "");
  if (/^\d+$/.test(number)) return String(review.number).startsWith(number);
  return reviewTitle(review).toLowerCase().includes(text);
}

export function filterReviewList(reviews: readonly ReviewSummary[], filters: ReviewFilters, query: string, showClosed: boolean): ReviewSummary[] {
  return reviews.filter(review =>
    (showClosed || review.state !== "closed") &&
    (!filters.state || review.state === filters.state) &&
    (!filters.freshness || (filters.freshness === "behind" ? isBehind(review.freshness) : review.freshness.kind === "current")) &&
    (!filters.source || review.source === filters.source) &&
    matchesSearch(review, query));
}

export function groupByColumn(reviews: readonly ReviewSummary[], showClosed: boolean): Array<[ReviewColumn, ReviewSummary[]]> {
  const groups: Record<ReviewColumn, ReviewSummary[]> = { running: [], waiting: [], behind: [], published: [], closed: [] };
  for (const review of reviews) groups[reviewColumn(review)].push(review);
  return (Object.keys(COLUMNS) as ReviewColumn[]).filter(column => column !== "closed" || showClosed).map(column => [column, groups[column]]);
}
