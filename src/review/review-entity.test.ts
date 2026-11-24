import { describe, expect, test } from "bun:test";
import type { ReviewCard } from "./board-types";
import { freshness, reviewNeedsViewer, reviewState, summarizeReview, type ReviewAttemptSummary, type ReviewRow } from "./review-entity";

const sha = (c: string) => c.repeat(40);
let seq = 0;
function attempt(overrides: Partial<ReviewAttemptSummary> = {}): ReviewAttemptSummary {
  seq++;
  return {
    id: `run-${seq}`, round: 1, previousRunId: null, state: "completed", source: "manual",
    baseSha: sha("a"), headSha: sha("b"), reviewed: { baseSha: sha("a"), headSha: sha("b") },
    coverage: "complete", findings: { blocker: 0, major: 1, minor: 2, info: 0 }, verdict: "COMMENT",
    publication: "pending", decision: null, flowId: null, tokens: null, awaitingAnswer: false,
    createdAt: `2026-11-2${seq % 10}T00:00:00.000Z`, finishedAt: null,
    ...overrides,
  };
}
function row(attempts: ReviewAttemptSummary[], overrides: Partial<ReviewRow> = {}): ReviewRow {
  return { id: "review-1", repositoryId: "gid", number: 12, viewer: "me", closedAt: null, onHeadMove: "ask", attempts, ...overrides };
}
const card = (overrides: Partial<ReviewCard> = {}): ReviewCard => ({
  number: 12, title: "PR", url: "https://github.com/org/repo/pull/12", state: "open", draft: false, author: "a",
  assignees: [], reviewers: [], decision: null, ci: "none", baseSha: sha("a"), headSha: sha("b"), updatedAt: "now", ...overrides,
});

describe("reviewState follows the specification table", () => {
  test("closed wins over every attempt state", () => {
    expect(reviewState(attempt({ state: "running" }), true)).toBe("closed");
    expect(reviewState(attempt(), true)).toBe("closed");
  });
  test("queued, running and cancelling", () => {
    expect(reviewState(attempt({ state: "queued", reviewed: null }), false)).toBe("queued");
    expect(reviewState(attempt({ state: "running", reviewed: null }), false)).toBe("running");
    expect(reviewState(attempt({ state: "cancelling", reviewed: null }), false)).toBe("running");
  });
  test("needs_answer only for a running manual attempt with a pending question", () => {
    expect(reviewState(attempt({ state: "running", awaitingAnswer: true }), false)).toBe("needs_answer");
    expect(reviewState(attempt({ state: "running", awaitingAnswer: true, source: "scheduled" }), false)).toBe("running");
    expect(reviewState(attempt({ state: "cancelling", awaitingAnswer: true }), false)).toBe("running");
  });
  test("published needs a reviewed range and a published outcome", () => {
    expect(reviewState(attempt({ publication: "published" }), false)).toBe("published");
    expect(reviewState(attempt({ publication: "published", reviewed: null }), false)).toBe("stopped");
  });
  test("ready for every finished state with a reviewed range", () => {
    for (const state of ["completed", "partial", "budget"] as const) {
      expect(reviewState(attempt({ state, publication: null }), false)).toBe("ready");
    }
    expect(reviewState(attempt({ publication: "skipped" }), false)).toBe("ready");
  });
  test("stopped for failures, cancellations, refusals and finishes without a reviewed range", () => {
    for (const state of ["failed", "cancelled", "blocked", "skipped"] as const) {
      expect(reviewState(attempt({ state }), false)).toBe("stopped");
    }
    for (const state of ["completed", "partial", "budget"] as const) {
      expect(reviewState(attempt({ state, reviewed: null }), false)).toBe("stopped");
    }
  });
});

