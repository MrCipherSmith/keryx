import type { ReviewBoardState, ReviewCard, ReviewCi } from "./types";

export const CI_LABEL: Record<ReviewCi, string> = {
  passed: "CI passed", failed: "CI failed", pending: "CI running", none: "No checks", unknown: "CI unknown",
};
export const DECISION_LABEL = {
  APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required",
};
export const STATE_LABEL = { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged" };
export const LANES = {
  attention: "Needs attention", review: "In review", open: "Open", done: "Done",
} as const;
export type Lane = keyof typeof LANES;
export type Dimension = "author" | "assignee" | "reviewer" | "decision" | "state" | "ci";
export const REVIEW_PERIODS = [7, 30, 90] as const;
export type ReviewPeriod = typeof REVIEW_PERIODS[number];
export type Filters = Record<Dimension, string[]> & { updatedWithin?: ReviewPeriod };
export const EMPTY_FILTERS: Filters = {
  author: [], assignee: [], reviewer: [], decision: [], state: ["open", "draft"], ci: [],
};

export function stateQuery(states: string[]): ReviewBoardState {
  if (states.length && states.every((s) => s === "draft" || s === "open")) return "open";
  if (states.length === 1 && (states[0] === "closed" || states[0] === "merged")) return states[0];
  return "all";
}

/** The Done lane can only hold closed or merged pull requests; an empty state filter means every state. */
export function stateFilterShowsDone(states: readonly string[]) {
  return !states.length || states.some((s) => s === "closed" || s === "merged");
}

/**
 * Whether an open pull request needs the viewer: requested from their login (teams are not matched),
 * their own change with requested changes, unread replies to them, or a Keryx review that waits on them.
 */
export function needsViewerAttention(c: ReviewCard, viewer: string, unreadReplies: number) {
  if (c.state !== "open") return false;
  const login = viewer.toLowerCase();
  return c.reviewers.some((r) => r.toLowerCase() === login) ||
    (c.author.toLowerCase() === login && c.decision === "CHANGES_REQUESTED") ||
    unreadReplies > 0 || !!c.localReview?.awaitingAnswer || !!c.localReview?.publicationPending;
}

export function prState(c: ReviewCard) {
  return c.state === "open" && c.draft ? "draft" : c.state;
}

function matchesRole(selected: string[], values: string[], complete = true) {
  return !selected.length || selected.some((v) => values.includes(v) || (v === ":none" && complete && !values.length));
}

export function filterReviews(cards: ReviewCard[], f: Filters, query: string) {
  const q = query.trim().toLowerCase();
  return cards.filter(c => {
    if (q && !c.title.toLowerCase().includes(q) && !String(c.number).includes(q.replace(/^#(?=\d)/, ""))) return false;
    return (!f.author.length || f.author.includes(c.author)) &&
      matchesRole(f.assignee, c.assignees, c.assigneesComplete) &&
      matchesRole(f.reviewer, c.reviewers, c.reviewersComplete) &&
      (!f.decision.length || f.decision.includes(c.decision ?? ":none")) &&
      (!f.ci.length || f.ci.includes(c.ci)) &&
      (!f.state.length || f.state.includes(prState(c)));
  });
}

function attentionReason(c: ReviewCard): string | null {
  if (c.localReview?.publicationPending) return "Choose whether to publish on GitHub";
  if (c.localReview?.ready) return "Keryx review result available";
  if (c.decision === "CHANGES_REQUESTED") return DECISION_LABEL.CHANGES_REQUESTED;
  if (c.reviewers.length) return "Review requested";
  if (c.ci === "failed") return "Checks failed";
  if (c.addressedReplyIds?.length) return "New reply to you";
  return null;
}

export function reviewLane(c: ReviewCard): Lane {
  if (c.localReview?.awaitingAnswer) return "attention";
  if (c.localReview?.active) return "review";
  if (c.state !== "open") return "done";
  return attentionReason(c) ? "attention" : "open";
}

export function laneReason(c: ReviewCard) {
  if (c.localReview?.awaitingAnswer) return "Awaiting your answer";
  if (c.localReview?.runState === "queued") return "Keryx review queued";
  if (c.localReview?.runState === "cancelling") return "Stopping Keryx review";
  if (c.localReview?.active) return "Keryx review in progress";
  if (c.state !== "open") return STATE_LABEL[c.state];
  if (c.localReview?.runState === "partial") return "Partial review · incomplete coverage";
  const attention = attentionReason(c);
  if (attention) return attention;
  if (c.decision) return DECISION_LABEL[c.decision];
  if (c.draft) return "Draft pull request";
  return c.reviewersComplete === false ? "Review requests incomplete" : "No review requested";
}
