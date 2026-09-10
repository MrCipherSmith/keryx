import { describe, expect, test } from "bun:test";
import {
  COST_TIE_BAND,
  decideResearch,
  implementScorer,
  pairByTask,
  RECALL_GAIN_THRESHOLD_POINTS,
  researchScorer,
  scorerFor,
} from "./arena-scoring";
import type { GateVerdict } from "./arena-gates";
import type { ArenaTask } from "./arena-tasks";

const research: ArenaTask = {
  id: "t1-abc",
  type: "research",
  base: "p",
  query: "q",
  gold: ["src/a.ts", "src/b.ts"],
  answerNeedles: [],
};

const implement: ArenaTask = { id: "t2", type: "implement", base: "b", query: "q", gold: [], answerNeedles: [] };

const green: GateVerdict = { results: [], implemented: true, reason: "all gates passed" };

describe("scorerFor", () => {
  test("routes by task type", () => {
    expect(scorerFor(research).kind).toBe("research");
    expect(scorerFor(implement).kind).toBe("implement");
  });
});

describe("researchScorer", () => {
  test("scores recall out of free prose", () => {
    const score = researchScorer.score({
      task: research,
      answerText: "I think it is src/a.ts and maybe src/c.ts",
      treePath: "/tmp/arm",
    });
    expect(score.kind).toBe("research");
    if (score.kind !== "research") throw new Error("unreachable");
    expect(score.retrieval.recall).toBe(0.5);
    expect(score.retrieval.extra).toContain("src/c.ts");
  });

  test("an empty gold set is a broken task record, not a zero", () => {
    // The pilot's `scoreRetrieval` throws here and the guard is kept rather than
    // relaxed: scoring it as 0 would silently add a task nobody could pass.
    expect(() => researchScorer.score({ task: { ...research, gold: [] }, answerText: "x", treePath: "/tmp" })).toThrow();
  });
});

describe("implementScorer", () => {
  test("carries the gate verdict and the changed-file count", () => {
    const score = implementScorer.score({ task: implement, answerText: "", treePath: "/tmp", gates: green, changedSourceFiles: 2 });
    if (score.kind !== "implement") throw new Error("unreachable");
    expect(score.gates.implemented).toBe(true);
    expect(score.changedSourceFiles).toBe(2);
  });

  test("the escape-branch probe is diagnostic and reported either way", () => {
    // Known root cause makes "did it touch the unreachable branch" informative
    // about HOW an arm worked. It is not evidence that it worked: a diff can name
    // the symbol and fix nothing, and a correct fix may never mention it because
    // the bug is in the caller.
    const touched = implementScorer.score({
      task: implement,
      answerText: "",
      treePath: "/tmp",
      gates: green,
      changedSourceFiles: 1,
      diffText: 'if (action.type === "moveOutOfIterator") {',
    });
    const untouched = implementScorer.score({
      task: implement,
      answerText: "",
      treePath: "/tmp",
      gates: green,
      changedSourceFiles: 1,
      diffText: "const clamped = position;",
    });
    if (touched.kind !== "implement" || untouched.kind !== "implement") throw new Error("unreachable");
    expect(touched.touchedEscapeBranch).toBe(true);
    expect(untouched.touchedEscapeBranch).toBe(false);
    // And neither changes the verdict.
    expect(touched.gates.implemented).toBe(untouched.gates.implemented);
  });

  test("refuses to score without gate results rather than inventing a default", () => {
    expect(() => implementScorer.score({ task: implement, answerText: "", treePath: "/tmp" })).toThrow();
  });
});

describe("pairByTask", () => {
  const row = (taskId: string, arm: "context-on" | "context-off") => ({ taskId, arm });

  test("pairs both arms of a task", () => {
    const pairs = pairByTask([row("a", "context-on"), row("a", "context-off")]);
    expect(pairs).toHaveLength(1);
  });

  test("an orphan arm is dropped, never averaged against nothing", () => {
    // A half-recorded task left one arm in the pilot's results file; averaging it
    // compares a context arm against no control at all.
    const pairs = pairByTask([row("a", "context-on"), row("b", "context-off")]);
    expect(pairs).toHaveLength(0);
  });

  test("ordering is stable, so two runs over the same rows agree", () => {
    const rows = [row("b", "context-on"), row("a", "context-off"), row("a", "context-on"), row("b", "context-off")];
    expect(pairByTask(rows).map((pair) => pair.taskId)).toEqual(["a", "b"]);
  });
});

describe("decideResearch", () => {
  function pair(taskId: string, on: number, off: number, tokensOn: number | null = 100, tokensOff: number | null = 100) {
    return {
      taskId,
      on: { taskId, arm: "context-on" as const, recall: on, tokens: tokensOn },
      off: { taskId, arm: "context-off" as const, recall: off, tokens: tokensOff },
    };
  }

  test("a gain at the threshold meets it", () => {
    const verdict = decideResearch("keryx-shell", [pair("a", 0.8, 0.7), pair("b", 0.8, 0.7)]);
    expect(verdict.recallGainPoints).toBeCloseTo(RECALL_GAIN_THRESHOLD_POINTS, 5);
    expect(verdict.meetsThreshold).toBe(true);
  });

  test("a gain below the threshold is NO DIFFERENCE, and says so in those words", () => {
    // The phrasing is the point. "+3.7 points" read as a promising trend is how the
    // previous run on this measurement overstated itself.
    const verdict = decideResearch("grok-build", [pair("a", 0.74, 0.7)]);
    expect(verdict.meetsThreshold).toBe(false);
    expect(verdict.reason).toContain("no difference, not a trend");
  });

  test("the cost half is a separate ratio, not folded into the same boolean", () => {
    // At this sample size a conjunction of two noisy conditions roughly doubles the
    // noise while looking like one confident verdict.
    const verdict = decideResearch("keryx-shell", [pair("a", 0.9, 0.7, 300, 100)]);
    expect(verdict.meetsThreshold).toBe(true);
    expect(verdict.costRatio).toBeCloseTo(3, 5);
    expect(verdict.reason).toContain("above the tie band");
  });

  test("a cost ratio inside the band reads as a tie", () => {
    const verdict = decideResearch("keryx-shell", [pair("a", 0.9, 0.7, 110, 100)]);
    expect(verdict.costRatio).toBeLessThanOrEqual(1 + COST_TIE_BAND);
    expect(verdict.reason).toContain("tie band");
  });

  test("an unknown token count on either arm nulls the cost half without touching recall", () => {
    // Null is not zero and does not mean free: that leg could not establish what it
    // read. Recall still stands on its own.
    const verdict = decideResearch("keryx-shell", [pair("a", 0.9, 0.7, null, 100)]);
    expect(verdict.tokensOn).toBeNull();
    expect(verdict.costRatio).toBeNull();
    expect(verdict.recallGainPoints).toBeCloseTo(20, 5);
    expect(verdict.reason).toContain("could not be established");
  });

  test("no paired tasks yields a refusal, not a verdict over nothing", () => {
    const verdict = decideResearch("keryx-shell", []);
    expect(verdict.meetsThreshold).toBe(false);
    expect(verdict.reason).toContain("nothing to compare");
  });

  test("the threshold is the pre-registered one, inherited rather than chosen here", () => {
    expect(RECALL_GAIN_THRESHOLD_POINTS).toBe(10);
  });
});
