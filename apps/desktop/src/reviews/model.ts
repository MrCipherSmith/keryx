import type { ReviewFreshness, ReviewSource, ReviewState, ReviewSummary } from "../../../../src/review/review-entity";

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
  session: "Session",
};

/** Only `behind` is behind: `unknown` (PR head unread) and a kind this build does not know are not. */
export function isBehind(freshness: ReviewFreshness | { kind: string }): freshness is Extract<ReviewFreshness, { kind: "behind" }> {
  return freshness.kind === "behind";
}

/** Column choice order: closed or archived → running → needs_answer → behind → by state. An unknown PR head goes by state. */
export function reviewColumn(review: Pick<ReviewSummary, "state" | "freshness"> & { archived?: boolean }): ReviewColumn {
  const { state } = review;
  if (state === "closed" || review.archived) return "closed";
  if (state === "queued" || state === "running") return "running";
  if (state === "needs_answer") return "waiting";
  if (isBehind(review.freshness)) return "behind";
  return state === "published" ? "published" : "waiting";
}

export function freshnessLabel(freshness: ReviewFreshness | { kind: string }): string {
  if (freshness.kind === "current") return "current";
  if (freshness.kind === "unknown") return "head unknown";
  if (!isBehind(freshness)) return "";
  const amount = freshness.commits === null ? "behind" : `behind ${freshness.commits}`;
  return freshness.rewritten ? `${amount} · history rewritten` : amount;
}

/** The reviewed head commit, short: the domain's reference range (the one freshness is measured from);
 * the latest requested head when no attempt finished with a result. */
export function reviewedCommit(review: Pick<ReviewSummary, "reviewed" | "rounds">): string {
  const head = review.reviewed?.headSha ?? review.rounds[0]?.headSha ?? "";
  return head.slice(0, 7);
}

/** The state shown for a Review: an archived one reads "Archived" (it is listed under Show closed). */
export function reviewStateLabel(review: Pick<ReviewSummary, "state"> & { archived?: boolean }): string {
  return review.archived ? "Archived" : STATE_LABEL[review.state] ?? review.state;
}

/** Listed only under Show closed: closed locally, or every attempt archived. */
export function isClosedOrArchived(review: Pick<ReviewSummary, "state"> & { archived?: boolean }): boolean {
  return review.state === "closed" || !!review.archived;
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
  freshness: ReviewFreshness["kind"] | "";
  source: ReviewSource | "";
}

export const EMPTY_REVIEW_FILTERS: ReviewFilters = { state: "", freshness: "", source: "" };

export function filtersActive(filters: ReviewFilters): boolean {
  return !!(filters.state || filters.freshness || filters.source);
}

/** Search matches the PR title, or its number anywhere with or without `#`, as on the Pull requests board. */
export function matchesSearch(review: Pick<ReviewSummary, "number" | "card">, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return reviewTitle(review).toLowerCase().includes(text) || String(review.number).includes(text.replace(/^#(?=\d)/, ""));
}

export function filterReviewList(reviews: readonly ReviewSummary[], filters: ReviewFilters, query: string, showClosed: boolean): ReviewSummary[] {
  return reviews.filter(review =>
    (showClosed || !isClosedOrArchived(review)) &&
    (!filters.state || review.state === filters.state) &&
    (!filters.freshness || review.freshness.kind === filters.freshness) &&
    (!filters.source || review.source === filters.source) &&
    matchesSearch(review, query));
}

export function groupByColumn(reviews: readonly ReviewSummary[], showClosed: boolean): Array<[ReviewColumn, ReviewSummary[]]> {
  const groups: Record<ReviewColumn, ReviewSummary[]> = { running: [], waiting: [], behind: [], published: [], closed: [] };
  for (const review of reviews) groups[reviewColumn(review)].push(review);
  return (Object.keys(COLUMNS) as ReviewColumn[]).filter(column => column !== "closed" || showClosed).map(column => [column, groups[column]]);
}
