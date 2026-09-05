import { describe, expect, test } from "bun:test";
import {
  decide,
  extractPaths,
  normalizePath,
  RECALL_GAIN_THRESHOLD_POINTS,
  scoreRetrieval,
  type ArmResult,
} from "./retrieval-scoring";

// This module decides the answer, so it is tested harder than anything it
// scores. Every case below is one way a real answer arrives — absolute paths
// from inside a worktree, paths wrapped in backticks, the same file named twice
// — and each was a way the first draft could have scored a correct answer wrong.

describe("normalizePath", () => {
  test("strips the worktree prefix, because an agent answers from inside one", () => {
    expect(normalizePath("/tmp/wt-abc/src/billing/charge.ts", "/tmp/wt-abc")).toBe("src/billing/charge.ts");
  });

  test("leaves a path that merely resembles the worktree root alone", () => {
    // `/tmp/wt-abcd` is not inside `/tmp/wt-abc`. A prefix test without the
    // separator would have silently mangled it.
    expect(normalizePath("/tmp/wt-abcd/src/a.ts", "/tmp/wt-abc")).toBe("tmp/wt-abcd/src/a.ts");
  });

  test("strips prose punctuation", () => {
    expect(normalizePath("`src/a.ts`")).toBe("src/a.ts");
    expect(normalizePath("(src/a.ts),")).toBe("src/a.ts");
  });

  test("strips a leading ./", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
  });
});

describe("extractPaths", () => {
  test("pulls paths out of prose, de-duplicated and in order", () => {
    const answer = "I think the fix belongs in `src/billing/charge.ts`, and maybe src/billing/retry.ts too. Again: src/billing/charge.ts.";
    expect(extractPaths(answer)).toEqual(["src/billing/charge.ts", "src/billing/retry.ts"]);
  });

  test("ignores bare filenames with no directory", () => {
    // "charge.ts" alone does not locate anything in a repository with more than
    // one of them, and scoring it as a hit would flatter both arms equally but
    // wrongly.
    expect(extractPaths("look at charge.ts")).toEqual([]);
  });

  test("resolves absolute worktree paths back to repository-relative", () => {
    expect(extractPaths("/tmp/wt-1/src/a.ts is the one", "/tmp/wt-1")).toEqual(["src/a.ts"]);
  });
});

describe("scoreRetrieval", () => {
  test("recall counts gold files found; extra predictions do not reduce it", () => {
    const score = scoreRetrieval(["src/a.ts", "src/z.ts"], ["src/a.ts", "src/b.ts"]);
    expect(score.recall).toBe(0.5);
    expect(score.matched).toEqual(["src/a.ts"]);
    expect(score.missed).toEqual(["src/b.ts"]);
    expect(score.extra).toEqual(["src/z.ts"]);
  });

  test("precision falls when the agent names files the PR did not touch", () => {
    const score = scoreRetrieval(["src/a.ts", "src/z.ts"], ["src/a.ts"]);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(0.5);
  });

  test("an empty answer scores zero rather than dividing by zero", () => {
    const score = scoreRetrieval([], ["src/a.ts"]);
    expect(score.recall).toBe(0);
    expect(score.precision).toBe(0);
    expect(score.f1).toBe(0);
  });

  test("an empty gold set is refused, not scored", () => {
    // Returning 1 or 0 here would move the aggregate in a direction nobody
    // chose. The extractor makes this unreachable, which is why it must throw.
    expect(() => scoreRetrieval(["src/a.ts"], [])).toThrow(/empty gold set/);
  });
});

function arm(over: Partial<ArmResult> & Pick<ArmResult, "taskId" | "arm">): ArmResult {
  return {
    model: "test",
    score: { recall: 0, precision: 0, f1: 0, matched: [], missed: [], extra: [] },
    toolCalls: 0,
    contextTokens: 1000,
    stepsToFirstGold: null,
    ...over,
  };
}

function withRecall(taskId: string, armName: ArmResult["arm"], recall: number, tokens = 1000): ArmResult {
  return arm({
    taskId,
    arm: armName,
    contextTokens: tokens,
    score: { recall, precision: recall, f1: recall, matched: [], missed: [], extra: [] },
  });
}

describe("decide — the pre-registered rule", () => {
  test("a gain at or above the threshold, at no greater cost, is a win", () => {
    const verdict = decide([
      withRecall("t1", "context-on", 0.8),
      withRecall("t1", "context-off", 0.7),
      withRecall("t2", "context-on", 0.8),
      withRecall("t2", "context-off", 0.7),
    ]);
    expect(verdict.recallGainPoints).toBeCloseTo(RECALL_GAIN_THRESHOLD_POINTS, 5);
    expect(verdict.meetsThreshold).toBe(true);
  });

  test("a gain below the threshold is NOT a win, however suggestive", () => {
    const verdict = decide([
      withRecall("t1", "context-on", 0.79),
      withRecall("t1", "context-off", 0.70),
    ]);
    expect(verdict.meetsThreshold).toBe(false);
    expect(verdict.reason).toContain("below the pre-registered");
  });

  test("a gain bought with more context is NOT a win", () => {
    // The condition most likely to be quietly dropped, so it gets its own test:
    // spending more tokens to find more files needs no code graph.
    const verdict = decide([
      withRecall("t1", "context-on", 0.9, 5000),
      withRecall("t1", "context-off", 0.7, 1000),
    ]);
    expect(verdict.recallGainPoints).toBeCloseTo(20, 5);
    expect(verdict.meetsThreshold).toBe(false);
    expect(verdict.reason).toContain("bought with more context");
  });

  test("only tasks with both arms count", () => {
    // An arm that crashed on one side would otherwise shift the other side's
    // mean by silently dropping its hardest cases.
    const verdict = decide([
      withRecall("t1", "context-on", 1.0),
      withRecall("t1", "context-off", 0.5),
      withRecall("t2", "context-on", 1.0), // no paired off arm
    ]);
    expect(verdict.tasks).toBe(1);
    expect(verdict.recallOn).toBe(1.0);
  });

  test("no paired task decides nothing, and says so", () => {
    const verdict = decide([withRecall("t1", "context-on", 1.0)]);
    expect(verdict.meetsThreshold).toBe(false);
    expect(verdict.reason).toContain("nothing to compare");
  });
});
