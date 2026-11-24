// The Review read model: one Review per (repository, PR, viewer), its rounds and attempts.
// Pure: the store supplies rows, GitHub supplies the PR card and the head comparison.
import type { ReviewCard } from "./board-types";
import type { PublicationOutcome } from "./desk-publication-types";
import type { DeskResult, DeskReviewAction, DeskRevision, DeskRunState } from "./desk-run-types";

export type ReviewState = "queued" | "running" | "needs_answer" | "stopped" | "ready" | "published" | "closed";
export type ReviewOnHeadMove = "ask" | "follow" | "ignore";
export type ReviewSource = "manual" | "scheduled" | "existing";
/** `unknown`: the PR head could not be read (the PR card is unreadable or the PR is missing). */
export type ReviewFreshness = { kind: "current" } | { kind: "unknown" } | { kind: "behind"; commits: number | null; rewritten: boolean };
/** GitHub's comparison of the reviewed head (base) with the PR head. */
export interface ReviewCompare { status: "ahead" | "behind" | "diverged" | "identical"; aheadBy: number }

/** One attempt as the Reviews list reads it: no report and no reviewer session history. */
export interface ReviewAttemptSummary {
  id: string;
  round: number;
  previousRunId: string | null;
  /** An interrupted attempt awaiting recovery reads as `failed`, as in the attempt history. */
  state: DeskRunState;
  source: ReviewSource;
  baseSha: string;
  headSha: string;
  reviewed: DeskRevision | null;
  coverage: DeskResult["coverage"] | null;
  findings: DeskResult["findings"] | null;
  verdict: string | null;
  publication: PublicationOutcome | null;
  decision: DeskReviewAction | null;
  flowId: string | null;
  /** Total tokens the attempt reported, when known. */
  tokens: number | null;
  awaitingAnswer: boolean;
  createdAt: string;
  finishedAt: string | null;
}

/** A stored Review with its visible attempts, oldest first. */
export interface ReviewRow {
  id: string;
  repositoryId: string;
  number: number;
  viewer: string;
  closedAt: string | null;
  onHeadMove: ReviewOnHeadMove;
  attempts: ReviewAttemptSummary[];
}

export interface ReviewRound {
  number: number;
  baseSha: string;
  headSha: string;
  /** The attempt the round's first attempt follows; null for round 1. */
  previousRunId: string | null;
  /** Newest first. */
  attempts: ReviewAttemptSummary[];
}

export interface ReviewSummary {
  id: string;
  number: number;
  card: ReviewCard | null;
  state: ReviewState;
  freshness: ReviewFreshness;
  onHeadMove: ReviewOnHeadMove;
  closedAt: string | null;
  /** Newest round first. */
  rounds: ReviewRound[];
  latestRound: number;
  /** Findings of the latest round that produced a reviewed result. */
  findings: DeskResult["findings"] | null;
  publication: PublicationOutcome | null;
  source: ReviewSource;
  flowId: string | null;
  tokens: number | null;
}

export interface ReviewsSnapshot {
  version: 1;
  repo: string;
  repositories: string[];
  repositoryId: string;
  viewer: string;
  fetchedAt: string;
  reviews: ReviewSummary[];
  warnings: string[];
}

const FINISHED: ReadonlySet<DeskRunState> = new Set(["completed", "partial", "budget"]);

/** The state of a Review, derived from its latest attempt. */
export function reviewState(latest: ReviewAttemptSummary, closed: boolean): ReviewState {
  if (closed) return "closed";
  if (latest.state === "queued") return "queued";
  if (latest.state === "running" || latest.state === "cancelling") {
    return latest.state === "running" && latest.source === "manual" && latest.awaitingAnswer ? "needs_answer" : "running";
  }
  if (FINISHED.has(latest.state) && latest.reviewed) return latest.publication === "published" ? "published" : "ready";
  return "stopped";
}

/** Whether the PR head moved past the reviewed head. An unknown PR head is `unknown`; an unknown reviewed head cannot be behind. */
export function freshness(reviewedHead: string | null, prHead: string | null, compare?: ReviewCompare | null): ReviewFreshness {
  if (!prHead) return { kind: "unknown" };
  if (!reviewedHead || reviewedHead === prHead || compare?.status === "identical") return { kind: "current" };
  if (!compare) return { kind: "behind", commits: null, rewritten: false };
  return { kind: "behind", commits: compare.aheadBy, rewritten: compare.status !== "ahead" };
}

export function reviewNeedsViewer(review: Pick<ReviewSummary, "state" | "publication">): boolean {
  return review.state === "needs_answer" || review.state === "stopped" ||
    (review.state === "ready" && review.publication !== "skipped" && review.publication !== "published");
}

const latestAttempt = (row: ReviewRow) => row.attempts[row.attempts.length - 1];
function newest(attempts: ReviewAttemptSummary[], wanted: (attempt: ReviewAttemptSummary) => boolean) {
  for (let i = attempts.length - 1; i >= 0; i--) if (wanted(attempts[i]!)) return attempts[i];
}
const latestReviewed = (row: ReviewRow) => newest(row.attempts, a => FINISHED.has(a.state) && a.reviewed !== null);

/** The head a Review last checked: the newest reviewed result, else the newest requested range. */
export function referenceHead(row: ReviewRow): string | null {
  return latestReviewed(row)?.reviewed?.headSha ?? latestAttempt(row)?.headSha ?? null;
}

export function reviewClosed(row: ReviewRow, card: ReviewCard | null): boolean {
  return row.closedAt !== null || card?.state === "merged" || card?.state === "closed";
}

function roundsOf(attempts: ReviewAttemptSummary[]): ReviewRound[] {
  const byNumber = new Map<number, ReviewAttemptSummary[]>();
  for (const attempt of attempts) {
    const list = byNumber.get(attempt.round) ?? [];
    if (!list.length) byNumber.set(attempt.round, list);
    list.push(attempt);
  }
  return [...byNumber].sort(([a], [b]) => b - a).map(([number, list]) => {
    const first = list[0]!; // Every map entry holds at least the attempt that created it.
    return { number, baseSha: first.baseSha, headSha: first.headSha, previousRunId: first.previousRunId, attempts: [...list].reverse() };
  });
}

/** Summarize one stored Review. `row.attempts` must be non-empty and oldest first. */
export function summarizeReview(row: ReviewRow, card: ReviewCard | null, compare?: ReviewCompare | null): ReviewSummary {
  const latest = latestAttempt(row);
  if (!latest) throw new Error(`invalid: Review ${row.id} has no visible attempts.`);
  const reviewed = latestReviewed(row);
  const tokens = row.attempts.reduce<number | null>((sum, a) => a.tokens === null ? sum : (sum ?? 0) + a.tokens, null);
  return {
    id: row.id,
    number: row.number,
    card,
    state: reviewState(latest, reviewClosed(row, card)),
    freshness: freshness(referenceHead(row), card?.headSha ?? null, compare),
    onHeadMove: row.onHeadMove,
    closedAt: row.closedAt,
    rounds: roundsOf(row.attempts),
    latestRound: latest.round,
    findings: reviewed?.findings ?? null,
    publication: reviewed?.publication ?? null,
    source: latest.source,
    flowId: newest(row.attempts, a => a.flowId !== null)?.flowId ?? null,
    tokens,
  };
}
