import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReviewAttemptSummary, ReviewSummary } from "../../../../src/review/review-entity";
import { filterReviewList, fixFindingsPrompt, fixFindingsTarget, matchesSearch, openFindingCount, reviewColumn, reviewedCommit, reviewStateLabel, EMPTY_REVIEW_FILTERS } from "./model";

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

const own = { number: 7, title: "Own PR", url: "https://github.com/org/repo/pull/7", state: "open", draft: false, author: "Me",
  assignees: [], reviewers: [], decision: null, ci: "passed", headSha: "c".repeat(40), baseSha: "base", updatedAt: time } as NonNullable<ReviewSummary["card"]>;
const range = (head: string) => ({ baseSha: "d".repeat(40), headSha: head.repeat(40) });
/** An eligible Review: the viewer's open PR, round 2's newest unarchived reviewed attempt "r2-new" with open findings. */
function fixable(extra: Partial<ReviewSummary> = {}): ReviewSummary {
  return review(7, {
    card: own, state: "ready", latestRound: 2, reviewed: range("b"), findings: { blocker: 1, major: 2, minor: 0, info: 3 },
    rounds: [
      { number: 2, baseSha: "base", headSha: "b".repeat(40), previousRunId: "r1", attempts: [
        attempt("r2-archived", { round: 2, archived: true, reviewed: range("e") }),
        attempt("r2-new", { round: 2, reviewed: range("b") }),
        attempt("r2-old", { round: 2, reviewed: range("b") }),
      ] },
      { number: 1, baseSha: "base", headSha: "a".repeat(40), previousRunId: null, attempts: [attempt("r1")] },
    ],
    ...extra,
  });
}

test("openFindingCount counts blocker, major and minor findings, never info", () => {
  expect(openFindingCount({ blocker: 1, major: 2, minor: 3, info: 9 })).toBe(6);
  expect(openFindingCount({ blocker: 0, major: 0, minor: 0, info: 4 })).toBe(0);
  expect(openFindingCount(null)).toBe(0);
});

test("Fix findings targets the newest unarchived reviewed attempt of the viewer's own open PR (author compared case-insensitively)", () => {
  const target = fixFindingsTarget(fixable(), "me");
  expect(target?.card).toBe(own);
  expect(target?.runId).toBe("r2-new");
  expect(target?.round).toBe(2);
  expect(target?.reviewed).toEqual(range("b"));
  // A newer attempt that has not finished with a result (stopped retry) is skipped; the reviewed one before it is the run.
  const stoppedRetry = fixable({ state: "stopped", rounds: [{ number: 3, baseSha: "base", headSha: "f".repeat(40), previousRunId: "r2-new",
    attempts: [attempt("r3-failed", { round: 3, state: "failed", reviewed: null })] }, ...fixable().rounds] });
  expect(fixFindingsTarget(stoppedRetry, "ME")?.runId).toBe("r2-new");
});

test("Fix findings refuses another author, a closed or merged PR, no card, an archived, closed or live Review, only info findings and no reviewed attempt", () => {
  expect(fixFindingsTarget(fixable(), "someone-else")).toBeNull();
  expect(fixFindingsTarget(fixable({ card: { ...own, state: "closed" } }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ card: { ...own, state: "merged" } }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ card: null }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ archived: true }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ state: "closed" }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ state: "running" }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ state: "queued" }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ state: "needs_answer" }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ findings: { blocker: 0, major: 0, minor: 0, info: 5 } }), "me")).toBeNull();
  expect(fixFindingsTarget(fixable({ findings: null }), "me")).toBeNull();
  const unreviewed = fixable({ rounds: [{ number: 1, baseSha: "base", headSha: "a".repeat(40), previousRunId: null,
    attempts: [attempt("cancelled", { state: "cancelled" }), attempt("no-range", { reviewed: null }), attempt("gone", { archived: true })] }] });
  expect(fixFindingsTarget(unreviewed, "me")).toBeNull();
});

test("the Fix findings prompt names the PR, round, reviewed range and open counts, leaves info out, asks flow-orchestrator and gives the findings command", () => {
  const item = fixable();
  const target = fixFindingsTarget(item, "me")!;
  const prompt = fixFindingsPrompt(item, { repo: "org/repo", repositoryId: "R_1", viewer: "me" }, target);
  expect(prompt).toContain(own.url);
  expect(prompt).toContain("round 2");
  expect(prompt).toContain("dddddddd".slice(0, 7) + ".." + "bbbbbbb");
  expect(prompt).toContain("1 blocker, 2 major, 0 minor");
  expect(prompt).toContain("Info findings are left out");
  expect(prompt).toContain("Keryx fix flow");
  expect(prompt).toContain("flow-orchestrator");
  expect(prompt).toContain("keryx review desk-run status --json --repo org/repo --repository-id R_1 --viewer me --number 7 --id r2-new");
});

test("on a PR that has a Flow, the Fix findings prompt asks flow-orchestrator for a fix round of that Flow, not a new flow, and keeps the rest", () => {
  const item = fixable();
  const target = fixFindingsTarget(item, "me")!;
  const key = { repo: "org/repo", repositoryId: "R_1", viewer: "me" };
  const prompt = fixFindingsPrompt(item, key, target, { id: "511", dir: "511-fix-twelve" });
  expect(prompt).toContain("fix round of Keryx Flow #511 (511-fix-twelve)");
  expect(prompt).toContain("flow-orchestrator");
  expect(prompt).not.toContain("Create a Keryx fix flow");
  expect(prompt).toContain(own.url);
  expect(prompt).toContain("round 2");
  expect(prompt).toContain("dddddddd".slice(0, 7) + ".." + "bbbbbbb");
  expect(prompt).toContain("1 blocker, 2 major, 0 minor");
  expect(prompt).toContain("Info findings are left out");
  expect(prompt).toContain("keryx review desk-run status --json --repo org/repo --repository-id R_1 --viewer me --number 7 --id r2-new");
  // Without a Flow the prompt is the new-fix-flow one, unchanged.
  expect(fixFindingsPrompt(item, key, target, undefined)).toBe(fixFindingsPrompt(item, key, target));
});
