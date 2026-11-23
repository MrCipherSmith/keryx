import { expect, test } from "bun:test";
import type { ReviewCard } from "./types";
import type { LocalBadge } from "../../../../src/review/board-badges";
import {
  EMPTY_FILTERS, ROLE_LANES, STATUS_LANES, drawnLanes, filterReviews, laneReason, newestFirst, reviewLane, reviewNote, stateQuery,
  type Filters,
} from "./model";

const quiet = (c: ReviewCard): ReviewCard => ({ ...c, decision: null, reviewers: [] });
const pr: ReviewCard = {
  number: 42, title: "Use project settings", url: "https://github.com/example/project/pull/42", state: "open", draft: false,
  author: "ann", assignees: ["lee"], reviewers: ["example/team"], decision: "CHANGES_REQUESTED", ci: "passed",
  updatedAt: "2026-10-01T00:00:00Z", headSha: "head", baseSha: "base",
};

test("combines independent roles with AND, selected values with OR and searches titles and numbers", () => {
  const filters = { ...EMPTY_FILTERS, author: ["me", "ann"], assignee: ["lee"], reviewer: ["example/team"], decision: ["CHANGES_REQUESTED"], ci: ["passed"] };
  expect(filterReviews([pr], filters, "#42")).toEqual([pr]);
  expect(filterReviews([pr], filters, "PROJECT")).toEqual([pr]);
  expect(filterReviews([pr], { ...filters, assignee: ["ann"] }, "")).toEqual([]);
  expect(filterReviews([pr], { ...filters, reviewer: ["lee"] }, "")).toEqual([]);
});

test("empty role filters match genuinely empty assignments/requests, unknown CI is separate from no checks", () => {
  const missing: ReviewCard = { ...pr, assignees: [], reviewers: [], decision: null, ci: "unknown" };
  const empty = { ...EMPTY_FILTERS, assignee: [":none"], reviewer: [":none"] };
  expect(filterReviews([pr, missing], empty, "")).toEqual([missing]);
  expect(filterReviews([missing], { ...empty, ci: ["none"] }, "")).toEqual([]);
  expect(filterReviews([{ ...missing, assigneesComplete: false }], empty, "")).toEqual([]);
  expect(filterReviews([{ ...missing, reviewersComplete: false }], empty, "")).toEqual([]);
});

test("mixed PR-state selections load full history, then select exact states", () => {
  const mixed = { ...EMPTY_FILTERS, state: ["merged", "draft"] };
  expect(stateQuery(mixed.state)).toBe("all");
  expect(stateQuery(EMPTY_FILTERS.state)).toBe("open");
  expect(stateQuery(["closed"])).toBe("closed");
  const draft = { ...pr, draft: true };
  expect(filterReviews([pr, draft], mixed, "")).toEqual([draft]);
});

// Every local review state the board can carry (spec AC1).
const LOCAL_STATES: Record<string, LocalBadge | undefined> = {
  none: undefined,
  queued: { active: true, ready: false, runState: "queued" },
  running: { active: true, ready: false, runState: "running", progress: { wave: 2, planned: 4, finished: 1, completed: 1 } },
  "awaiting answer": { active: true, ready: false, runState: "running", awaitingAnswer: true },
  ready: { active: false, ready: true, runState: "completed" },
  partial: { active: false, ready: true, runState: "partial" },
  "publication pending": { active: false, ready: true, runState: "completed", publicationPending: true },
  outdated: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state: "completed" } },
};

test("the lane of a pull request never depends on its local review, in either grouping", () => {
  const variants: ReviewCard[] = [
    pr, quiet(pr), { ...pr, decision: "APPROVED" }, { ...pr, draft: true }, { ...pr, state: "merged" }, { ...pr, state: "closed" },
    { ...quiet(pr), reviewers: ["ann"], author: "bob" }, { ...quiet(pr), author: "bob" },
  ];
  for (const card of variants) {
    for (const grouping of ["status", "role"] as const) {
      const expected = reviewLane(card, grouping, "ann");
      for (const [name, localReview] of Object.entries(LOCAL_STATES)) {
        const withLocal = localReview ? { ...card, localReview } : card;
        expect({ name, lane: reviewLane(withLocal, grouping, "ann") }).toEqual({ name, lane: expected });
      }
    }
  }
  const lanes = Object.keys({ ...STATUS_LANES, ...ROLE_LANES });
  expect(lanes).not.toContain("attention");
  expect(lanes).not.toContain("review");
});