describe("freshness", () => {
  test("current when the reviewed head is the PR head or the reviewed head is unknown", () => {
    expect(freshness(sha("b"), sha("b"))).toEqual({ kind: "current" });
    expect(freshness(null, sha("b"))).toEqual({ kind: "current" });
  });
  test("unknown when the PR head is unknown, whatever the comparison says", () => {
    expect(freshness(sha("b"), null)).toEqual({ kind: "unknown" });
    expect(freshness(null, null)).toEqual({ kind: "unknown" });
    expect(freshness(sha("b"), null, { status: "ahead", aheadBy: 3 })).toEqual({ kind: "unknown" });
  });
  test("behind with the commit count when the PR head descends from the reviewed head", () => {
    expect(freshness(sha("b"), sha("c"), { status: "ahead", aheadBy: 3 })).toEqual({ kind: "behind", commits: 3, rewritten: false });
  });
  test("rewritten when the reviewed head is no longer an ancestor", () => {
    expect(freshness(sha("b"), sha("c"), { status: "diverged", aheadBy: 2 })).toEqual({ kind: "behind", commits: 2, rewritten: true });
    expect(freshness(sha("b"), sha("c"), { status: "behind", aheadBy: 0 })).toEqual({ kind: "behind", commits: 0, rewritten: true });
  });
  test("an unknown count without a comparison", () => {
    expect(freshness(sha("b"), sha("c"))).toEqual({ kind: "behind", commits: null, rewritten: false });
    expect(freshness(sha("b"), sha("c"), null)).toEqual({ kind: "behind", commits: null, rewritten: false });
    expect(freshness(sha("b"), sha("c"), { status: "identical", aheadBy: 0 })).toEqual({ kind: "current" });
  });
});

test("reviewNeedsViewer: needs_answer, undecided ready and stopped", () => {
  expect(reviewNeedsViewer({ state: "needs_answer", publication: null })).toBe(true);
  expect(reviewNeedsViewer({ state: "stopped", publication: null })).toBe(true);
  expect(reviewNeedsViewer({ state: "ready", publication: "pending" })).toBe(true);
  expect(reviewNeedsViewer({ state: "ready", publication: null })).toBe(true);
  expect(reviewNeedsViewer({ state: "ready", publication: "skipped" })).toBe(false);
  for (const state of ["queued", "running", "published", "closed"] as const) {
    expect(reviewNeedsViewer({ state, publication: "pending" })).toBe(false);
  }
});

describe("summarizeReview", () => {
  test("groups attempts into rounds, newest first, and reports the latest reviewed round", () => {
    const first = attempt({ round: 1, findings: { blocker: 1, major: 0, minor: 0, info: 0 }, tokens: 100, createdAt: "2026-11-01T00:00:00.000Z" });
    const second = attempt({ round: 2, previousRunId: first.id, headSha: sha("c"), reviewed: { baseSha: sha("a"), headSha: sha("c") },
      findings: { blocker: 0, major: 0, minor: 1, info: 0 }, publication: "published", tokens: 50, flowId: "519", createdAt: "2026-11-02T00:00:00.000Z" });
    const retry = attempt({ round: 2, previousRunId: second.id, headSha: sha("c"), state: "failed", reviewed: null, findings: null,
      publication: null, source: "scheduled", createdAt: "2026-11-03T00:00:00.000Z" });
    const summary = summarizeReview(row([first, second, retry]), card({ headSha: sha("d") }), { status: "ahead", aheadBy: 4 });
    expect(summary).toMatchObject({
      id: "review-1", number: 12, state: "stopped", latestRound: 2, source: "scheduled", flowId: "519", tokens: 150,
      findings: { blocker: 0, major: 0, minor: 1, info: 0 }, publication: "published", onHeadMove: "ask", closedAt: null,
      freshness: { kind: "behind", commits: 4, rewritten: false },
    });
    expect(summary.card?.number).toBe(12);
    expect(summary.rounds.map(r => r.number)).toEqual([2, 1]);
    expect(summary.rounds[0]).toMatchObject({ baseSha: sha("a"), headSha: sha("c"), previousRunId: first.id });
    expect(summary.rounds[0]!.attempts.map(a => a.id)).toEqual([retry.id, second.id]);
    expect(summary.rounds[1]!.previousRunId).toBeNull();
  });

  test("a Review closed locally or by its PR is closed; an unread PR leaves it open", () => {
    expect(summarizeReview(row([attempt()], { closedAt: "2026-11-05T00:00:00Z" }), card()).state).toBe("closed");
    expect(summarizeReview(row([attempt()]), card({ state: "merged" })).state).toBe("closed");
    expect(summarizeReview(row([attempt()]), card({ state: "closed" })).state).toBe("closed");
    const unread = summarizeReview(row([attempt()]), null);
    expect(unread).toMatchObject({ card: null, state: "ready", freshness: { kind: "unknown" } });
  });

  test("without a reviewed round freshness compares the requested head and findings stay unknown", () => {
    const running = attempt({ state: "running", reviewed: null, findings: null, publication: null, headSha: sha("b") });
    const summary = summarizeReview(row([running]), card({ headSha: sha("b") }));
    expect(summary).toMatchObject({ state: "running", findings: null, publication: null, tokens: null, freshness: { kind: "current" } });
  });
});
