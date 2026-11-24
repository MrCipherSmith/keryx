// Flow 520 AC7: the worker hands the executor every usable attempt of the same Review from earlier rounds, in the order
// to try them (update-round.ts previousRunInputs); the old "completed + complete + same options key" rule is gone.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DESK_RUN_SCOPE, type DeskResult, type DeskRun } from "./desk-run-types";
import { earlierRoundAttempts, previousRoundAttempts, previousRunInputs } from "./update-round";

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
    report: "",
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
    reviewId: "review-1",
    round: 1,
    effectiveOptionsKey: "settings-A",
    result: result(),
    ...over,
  };
}

/** The attempt being executed: round 2 on a newer head of the same Review. */
const current = run("current", { headSha: SHA("c"), round: 2, state: "running", result: null, effectiveOptionsKey: "settings-B" });

/** Test-local: the first candidate. The worker passes the whole ordered list; the executor falls back (T14 B1). */
const previousRoundAttempt = (runs: readonly DeskRun[], at: DeskRun) => previousRoundAttempts(runs, at)[0];

describe("previousRoundAttempts", () => {
  test("a partial attempt of the previous round, run with other settings, is the previous round and is marked partial", () => {
    const partial = run("partial", { state: "partial", result: result({ coverage: "partial" }), effectiveOptionsKey: "settings-A" });
    expect(previousRoundAttempt([current, partial], current)).toEqual({ attempt: partial, partial: true });
  });

  test("a completed attempt with other settings is the previous round, not partial", () => {
    const done = run("done", { effectiveOptionsKey: "settings-A", options: { maxTokens: 5 } as DeskRun["options"] });
    expect(previousRoundAttempt([current, done], current)).toEqual({ attempt: done, partial: false });
  });

  test("never the attempt being executed nor another attempt of its own round; the newest earlier round wins", () => {
    const sameRound = run("same-round", { headSha: SHA("c"), round: 2 });
    const round1 = run("round-1", { round: 1 });
    expect(previousRoundAttempt([current, sameRound, round1], current)?.attempt.id).toBe("round-1");
    expect(previousRoundAttempt([current, sameRound], current)).toBeUndefined();
    const selfLike = { ...current, state: "completed" as const, result: result() };
    expect(previousRoundAttempt([selfLike], current)).toBeUndefined();
  });

  test("attempts of another Review are not candidates", () => {
    expect(previousRoundAttempt([current, run("other", { reviewId: "review-2" })], current)).toBeUndefined();
  });

  test("a store that has not placed rounds yet: the attempt's own range is its own round", () => {
    const legacyCurrent = run("current", { headSha: SHA("c"), round: undefined, reviewId: undefined, state: "running", result: null });
    const sameRange = run("same-range", { headSha: SHA("c"), round: undefined, reviewId: undefined });
    const older = run("older", { round: undefined, reviewId: undefined });
    expect(previousRoundAttempt([legacyCurrent, sameRange, older], legacyCurrent)?.attempt.id).toBe("older");
  });

  test("T14 B1: a partial newest round falls back to the complete round before it, in that order", () => {
    const round2 = run("round-2", { headSha: SHA("c"), round: 2, state: "partial", result: result({ coverage: "partial" }) });
    const round1 = run("round-1", { round: 1 });
    const round3 = run("current", { headSha: SHA("d"), round: 3, state: "running", result: null });
    expect(previousRoundAttempts([round3, round2, round1], round3).map((item) => item.attempt.id)).toEqual(["round-2", "round-1"]);
  });

  test("T14 B2: the earlier-round rule skips withdrawn and imported attempts and the attempt's own round", () => {
    const decision = (action: "archive" | "delete"): DeskRun["decision"] => ({ action, reason: "r", at: "2026-11-24T01:00:00.000Z" });
    const runs = [current, run("same-round", { headSha: SHA("c"), round: 2 }), run("archived", { decision: decision("archive") }),
      run("deleted", { decision: decision("delete") }), run("imported", { source: "existing" }), run("kept", { state: "failed", result: null })];
    expect(earlierRoundAttempts(runs, current).map((item) => item.id)).toEqual(["kept"]);
  });

  test("T14, T16 B3: the executor input carries each candidate's run directory, partial flag and reviewed range, in order", () => {
    const round3 = run("current", { headSha: SHA("d"), round: 3, state: "running", result: null });
    const round2 = run("round-2", { headSha: SHA("c"), round: 2, state: "partial", result: result({ coverage: "partial" }) });
    const round1 = run("round-1", { round: 1 });
    expect(previousRunInputs([round3, round2, round1], round3, (attemptId) => `/runs/${attemptId}`)).toEqual([
      { runDir: "/runs/round-2", partial: true, baseSha: SHA("a"), headSha: SHA("c") },
      { runDir: "/runs/round-1", partial: false, baseSha: SHA("a"), headSha: SHA("b") },
    ]);
    expect(previousRunInputs([round3], round3, (attemptId) => `/runs/${attemptId}`)).toEqual([]);
  });

  test("the worker has one previous-attempt rule: no options-key or completed-and-complete filter of its own", () => {
    const source = readFileSync(path.join(import.meta.dir, "desk-run-service.ts"), "utf8");
    expect(source).toContain("previousRunInputs(store.history(key).runs, run,");
    expect(source).not.toContain("function previousRoundAttempt");
    expect(source).not.toContain("deskOptionsKey(item.options)");
    expect(source).not.toMatch(/item\.result\?\.coverage === "complete"/);
  });
});
