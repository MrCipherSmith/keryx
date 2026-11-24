// Flow 520 AC5: the previous attempt of an update round is the newest one with accepted findings, whatever its settings.
import { describe, expect, test } from "bun:test";
import { DESK_RUN_SCOPE, type DeskResult, type DeskRun } from "./desk-run-types";
import { newerRoundOf, priorAttemptCandidates } from "./update-round";

const SHA = (c: string): string => c.repeat(40);
/** Overrides may set a field to undefined to model a legacy record that lacks it. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

function result(over: Loose<DeskResult> = {}): DeskResult {
  return <DeskResult>{
    reviewed: { baseSha: SHA("a"), headSha: SHA("b") },
    verdict: "needs-changes",
    coverage: "complete",
    findingsKnown: true,
    findings: { blocker: 0, major: 1, minor: 0, info: 0 },
    report: "report",
    ...over,
  };
}

function run(id: string, over: Loose<DeskRun> = {}): DeskRun {
  return <DeskRun>{
    baseSha: SHA("a"),
    headSha: SHA("b"),
    id,
    source: "manual",
    scope: DESK_RUN_SCOPE,
    state: "completed",
    phase: "done",
    reason: "",
    createdAt: "2026-11-24T00:00:00.000Z",
    startedAt: "2026-11-24T00:00:00.000Z",
    finishedAt: "2026-11-24T00:10:00.000Z",
    result: result(),
    ...over,
  };
}

/** Test-local: the first candidate. Production hands the whole ordered list to the executor, which falls back (T14 B1). */
const firstCandidate = (attempts: readonly DeskRun[], scope?: string) => priorAttemptCandidates(attempts, scope)[0];

describe("priorAttemptCandidates", () => {
  test("picks the newest completed attempt and reports it as not partial", () => {
    expect(firstCandidate([run("new"), run("old")])).toEqual({ attempt: expect.objectContaining({ id: "new" }), partial: false });
  });

  test("accepts the newest partial attempt with accepted findings and marks it partial", () => {
    const picked = firstCandidate([run("p", { headSha: SHA("c"), state: "partial", result: result({ coverage: "partial" }) }), run("c")]);
    expect(picked).toMatchObject({ attempt: { id: "p" }, partial: true });
  });

  test("T14 B1: within one round a complete attempt is preferred over a later partial retry", () => {
    const retry = run("retry", { round: 1, state: "partial", result: result({ coverage: "partial" }) });
    const complete = run("complete", { round: 1 });
    expect(firstCandidate([retry, complete])).toEqual({ attempt: complete, partial: false });
    // The same with a store that has not placed rounds yet: the shared range is the round.
    const legacyRetry = run("legacy-retry", { state: "partial", result: result({ coverage: "partial" }) });
    expect(firstCandidate([legacyRetry, run("legacy-complete")])?.attempt.id).toBe("legacy-complete");
  });

  test("T14 B1: every usable attempt is a candidate, newest round first, so the executor can fall back", () => {
    const round2 = run("round-2-partial", { round: 2, headSha: SHA("c"), state: "partial", result: result({ coverage: "partial" }) });
    const round1 = run("round-1", { round: 1 });
    expect(priorAttemptCandidates([round2, round1]).map((item) => [item.attempt.id, item.partial]))
      .toEqual([["round-2-partial", true], ["round-1", false]]);
  });

  test("a completed attempt whose coverage is not complete is partial", () => {
    expect(firstCandidate([run("u", { result: result({ coverage: "unknown" }) })])?.partial).toBe(true);
  });

  test("an attempt run with different settings is still accepted, and the options key is never compared", () => {
    const other = run("other", { effectiveOptionsKey: "settings-B", options: { maxTokens: 10 } as DeskRun["options"] });
    expect(firstCandidate([other, run("same", { effectiveOptionsKey: "settings-A" })])?.attempt.id).toBe("other");
  });

  test("rejects imported, failed, cancelled and unreviewed attempts and falls through to the next usable one", () => {
    const rejected = [
      run("imported", { source: "existing" }),
      run("failed", { state: "failed" }),
      run("cancelled", { state: "cancelled" }),
      run("blocked", { state: "blocked" }),
      run("running", { state: "running" }),
      run("unreviewed", { result: result({ reviewed: null }) }),
      run("no-result", { result: null }),
      run("findings-unknown", { state: "partial", result: result({ findingsKnown: undefined }) }),
      run("findings-false", { state: "partial", result: result({ findingsKnown: false }) }),
      run("old-scope", { scope: "review-autonomous/fixed-pr/v1" }),
      run("no-scope", { scope: undefined }),
    ];
    for (const attempt of rejected) expect(firstCandidate([attempt])).toBeUndefined();
    expect(firstCandidate([...rejected, run("good")])?.attempt.id).toBe("good");
  });

  test("the scope is a parameter", () => {
    const v1 = run("v1", { scope: "review-autonomous/fixed-pr/v1" });
    expect(firstCandidate([v1])).toBeUndefined();
    expect(firstCandidate([v1], "review-autonomous/fixed-pr/v1")?.attempt.id).toBe("v1");
  });

  test("a deleted or archived attempt is skipped; completed, closed and restored ones are not", () => {
    const decision = (action: "complete" | "close" | "archive" | "restore" | "delete"): DeskRun["decision"] => ({ action, reason: "r", at: "2026-11-24T01:00:00.000Z" });
    expect(firstCandidate([run("d", { decision: decision("delete") }), run("a", { decision: decision("archive") })])).toBeUndefined();
    for (const action of ["complete", "close", "restore"] as const) expect(firstCandidate([run("x", { decision: decision(action) })])?.attempt.id).toBe("x");
  });

  test("nothing to pick from is undefined", () => {
    expect(firstCandidate([])).toBeUndefined();
  });
});

