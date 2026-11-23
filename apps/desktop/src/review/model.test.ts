import { expect, test } from "bun:test";
import type { ReviewCard } from "./types";
import { EMPTY_FILTERS, filterReviews, laneReason, reviewLane, stateQuery } from "./model";

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

test("closed wins over requests, and a failing check requests attention independently of GitHub review decision", () => {
  expect(reviewLane({ ...pr, state: "merged" })).toBe("done");
  expect(reviewLane({ ...pr, decision: null, reviewers: [], ci: "failed" })).toBe("attention");
  expect(reviewLane({ ...pr, decision: null, reviewers: [], ci: "none" })).toBe("open");
});

test("a branch rule requiring approval does not imply a request to a reviewer", () => {
  const required = { ...pr, decision: "REVIEW_REQUIRED" as const, reviewers: [] };
  expect(reviewLane(required)).toBe("open");
  expect(reviewLane({ ...required, reviewers: ["org/team"] })).toBe("attention");
});

test("active Keryx runs precede GitHub attention and available results bring an open PR back to attention", () => {
  const card = { ...pr, decision: null, reviewers: [], ci: "passed" as const };
  expect(reviewLane({ ...card, localReview: { active: true, ready: true } })).toBe("review");
  expect(reviewLane({ ...card, localReview: { active: false, ready: true } })).toBe("attention");
  const merged = { ...card, state: "merged" as const, localReview: { active: true, ready: false, awaitingAnswer: true as const } };
  expect(reviewLane(merged)).toBe("attention");
  expect(filterReviews([merged], { ...EMPTY_FILTERS, state: [] }, "")).toEqual([merged]);
  expect(filterReviews([merged], EMPTY_FILTERS, "#999")).toEqual([]);
});

test("an active local review does not bypass any selected filter", () => {
  const active = { ...pr, localReview: { active: true, ready: false } };
  expect(filterReviews([active], { ...EMPTY_FILTERS, author: ["someone else"] }, "")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, state: ["merged"] }, "")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, ci: ["failed"] }, "")).toEqual([]);
  expect(filterReviews([active], { ...EMPTY_FILTERS, author: ["ann"] }, "")).toEqual([active]);
});

test("an outdated review names the reviewed commit and ranks above GitHub reasons, below live Keryx states and closed PRs", () => {
  const outdated = (state: "completed" | "partial" | "budget") =>
    ({ ...pr, localReview: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state } } });
  expect(laneReason(outdated("completed"))).toBe("Outdated review · abcdef0");
  expect(laneReason(outdated("partial"))).toBe("Outdated partial review · abcdef0");
  expect(laneReason(outdated("budget"))).toBe("Outdated partial review · abcdef0");
  expect(laneReason({ ...outdated("completed"), state: "merged" })).toBe("Merged");
  const awaiting = { ...outdated("completed"), localReview: { ...outdated("completed").localReview, awaitingAnswer: true as const } };
  expect(laneReason(awaiting)).toBe("Awaiting your answer");
  expect(laneReason({ ...outdated("completed"), localReview: { ...outdated("completed").localReview, active: true, runState: "queued" as const } })).toBe("Keryx review queued");
  expect(reviewLane(outdated("completed"))).toBe(reviewLane(pr));
});

test("a review of the current head under an older base says the base moved, not that the head is outdated", () => {
  const baseMoved = (state: "completed" | "partial" | "budget") =>
    ({ ...pr, headSha: "abcdef0123456", localReview: { active: false, ready: false, outdated: { headSha: "abcdef0123456", state } } });
  expect(laneReason(baseMoved("completed"))).toBe("Review predates base update · abcdef0");
  expect(laneReason(baseMoved("partial"))).toBe("Partial review predates base update · abcdef0");
  expect(laneReason(baseMoved("budget"))).toBe("Partial review predates base update · abcdef0");
  expect(laneReason({ ...baseMoved("completed"), headSha: "fedcba9876543" })).toBe("Outdated review · abcdef0");
});
