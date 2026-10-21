import { describe, expect, test } from "bun:test";
import { selectCompletionExceptions } from "./completion-exceptions";
import type { GateOutcome } from "./types";

const failed = (name: GateOutcome["name"]): GateOutcome => ({ name, status: "fail", detail: `${name} refused` });
const review: GateOutcome = {
  ...failed("review"),
  conditions: [
    { id: "head-commit", status: "violated", detail: "fix landed in PR 24" },
    { id: "terminal-dispositions", status: "unobserved", detail: "round not ingested" },
    { id: "external-comments", status: "pass", detail: "answered" },
  ],
};

describe("completion exception selection", () => {
  test("keeps every refusal unchanged and selects individual review conditions", () => {
    const result = selectCompletionExceptions([review], ["review:head-commit"], "released fix");
    expect(result).toEqual({ ok: true, exceptions: [{ gate: "review", condition: "head-commit", detail: "fix landed in PR 24", reason: "released fix" }], remaining: ["review:terminal-dispositions"] });
    expect(review.status).toBe("fail");
  });

  test.each(["acceptance-criteria", "tasks", "owner", "folder-committed", "confirmation"] as const)("never accepts %s", (name) => {
    expect(selectCompletionExceptions([failed(name)], [name], "known").ok).toBe(false);
  });

  test.each(["review", "review:unknown", "review:external-comments", "unknown", "health"])("refuses passing, absent and unnamed selections: %s", (name) => {
    expect(selectCompletionExceptions([review, { name: "health", status: "pass", detail: "green" }], [name], "known").ok).toBe(false);
  });

  test("a review evaluation failure without structured conditions is not waivable", () => {
    expect(selectCompletionExceptions([failed("review")], ["review:head-commit"], "known").ok).toBe(false);
  });

  test("requires a nonempty single-line reason", () => {
    for (const reason of ["", "  ", "line\nforged journal entry", "line\rentry"]) {
      expect(selectCompletionExceptions([failed("health")], ["health"], reason).ok).toBe(false);
    }
  });

  test("all selected failures are covered but other gates still block", () => {
    const result = selectCompletionExceptions([failed("base-branch"), failed("tasks")], ["base-branch", "base-branch"], "retargeted after release");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exceptions).toHaveLength(1);
      expect(result.remaining).toEqual(["tasks"]);
    }
  });

  test("no requested exceptions leaves every failure blocking without a reason", () => {
    expect(selectCompletionExceptions([review, failed("health")], [], undefined)).toEqual({ ok: true, exceptions: [], remaining: ["review:head-commit", "review:terminal-dispositions", "health"] });
  });
});