test("the status grouping reads GitHub state and decision only", () => {
  expect(reviewLane({ ...pr, draft: true }, "status")).toBe("draft");
  expect(reviewLane({ ...pr, draft: true, state: "merged" }, "status")).toBe("merged");
  expect(reviewLane({ ...pr, state: "closed" }, "status")).toBe("closed");
  expect(reviewLane(pr, "status")).toBe("changes");
  expect(reviewLane({ ...pr, decision: "APPROVED" }, "status")).toBe("approved");
  expect(reviewLane({ ...pr, decision: "REVIEW_REQUIRED" }, "status")).toBe("waiting");
  expect(reviewLane({ ...pr, decision: null, ci: "failed" }, "status")).toBe("waiting");
  expect(reviewLane(pr)).toBe("changes");
});

test("the role grouping sorts requests to the viewer's login, the viewer's own pull requests and the rest", () => {
  expect(reviewLane({ ...pr, author: "bob", reviewers: ["ANN"] }, "role", "ann")).toBe("requested");
  // Team requests are not matched to the viewer, as in the tab signal.
  expect(reviewLane({ ...pr, author: "bob", reviewers: ["example/team"] }, "role", "ann")).toBe("others");
  expect(reviewLane({ ...pr, author: "Ann" }, "role", "ann")).toBe("mine");
  expect(reviewLane({ ...pr, author: "bob" }, "role", "ann")).toBe("others");
  expect(reviewLane({ ...pr, author: "" }, "role", "")).toBe("others");
});

test("lanes that cannot hold a card under the current filters are not drawn", () => {
  expect(drawnLanes("status", EMPTY_FILTERS, "ann")).toEqual(["draft", "waiting", "changes", "approved"]);
  expect(drawnLanes("status", { ...EMPTY_FILTERS, state: [] }, "ann")).toEqual(["draft", "waiting", "changes", "approved", "merged", "closed"]);
  expect(drawnLanes("status", { ...EMPTY_FILTERS, state: ["closed"] }, "ann")).toEqual(["closed"]);
  expect(drawnLanes("status", { ...EMPTY_FILTERS, state: ["merged", "draft"] }, "ann")).toEqual(["draft", "merged"]);
  expect(drawnLanes("status", { ...EMPTY_FILTERS, state: ["open"] }, "ann")).toEqual(["waiting", "changes", "approved"]);
  expect(drawnLanes("status", { ...EMPTY_FILTERS, decision: ["APPROVED"] }, "ann")).toEqual(["draft", "approved"]);
  expect(drawnLanes("status", { ...EMPTY_FILTERS, decision: [":none"] }, "ann")).toEqual(["draft", "waiting"]);
  expect(drawnLanes("status", { ...EMPTY_FILTERS, decision: ["REVIEW_REQUIRED", "CHANGES_REQUESTED"] }, "ann")).toEqual(["draft", "waiting", "changes"]);
  expect(drawnLanes("role", EMPTY_FILTERS, "ann")).toEqual(["requested", "mine", "others"]);
  expect(drawnLanes("role", { ...EMPTY_FILTERS, requestedFromMe: true }, "ann")).toEqual(["requested"]);
  expect(drawnLanes("role", { ...EMPTY_FILTERS, mine: true }, "ann")).toEqual(["mine"]);
  expect(drawnLanes("role", { ...EMPTY_FILTERS, author: ["bob"] }, "ann")).toEqual(["requested", "others"]);
  expect(drawnLanes("role", { ...EMPTY_FILTERS, author: ["ANN"] }, "ann")).toEqual(["mine"]);
  expect(drawnLanes("role", { ...EMPTY_FILTERS, reviewer: [":none"] }, "ann")).toEqual(["mine", "others"]);
});

test("every card the filters keep lands in a drawn lane", () => {
  const cards: ReviewCard[] = [
    pr, quiet(pr), { ...pr, draft: true }, { ...pr, decision: "APPROVED" }, { ...pr, state: "merged" }, { ...pr, state: "closed" },
    { ...pr, author: "bob", reviewers: ["ann"] }, { ...pr, author: "bob" }, { ...pr, decision: "REVIEW_REQUIRED", ci: "failed" },
  ];
  const filterSets: Filters[] = [
    EMPTY_FILTERS, { ...EMPTY_FILTERS, state: [] }, { ...EMPTY_FILTERS, state: ["closed", "draft"] },
    { ...EMPTY_FILTERS, decision: ["APPROVED", ":none"] }, { ...EMPTY_FILTERS, requestedFromMe: true },
    { ...EMPTY_FILTERS, mine: true, state: [] }, { ...EMPTY_FILTERS, author: ["bob"], reviewer: [":none"] },
  ];
  for (const filters of filterSets) {
    for (const grouping of ["status", "role"] as const) {
      const drawn = drawnLanes(grouping, filters, "ann");
      for (const card of filterReviews(cards, filters, "", "ann")) expect(drawn).toContain(reviewLane(card, grouping, "ann"));
    }
  }
});

