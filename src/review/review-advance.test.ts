// Flow 521 T8: `keryx review advance`, the update round of the skill's "Head moved"; Desktop's "Update review" shares its checks.
import { describe, expect, test } from "bun:test";
import type { DeskRun, DeskRunKey } from "./desk-run-types";
import { advanceReview, reviewedAttempt, updateRoundOptions } from "./review-advance";
import { runReviewAdvance } from "../commands/review-advance";
import { canContinueDeskRun, hasDeskWorker } from "./desk-run-types";

const key: DeskRunKey = { repo: "org/repo", repositoryId: "R_1", viewer: "me", number: 7 };
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const run = (id: string, round: number, head: string, extra: Partial<DeskRun> = {}): DeskRun => ({
  id, source: "manual", scope: "pr", baseSha: A, headSha: head, state: "completed", phase: "Done", reason: "",
  createdAt: `2026-11-2${round}T00:00:00Z`, startedAt: null, finishedAt: null, result: null, reviewId: "rev", round, ...extra,
} as DeskRun);

function deps(runs: DeskRun[], pr = { state: "OPEN", baseRefOid: A, headRefOid: C }) {
  const starts: unknown[] = [];
  return {
    starts,
    deps: {
      resolve: async () => ({ key, pr }),
      history: () => runs,
      start: async (_key: DeskRunKey, revision: unknown, options?: unknown) => {
        starts.push({ revision, options });
        return { version: 1 as const, runs: [] };
      },
    },
  };
}

describe("keryx review advance", () => {
  test("starts the next round on the PR's current range with the reviewed attempt's settings, minus automatic publication", async () => {
    const reviewed = run("r1", 1, B, { options: { mode: "auto", autoPublish: true, flowId: "488" } as NonNullable<DeskRun["options"]> });
    const { starts, deps: d } = deps([reviewed]);
    await advanceReview({ repo: key.repo, number: 7 }, d);
    expect(starts).toEqual([{ revision: { baseSha: A, headSha: C }, options: { mode: "auto", flowId: "488" } }]);
    expect(updateRoundOptions(undefined)).toBeUndefined();
  });

  test("updates from the Review's latest round by default; an imported or withdrawn attempt is never one", () => {
    const runs = [run("r1", 1, B), run("r2", 2, C), run("old", 3, C, { source: "existing" }), run("gone", 4, C, { decision: { action: "archive", reason: "x", at: "t" } })];
    expect(reviewedAttempt(runs).id).toBe("r2");
    expect(() => reviewedAttempt(runs, "gone")).toThrow(/^stale: This attempt was archived, deleted or imported/);
    expect(() => reviewedAttempt([])).toThrow(/no review to update/);
  });

  test("refuses a round a later round already follows, a round on the current head, and a closed pull request", async () => {
    const runs = [run("r1", 1, B), run("r2", 2, C)];
    await expect(advanceReview({ repo: key.repo, number: 7, id: "r1" }, deps(runs).deps)).rejects.toThrow(/^stale: A later round/);
    await expect(advanceReview({ repo: key.repo, number: 7 }, deps(runs).deps)).rejects.toThrow(/already reviews the pull request's current head/);
    await expect(advanceReview({ repo: key.repo, number: 7 }, deps([run("r1", 1, B)], { state: "CLOSED", baseRefOid: A, headRefOid: C }).deps))
      .rejects.toThrow(/^stale: This pull request is no longer open/);
  });

  test("refuses when the account, the repository or the range the caller saw changed", async () => {
    const runs = [run("r1", 1, B)];
    await expect(advanceReview({ repo: key.repo, number: 7, viewer: "other" }, deps(runs).deps)).rejects.toThrow(/^access:/);
    await expect(advanceReview({ repo: key.repo, number: 7, repositoryId: "R_2" }, deps(runs).deps)).rejects.toThrow(/^access:/);
    await expect(advanceReview({ repo: key.repo, number: 7, revision: { baseSha: A, headSha: B } }, deps(runs).deps)).rejects.toThrow(/^stale:/);
    const { starts, deps: d } = deps(runs);
    await advanceReview({ repo: key.repo, number: 7, viewer: "ME", repositoryId: "R_1", revision: { baseSha: A, headSha: C } }, d);
    expect(starts).toHaveLength(1);
  });

  test("a session Attempt is a round Desktop can update", async () => {
    const { starts, deps: d } = deps([run("s1", 1, B, { source: "session" })]);
    await advanceReview({ repo: key.repo, number: 7 }, d);
    expect(starts).toEqual([{ revision: { baseSha: A, headSha: C }, options: undefined }]);
  });

  test("the command refuses malformed arguments before it reads GitHub or the store", async () => {
    const sha = "a".repeat(40);
    for (const args of [
      ["--repo", "org/repo", "--number", "7"],
      ["--json", "--repo", "org", "--number", "7"],
      ["--json", "--repo", "org/repo", "--number", "0"],
      ["--json", "--repo", "org/repo", "--number", "7", "--id", "../x"],
      ["--json", "--repo", "org/repo", "--number", "7", "--base", sha],
      ["--json", "--repo", "org/repo", "--number", "7", "--base", "main", "--head", sha],
    ]) await expect(runReviewAdvance(args, "/nonexistent")).rejects.toThrow(/^keryx review advance --json/);
  });

  test("only a Desktop worker's attempt has a coordinator and can be continued; a session's or an imported one cannot", () => {
    const partial = (source: DeskRun["source"]) => run("x", 1, B, { source, state: "partial", result: { reviewed: { baseSha: A, headSha: B }, verdict: null, coverage: "partial", findings: { blocker: 0, major: 0, minor: 0, info: 0 }, report: "" } });
    expect(["manual", "scheduled", "existing", "session"].map((source) => hasDeskWorker({ source: source as DeskRun["source"] }))).toEqual([true, true, false, false]);
    expect(canContinueDeskRun(partial("session"))).toBe(false);
    expect(canContinueDeskRun(partial("existing"))).toBe(false);
  });
});
