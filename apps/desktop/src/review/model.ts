import type { ReviewBoardState, ReviewCard, ReviewCi } from "./types";

export const CI_LABEL: Record<ReviewCi, string> = {
  passed: "CI passed", failed: "CI failed", pending: "CI running", none: "No checks", unknown: "CI unknown",
};
export const DECISION_LABEL = {
  APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required",
};
export const STATE_LABEL = { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged" };
/** Board lanes by GitHub status, in drawing order. */
export const STATUS_LANES = {
  draft: "Draft", waiting: "Waiting for review", changes: "Changes requested", approved: "Approved", merged: "Merged", closed: "Closed",
} as const;
/** Board lanes by the viewer's role on the pull request, in drawing order. */
export const ROLE_LANES = { requested: "Requested from me", mine: "Mine", others: "Others" } as const;
export const LANES = { ...STATUS_LANES, ...ROLE_LANES } as const;
export type Lane = keyof typeof LANES;
export type Grouping = "status" | "role";
export const GROUPING_LABEL: Record<Grouping, string> = { status: "Status", role: "My role" };
export type Dimension = "author" | "assignee" | "reviewer" | "decision" | "state" | "ci";
export const REVIEW_PERIODS = [7, 30, 90] as const;
export type ReviewPeriod = typeof REVIEW_PERIODS[number];
/** One-click filters shown in the board's context row; a missing key is off. */
export const QUICK_FILTERS = { requestedFromMe: "Requested from me", mine: "Mine", ciFailed: "CI failed" } as const;
export type QuickFilter = keyof typeof QUICK_FILTERS;
export type Filters = Record<Dimension, string[]> & { updatedWithin?: ReviewPeriod } & Partial<Record<QuickFilter, true>>;
export const EMPTY_FILTERS: Filters = {
  author: [], assignee: [], reviewer: [], decision: [], state: ["open", "draft"], ci: [],
};

export function stateQuery(states: string[]): ReviewBoardState {
  if (states.length && states.every((s) => s === "draft" || s === "open")) return "open";
  if (states.length === 1 && (states[0] === "closed" || states[0] === "merged")) return states[0];
  return "all";
}

/**
 * Whether an open pull request needs the viewer: requested from their login (teams are not matched),
 * their own change with requested changes, or unread replies to them. A Keryx review that waits on
 * them lights the Reviews tab instead.
 */
export function needsViewerAttention(c: ReviewCard, viewer: string, unreadReplies: number) {
  if (c.state !== "open") return false;
  const login = viewer.toLowerCase();
  return c.reviewers.some((r) => r.toLowerCase() === login) ||
    (c.author.toLowerCase() === login && c.decision === "CHANGES_REQUESTED") ||
    unreadReplies > 0;
}

export function prState(c: ReviewCard) {
  return c.state === "open" && c.draft ? "draft" : c.state;
}

function matchesRole(selected: string[], values: string[], complete = true) {
  return !selected.length || selected.some((v) => values.includes(v) || (v === ":none" && complete && !values.length));
}

/** A review requested from the viewer's own login; team requests are not matched. */
function requestedFrom(c: ReviewCard, viewer: string) {
  const login = viewer.toLowerCase();
  return !!login && c.reviewers.some((r) => r.toLowerCase() === login);
}

function authoredBy(c: ReviewCard, viewer: string) {
  return !!viewer && c.author.toLowerCase() === viewer.toLowerCase();
}

/** Every filter, the quick filters and the search apply to every card alike: no local review bypasses them. */
export function filterReviews(cards: ReviewCard[], f: Filters, query: string, viewer = "") {
  const q = query.trim().toLowerCase();
  return cards.filter(c => {
    if (q && !c.title.toLowerCase().includes(q) && !String(c.number).includes(q.replace(/^#(?=\d)/, ""))) return false;
    return (!f.author.length || f.author.includes(c.author)) &&
      matchesRole(f.assignee, c.assignees, c.assigneesComplete) &&
      matchesRole(f.reviewer, c.reviewers, c.reviewersComplete) &&
      (!f.decision.length || f.decision.includes(c.decision ?? ":none")) &&
      (!f.ci.length || f.ci.includes(c.ci)) &&
      (!f.state.length || f.state.includes(prState(c))) &&
      (!f.requestedFromMe || requestedFrom(c, viewer)) &&
      (!f.mine || authoredBy(c, viewer)) &&
      (!f.ciFailed || c.ci === "failed");
  });
}

/** Newest GitHub update first; ties keep the given order, so local events never move a card. */
export function newestFirst(cards: readonly ReviewCard[]): ReviewCard[] {
  const time = (c: ReviewCard) => Date.parse(c.updatedAt) || 0;
  return [...cards].sort((a, b) => time(b) - time(a));
}

/** The lane reads GitHub fields only: a local review never moves a card. */
export function reviewLane(c: ReviewCard, grouping: Grouping = "status", viewer = ""): Lane {
  if (grouping === "role") return requestedFrom(c, viewer) ? "requested" : authoredBy(c, viewer) ? "mine" : "others";
  const state = prState(c);
  if (state !== "open") return state;
  if (c.decision === "CHANGES_REQUESTED") return "changes";
  if (c.decision === "APPROVED") return "approved";
  return "waiting";
}

const includes = (selected: readonly string[], ...values: string[]) => !selected.length || values.some((v) => selected.includes(v));

/** The lanes of a grouping that can hold a card under these filters, in drawing order. */
export function drawnLanes(grouping: Grouping, f: Filters, viewer: string): Lane[] {
  if (grouping === "role") {
    const login = viewer.toLowerCase();
    const viewerAuthor = !f.author.length || f.author.some((a) => !!login && a.toLowerCase() === login);
    const otherAuthor = !f.author.length || f.author.some((a) => !login || a.toLowerCase() !== login);
    const possible: Record<keyof typeof ROLE_LANES, boolean> = {
      requested: !f.mine && otherAuthor && (!f.reviewer.length || f.reviewer.some((r) => r !== ":none")),
      mine: !f.requestedFromMe && viewerAuthor,
      others: !f.requestedFromMe && !f.mine && otherAuthor,
    };
    return (Object.keys(ROLE_LANES) as (keyof typeof ROLE_LANES)[]).filter((lane) => possible[lane]);
  }
  const open = includes(f.state, "open");
  const possible: Record<keyof typeof STATUS_LANES, boolean> = {
    draft: includes(f.state, "draft"),
    waiting: open && includes(f.decision, ":none", "REVIEW_REQUIRED"),
    changes: open && includes(f.decision, "CHANGES_REQUESTED"),
    approved: open && includes(f.decision, "APPROVED"),
    merged: includes(f.state, "merged"),
    closed: includes(f.state, "closed"),
  };
  return (Object.keys(STATUS_LANES) as (keyof typeof STATUS_LANES)[]).filter((lane) => possible[lane]);
}

/** The outdated-review text whenever the badge has one, independent of which reason ranks first. */
export function reviewNote(c: ReviewCard): string | null {
  const outdated = c.localReview?.outdated;
  if (!outdated) return null;
  const partial = outdated.state === "partial" || outdated.state === "budget";
  const sha = outdated.headSha.slice(0, 7);
  // Same head, different range: only the base moved, so the reviewed head is not "outdated".
  if (outdated.headSha === c.headSha) return `${partial ? "Partial review" : "Review"} predates base update · ${sha}`;
  return `${partial ? "Outdated partial review" : "Outdated review"} · ${sha}`;
}

/** The card's reason line, from GitHub data only; Keryx review state belongs to the work row. */
export function laneReason(c: ReviewCard) {
  if (c.state !== "open") return STATE_LABEL[c.state];
  if (c.decision === "CHANGES_REQUESTED") return DECISION_LABEL.CHANGES_REQUESTED;
  if (c.reviewers.length) return "Review requested";
  if (c.ci === "failed") return "Checks failed";
  if (c.addressedReplyIds?.length) return "New reply to you";
  if (c.decision) return DECISION_LABEL[c.decision];
  if (c.draft) return "Draft pull request";
  return c.reviewersComplete === false ? "Review requests incomplete" : "No review requested";
}