describe("newerRoundOf", () => {
  const decision = (action: "archive" | "delete"): DeskRun["decision"] => ({ action, reason: "r", at: "2026-11-24T01:00:00.000Z" });
  const round1 = run("r1", { reviewId: "review-1", round: 1 });

  test("T14 B6: the highest later round of the same Review, never another Review's", () => {
    expect(newerRoundOf([round1], round1)).toBeUndefined();
    expect(newerRoundOf([run("other", { reviewId: "review-2", round: 5 }), round1], round1)).toBeUndefined();
    expect(newerRoundOf([run("r3", { reviewId: "review-1", round: 3 }), run("r2", { reviewId: "review-1", round: 2 }), round1], round1)?.round).toBe(3);
    expect(newerRoundOf([run("legacy")], run("legacy"))).toBeUndefined();
  });

  test("T16: another attempt of the same round is not a newer round", () => {
    const retry = run("r1-retry", { reviewId: "review-1", round: 1, state: "running", result: null });
    expect(newerRoundOf([retry, round1], round1)).toBeUndefined();
  });

  test("T16 B1: a deleted or archived newer round does not supersede; a lower newer round still does", () => {
    for (const action of ["delete", "archive"] as const) {
      expect(newerRoundOf([run("r2", { reviewId: "review-1", round: 2, decision: decision(action) }), round1], round1)).toBeUndefined();
    }
    const withdrawn3 = run("r3", { reviewId: "review-1", round: 3, decision: decision("delete") });
    expect(newerRoundOf([withdrawn3, run("r2", { reviewId: "review-1", round: 2 }), round1], round1)).toEqual({ round: 2, status: "ready" });
    // A restored newer round supersedes again.
    const restored = run("r2", { reviewId: "review-1", round: 2, decision: { action: "restore", reason: "r", at: "2026-11-24T02:00:00.000Z" } });
    expect(newerRoundOf([restored, round1], round1)?.round).toBe(2);
  });

  test("T16 B1: the newer round's status says whether it can be published from", () => {
    const newer = (over: Loose<DeskRun>) => newerRoundOf([run("r2", { reviewId: "review-1", round: 2, ...over }), round1], round1)?.status;
    expect(newer({})).toBe("ready");
    expect(newer({ state: "partial", result: result({ coverage: "partial" }) })).toBe("ready");
    for (const state of ["queued", "running", "cancelling"] as const) expect(newer({ state, result: null })).toBe("running");
    for (const state of ["failed", "cancelled", "blocked", "budget", "skipped"] as const) expect(newer({ state, result: null })).toBe("no-result");
    expect(newer({ result: result({ reviewed: null }) })).toBe("no-result");
    expect(newer({ state: "failed" })).toBe("no-result");
  });

  test("T16 B1: within the newest round a result wins over a running retry, and a running retry over failures", () => {
    const at2 = (id: string, over: Loose<DeskRun>) => run(id, { reviewId: "review-1", round: 2, ...over });
    expect(newerRoundOf([at2("retry", { state: "running", result: null }), at2("done", {}), round1], round1)?.status).toBe("ready");
    expect(newerRoundOf([at2("retry", { state: "running", result: null }), at2("failed", { state: "failed", result: null }), round1], round1)?.status).toBe("running");
  });
});
