import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReviewAttemptSummary, ReviewSummary } from "../../../../src/review/review-entity";
import { filterReviewList, matchesSearch, reviewColumn, reviewedCommit, reviewStateLabel, EMPTY_REVIEW_FILTERS } from "./model";

const time = "2026-11-20T10:00:00Z";
function attempt(id: string, extra: Partial<ReviewAttemptSummary> = {}): ReviewAttemptSummary {
  return { id, round: 1, previousRunId: null, state: "completed", source: "manual", baseSha: "base", headSha: "a".repeat(40),
    reviewed: { baseSha: "base", headSha: "a".repeat(40) }, coverage: "complete", findings: null, verdict: null, publication: null,
    decision: null, flowId: null, tokens: null, awaitingAnswer: false, archived: false, createdAt: time, finishedAt: time, ...extra };
}
function review(number: number, extra: Partial<ReviewSummary> = {}): ReviewSummary {
  return { id: "review-" + number, number, card: null, state: "ready", freshness: { kind: "current" }, onHeadMove: "ask", closedAt: null,
    rounds: [], latestRound: 1, reviewed: null, archived: false, findings: null, publication: null, source: "manual", flowId: null, tokens: null, ...extra };
}

test("the reviewed commit is the summary's reference range, not a stopped attempt that carries a newer range", () => {
  // Round 2 was cancelled after its package existed, so the attempt carries head b; the domain's reference stays on a.
  const item = review(4, {
    reviewed: { baseSha: "base", headSha: "a".repeat(40) },
    rounds: [
      { number: 2, baseSha: "base", headSha: "b".repeat(40), previousRunId: "one", attempts: [attempt("two", { round: 2, state: "cancelled", headSha: "b".repeat(40), reviewed: { baseSha: "base", headSha: "b".repeat(40) } })] },
      { number: 1, baseSha: "base", headSha: "a".repeat(40), previousRunId: null, attempts: [attempt("one")] },
    ],
  });
  expect(reviewedCommit(item)).toBe("aaaaaaa");
  // Without a reviewed result the latest requested head is shown.
  expect(reviewedCommit({ ...item, reviewed: null })).toBe("bbbbbbb");
});

test("a digit-only search matches the title too, and the number anywhere, as on the Pull requests board", () => {
  const fix404 = review(1290, { card: { number: 1290, title: "Fix 404 page" } as ReviewSummary["card"] });
  expect(matchesSearch(fix404, "404")).toBe(true);
  expect(matchesSearch(review(1304), "04")).toBe(true);
  expect(matchesSearch(review(1304), "#130")).toBe(true);
  expect(matchesSearch(review(1304), "#99")).toBe(false);
});

test("an archived Review is listed only under Show closed, in the Closed column, labelled Archived", () => {
  const archived = review(5, { archived: true, state: "stopped" });
  expect(filterReviewList([archived], EMPTY_REVIEW_FILTERS, "", false)).toEqual([]);
  expect(filterReviewList([archived], EMPTY_REVIEW_FILTERS, "", true)).toEqual([archived]);
  expect(reviewColumn(archived)).toBe("closed");
  expect(reviewStateLabel(archived)).toBe("Archived");
  expect(reviewStateLabel(review(6, { state: "stopped" }))).toBe("Stopped");
});

test("the Review panel's workspace block keeps the panel's 12px column gap", () => {
  const css = readFileSync(new URL("../review/ReviewDetail.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.review-workspace-block\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--sp-3\)/);
});
