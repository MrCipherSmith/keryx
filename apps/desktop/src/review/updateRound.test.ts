import { describe, expect, test } from "bun:test";
import type { DeskRun } from "../../../../src/review/desk-run-types";
import { updateRoundTurn } from "./updateRound";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const run = (id: string, round: number, head: string, extra: Partial<DeskRun> = {}): DeskRun => ({
  id, source: "manual", scope: "pr", baseSha: A, headSha: head, state: "completed", phase: "Done", reason: "",
  createdAt: `2026-11-2${round}T00:00:00Z`, startedAt: null, finishedAt: null, result: null, reviewId: "rev", round, ...extra,
} as DeskRun);
const moved = { baseSha: A, headSha: C };

describe("Update review as a session turn", () => {
  test("keeps the reviewed attempt's settings without automatic publication, raises to its review mode and reopens", () => {
    const options = { mode: "manual", autoPublish: true, flowId: "488" } as NonNullable<DeskRun["options"]>;
    expect(updateRoundTurn([run("r1", 1, B, { options })], "r1", moved))
      .toEqual({ options: { mode: "manual", flowId: "488" }, mode: "trust", reopen: true });
    const auto = { mode: "auto" } as NonNullable<DeskRun["options"]>;
    expect(updateRoundTurn([run("r1", 1, B, { options: auto })], "r1", moved).mode).toBe("auto");
  });

  test("an attempt with no recorded settings raises the session to Trust, never Auto", () => {
    expect(updateRoundTurn([run("r1", 1, B)], "r1", moved)).toEqual({ mode: "trust", reopen: true });
  });

  test("refuses like keryx review advance: a later round (a session round included), the same range, a withdrawn attempt", () => {
    const later = run("s2", 2, C, { source: "session", state: "partial" });
    expect(() => updateRoundTurn([run("r1", 1, B), later], "r1", moved)).toThrow(/^stale: A later round of this Review already exists/);
    expect(() => updateRoundTurn([run("r1", 1, C)], "r1", moved)).toThrow(/already reviews the pull request's current head/);
    const archived = run("r1", 1, B, { decision: { action: "archive", reason: "x", at: "t" } });
    expect(() => updateRoundTurn([archived], "r1", moved)).toThrow(/^stale: This attempt was archived/);
  });
});
