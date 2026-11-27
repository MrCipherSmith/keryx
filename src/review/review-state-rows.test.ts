import { describe, expect, test } from "bun:test";
import { summarizeReview, type ReviewAttemptSummary, type ReviewRow } from "./review-entity";
import type { ReviewRecord, ReviewRound } from "./review-state";
import { mergeReviewStateRows, recordMatches, roundAttempts } from "./review-state-rows";

const sha = (c: string) => c.repeat(40);

function v2Attempt(overrides: Partial<ReviewAttemptSummary> = {}): ReviewAttemptSummary {
  return {
    id: "run-1", round: 1, previousRunId: null, state: "partial", source: "manual",
    baseSha: sha("a"), headSha: sha("b"), reviewed: { baseSha: sha("a"), headSha: sha("b") },
    coverage: "partial", findings: { blocker: 0, major: 0, minor: 0, info: 0 }, verdict: null,
    publication: null, decision: null, flowId: null, tokens: 100, awaitingAnswer: false, archived: false,
    createdAt: "2026-11-24T17:02:00.000Z", finishedAt: "2026-11-24T17:03:00.000Z",
    ...overrides,
  };
}
function v2Row(attempts: ReviewAttemptSummary[]): ReviewRow {
  return { id: "review-v2", repositoryId: "gid", number: 12, viewer: "me", closedAt: null, onHeadMove: "ask", attempts };
}
function round(overrides: Partial<ReviewRound> = {}): ReviewRound {
  return {
    number: 1, baseSha: sha("a"), headSha: sha("b"), settingsKey: null, state: "planning", previousRound: null,
    package: null, sessionId: "session-1", sessions: [], plan: null, reviewers: [], usage: { tokens: 0, costUsd: null },
    findings: null, verdict: null, openedAt: "2026-11-26T09:00:00.000Z", updatedAt: "2026-11-26T09:00:00.000Z",
    ...overrides,
  };
}
function record(rounds: ReviewRound[], overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schema: "keryx.review", version: 1, id: "org-repo-12-me",
    pr: { repo: "org/repo", number: 12, url: "https://github.com/org/repo/pull/12", repositoryId: "gid" },
    viewer: "me", state: "reviewing", onHeadMove: "ask", source: "desktop",
    createdAt: "2026-11-26T09:00:00.000Z", updatedAt: "2026-11-26T09:00:00.000Z", rounds, publications: [],
    ...overrides,
  };
}

describe("review.json rounds join the Reviews list", () => {
  test("a retry of a v2 Review in a live session puts the card in Running", () => {
    const [row] = mergeReviewStateRows([v2Row([v2Attempt()])], [record([round()])], "gid", "me");
    const summary = summarizeReview(row!, null);
    expect(summary.state).toBe("running");
    expect(summary.sessionId).toBe("session-1");
    expect(summary.latestRound).toBe(1);
    expect(summary.rounds).toHaveLength(1);
    expect(summary.rounds[0]!.attempts.map(attempt => attempt.id)).toEqual(["org-repo-12-me#1", "run-1"]);
  });

  test("a session review with no v2 attempts gets its own row", () => {
    const rows = mergeReviewStateRows([], [record([round()])], "gid", "me");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "org-repo-12-me", number: 12, repositoryId: "gid", viewer: "me" });
    expect(summarizeReview(rows[0]!, null).state).toBe("running");
  });

  test("a ready round is a finished result with its findings; a published one reads published", () => {
    const ready = round({ state: "ready", findings: { blocker: 1, major: 2, minor: 0, info: 0, carried: 0, rechecked: 0 }, usage: { tokens: 50, costUsd: null } });
    const [attempt] = roundAttempts(record([ready]), []);
    expect(attempt).toMatchObject({ state: "completed", reviewed: { baseSha: sha("a"), headSha: sha("b") }, findings: { blocker: 1, major: 2, minor: 0, info: 0 }, publication: "pending", tokens: 50 });
    const published = record([ready], { publications: [{ round: 1, headSha: sha("b"), verdict: "comment", at: "2026-11-26T10:00:00.000Z" }] });
    expect(summarizeReview(mergeReviewStateRows([], [published], "gid", "me")[0]!, null).state).toBe("published");
  });

  test("a paused round reads stopped", () => {
    expect(summarizeReview(mergeReviewStateRows([], [record([round({ state: "paused" })])], "gid", "me")[0]!, null).state).toBe("stopped");
  });

  test("a round over a new range is numbered after the Review's stored rounds", () => {
    const attempts = roundAttempts(record([round({ number: 1, headSha: sha("c") })]), [v2Attempt(), v2Attempt({ id: "run-2", round: 2, headSha: sha("d") })]);
    expect(attempts.map(attempt => attempt.round)).toEqual([3]);
  });

  test("records of another repository or viewer are left out", () => {
    expect(recordMatches(record([round()]), "org/repo", "gid", "me")).toBe(true);
    expect(recordMatches(record([round()]), "org/repo", "other", "me")).toBe(false);
    expect(recordMatches(record([round()]), "org/repo", "gid", "someone")).toBe(false);
    expect(recordMatches(record([round()], { pr: { repo: "Org/Repo", number: 12, url: "u" } }), "org/repo", "gid", "me")).toBe(true);
  });

  test("a closed record closes a Review that has no other close", () => {
    const [row] = mergeReviewStateRows([], [record([round({ state: "ready" })], { state: "closed", updatedAt: "2026-11-26T11:00:00.000Z" })], "gid", "me");
    expect(row!.closedAt).toBe("2026-11-26T11:00:00.000Z");
  });

  test("an attempt started after the record closed keeps the Review open and is its latest attempt", () => {
    const update = v2Attempt({ id: "run-update", round: 2, state: "running", headSha: sha("c"), reviewed: null, createdAt: "2026-11-26T12:00:00.000Z", finishedAt: null });
    const closed = record([round({ state: "ready" })], { state: "closed", updatedAt: "2026-11-26T11:00:00.000Z" });
    const [row] = mergeReviewStateRows([v2Row([update])], [closed], "gid", "me");
    expect(row!.closedAt).toBeNull();
    expect(summarizeReview(row!, null).state).toBe("running");
  });
});