test("quick filters narrow to requests to the viewer, the viewer's own pull requests and failed checks", () => {
  const requested = { ...pr, number: 1, author: "bob", reviewers: ["Ann"] };
  const mine = { ...pr, number: 2, author: "ANN", reviewers: [] };
  const failing = { ...pr, number: 3, author: "bob", ci: "failed" as const };
  const cards = [requested, mine, failing];
  expect(filterReviews(cards, { ...EMPTY_FILTERS, requestedFromMe: true }, "", "ann")).toEqual([requested]);
  expect(filterReviews(cards, { ...EMPTY_FILTERS, mine: true }, "", "ann")).toEqual([mine]);
  expect(filterReviews(cards, { ...EMPTY_FILTERS, ciFailed: true }, "", "ann")).toEqual([failing]);
  expect(filterReviews(cards, { ...EMPTY_FILTERS, mine: true, ciFailed: true }, "", "ann")).toEqual([]);
  // Without a known viewer nothing is the viewer's: an unknown author does not count as "mine".
  expect(filterReviews([{ ...mine, author: "" }], { ...EMPTY_FILTERS, mine: true }, "")).toEqual([]);
});

test("an active local review does not bypass any selected filter or the search", () => {
  const active = { ...pr, localReview: { active: true, ready: false } };
  const awaiting = { ...pr, state: "merged" as const, localReview: { active: true, ready: false, awaitingAnswer: true as const } };
  expect(filterReviews([active], { ...EMPTY_FILTERS, author: ["someone else"] }, "")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, state: ["merged"] }, "")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, ci: ["failed"] }, "")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, ciFailed: true }, "", "ann")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, requestedFromMe: true }, "", "ann")).toEqual([]);
  expect(filterReviews([awaiting], EMPTY_FILTERS, "")).toEqual([]);
  expect(filterReviews([awaiting], { ...EMPTY_FILTERS, state: [] }, "#999")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, author: ["ann"] }, "")).toEqual([active]);
});

test("cards are ordered by GitHub update time, newest first, keeping the given order for ties", () => {
  const a = { ...pr, number: 1, updatedAt: "2026-10-01T00:00:00Z" };
  const b = { ...pr, number: 2, updatedAt: "2026-10-03T00:00:00Z" };
  const c = { ...pr, number: 3, updatedAt: "2026-10-01T00:00:00Z", localReview: { active: true, ready: false } };
  const d = { ...pr, number: 4, updatedAt: "2026-10-02T00:00:00.500+00:00" };
  const input = [a, b, c, d];
  expect(newestFirst(input).map(card => card.number)).toEqual([2, 4, 1, 3]);
  expect(input.map(card => card.number)).toEqual([1, 2, 3, 4]);
});

test("the reason line is derived from GitHub data only, for every local review state", () => {
  const cases: [ReviewCard, string][] = [
    [{ ...pr, state: "merged" }, "Merged"],
    [{ ...pr, state: "closed" }, "Closed"],
    [pr, "Changes requested"],
    [{ ...pr, decision: null }, "Review requested"],
    [{ ...quiet(pr), ci: "failed" }, "Checks failed"],
    [{ ...quiet(pr), addressedReplyIds: ["r1"] }, "New reply to you"],
    [{ ...quiet(pr), decision: "APPROVED" }, "Approved"],
    [{ ...quiet(pr), decision: "REVIEW_REQUIRED" }, "Review required"],
    [{ ...quiet(pr), draft: true }, "Draft pull request"],
    [{ ...quiet(pr), reviewersComplete: false }, "Review requests incomplete"],
    [quiet(pr), "No review requested"],
  ];
  for (const [card, reason] of cases) {
    for (const localReview of Object.values(LOCAL_STATES)) {
      expect(laneReason(localReview ? { ...card, localReview } : card)).toBe(reason);
    }
  }
});

test("the outdated-review text stays available for the work row and names the reviewed commit", () => {
  const stale = (state: "completed" | "partial" | "budget", headSha = "head") =>
    ({ ...pr, headSha, localReview: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state } } });
  expect(reviewNote(stale("completed"))).toBe("Outdated review · abcdef0");
  expect(reviewNote(stale("partial"))).toBe("Outdated partial review · abcdef0");
  expect(reviewNote(stale("budget"))).toBe("Outdated partial review · abcdef0");
  // Same head, different range: only the base moved, so the reviewed head is not "outdated".
  expect(reviewNote(stale("completed", "abcdef0123456"))).toBe("Review predates base update · abcdef0");
  expect(reviewNote(stale("partial", "abcdef0123456"))).toBe("Partial review predates base update · abcdef0");
  expect(reviewNote(pr)).toBeNull();
});
