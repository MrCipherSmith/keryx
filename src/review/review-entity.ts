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
  /** Archived by the viewer: still listed, but never the attempt state, findings or publication come from. */
  archived: boolean;
  createdAt: string;
  finishedAt: string | null;
}

/** A stored Review with its visible attempts (archived ones flagged, deleted ones left out), oldest first. */
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
  /** The range the reference attempt (the newest finished attempt with a reviewed range) reviewed; null without one. */
  reviewed: DeskRevision | null;
  /** Every attempt is archived: the Review is kept for restore or delete, and its state is its last attempt's. */
  archived: boolean;
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
  if (!headsDiffer(reviewedHead, prHead) || compare?.status === "identical") return { kind: "current" };
  if (!compare) return { kind: "behind", commits: null, rewritten: false };
  return { kind: "behind", commits: compare.aheadBy, rewritten: compare.status !== "ahead" };
}

/** A pending answer always waits on the viewer. Otherwise a Review whose PR card could not be read does not count
 * (it may be merged or closed on GitHub), nor does an archived one; `stopped` and `ready` with a publication still
 * to choose do. `ready` without a publication outcome (partial, budget, an imported package) has no decision to make. */
export function reviewNeedsViewer(review: Pick<ReviewSummary, "state" | "publication" | "card" | "archived">): boolean {
  if (review.state === "needs_answer") return true;
  if (review.archived || review.card === null) return false;
  return review.state === "stopped" || (review.state === "ready" && review.publication === "pending");
}

const reviewedResult = (attempt: ReviewAttemptSummary) => FINISHED.has(attempt.state) && attempt.reviewed !== null;
const live = (attempt: ReviewAttemptSummary) => ["queued", "running", "cancelling"].includes(attempt.state);
function newest(attempts: ReviewAttemptSummary[], wanted: (attempt: ReviewAttemptSummary) => boolean) {
  for (let i = attempts.length - 1; i >= 0; i--) if (wanted(attempts[i]!)) return attempts[i];
}
/** The attempts the Review's state, findings and publication come from: the unarchived ones, or all when every one is archived. */
function stateAttempts(row: ReviewRow): ReviewAttemptSummary[] {
  const kept = row.attempts.filter(attempt => !attempt.archived);
  return kept.length ? kept : row.attempts;
}

/** The head a Review last checked: the newest reviewed result, else the newest requested range. */
export function referenceHead(row: ReviewRow): string | null {
  const attempts = stateAttempts(row);
  return newest(attempts, reviewedResult)?.reviewed?.headSha ?? attempts[attempts.length - 1]?.headSha ?? null;
}

/** The attempt the Review's state comes from: the latest one, unless it stopped in a round that already holds an
 * accepted (finished, reviewed) result — then that result's attempt, so a failed retry does not undo it. */
function stateAttempt(attempts: ReviewAttemptSummary[]): ReviewAttemptSummary | undefined {
  const latest = attempts[attempts.length - 1];
  if (!latest || live(latest) || reviewedResult(latest)) return latest;
  return newest(attempts, a => a.round === latest.round && reviewedResult(a)) ?? latest;
}

export function reviewClosed(row: ReviewRow, card: ReviewCard | null): boolean {
  return row.closedAt !== null || card?.state === "merged" || card?.state === "closed";
}

/** The (reviewed head, PR head) pair whose commit count freshness needs, or null when there is nothing to count:
 * the heads are equal or unknown, or the Review is closed. The one rule for the command's comparisons and for `freshness`. */
export function headComparison(row: ReviewRow, card: ReviewCard | null): { reviewed: string; head: string } | null {
  const reviewed = referenceHead(row);
  const head = card?.headSha ?? null;
  return reviewed && head && headsDiffer(reviewed, head) && !reviewClosed(row, card) ? { reviewed, head } : null;
}
const headsDiffer = (reviewed: string | null, head: string | null) => !!reviewed && !!head && reviewed !== head;

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
  const attempts = stateAttempts(row);
  const latest = attempts[attempts.length - 1];
  const settled = stateAttempt(attempts);
  if (!latest || !settled) throw new Error(`invalid: Review ${row.id} has no visible attempts.`);
  const reference = newest(attempts, reviewedResult);
  const tokens = attempts.reduce<number | null>((sum, a) => a.tokens === null ? sum : (sum ?? 0) + a.tokens, null);
  return {
    id: row.id,
    number: row.number,
    card,
    state: reviewState(settled, reviewClosed(row, card)),
    freshness: freshness(referenceHead(row), card?.headSha ?? null, compare),
    onHeadMove: row.onHeadMove,
    closedAt: row.closedAt,
    rounds: roundsOf(row.attempts),
    latestRound: latest.round,
    reviewed: reference?.reviewed ? { baseSha: reference.reviewed.baseSha, headSha: reference.reviewed.headSha } : null,
    archived: attempts.every(attempt => attempt.archived),
    findings: reference?.findings ?? null,
    publication: reference?.publication ?? null,
    source: latest.source,
    flowId: newest(attempts, a => a.flowId !== null)?.flowId ?? null,
    tokens,
  };
}
