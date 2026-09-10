import { describe, expect, test } from "bun:test";
import {
  assertBlinded,
  favours,
  filterDiffForJudge,
  judgePair,
  T2_CRITERION,
  type JudgeAnswer,
  type JudgeChoice,
  type JudgeModel,
} from "./arena-judge";

const ON_DIFF = `diff --git a/src/pipelines/components/pipeline-flow/PipelineFlow.tsx b/src/pipelines/components/pipeline-flow/PipelineFlow.tsx
--- a/src/pipelines/components/pipeline-flow/PipelineFlow.tsx
+++ b/src/pipelines/components/pipeline-flow/PipelineFlow.tsx
-        const clampedPosition = clampInnerStepPosition(draggedNode, allNodes, node.position);
-        const action = resolveIteratorDropAction(allNodes, draggedNode, clampedPosition);
+        const action = resolveIteratorDropAction(allNodes, draggedNode, node.position);
`;

const OFF_DIFF = `diff --git a/src/pipelines/components/pipeline-flow/utils/iterator-dnd-utils.ts b/src/pipelines/components/pipeline-flow/utils/iterator-dnd-utils.ts
--- a/src/pipelines/components/pipeline-flow/utils/iterator-dnd-utils.ts
+++ b/src/pipelines/components/pipeline-flow/utils/iterator-dnd-utils.ts
-      draggedPosition.x >= 0 &&
+      draggedPosition.x >= -1 &&
`;

/** A model whose answers are scripted, in call order. */
function scriptedModel(answers: readonly JudgeChoice[]): { model: JudgeModel; calls: JudgeQuestionLog[] } {
  const calls: JudgeQuestionLog[] = [];
  let index = 0;
  const model: JudgeModel = async (question) => {
    calls.push({ diffA: question.diffA, diffB: question.diffB, criterion: question.criterion });
    const choice = answers[index] ?? "tie";
    index += 1;
    return { choice, reason: `scripted ${choice}` } satisfies JudgeAnswer;
  };
  return { model, calls };
}

interface JudgeQuestionLog {
  readonly diffA: string;
  readonly diffB: string;
  readonly criterion: string;
}

describe("filterDiffForJudge", () => {
  test("drops whole files under an excluded prefix", () => {
    // A context arm's worktree diff carries hundreds of `.metaproject/data/gdctx`
    // artifacts. Left in, the judge identifies the arm in the first second.
    const diff = `${ON_DIFF}diff --git a/.metaproject/data/gdctx/raw/x.log b/.metaproject/data/gdctx/raw/x.log
+++ b/.metaproject/data/gdctx/raw/x.log
+routed: keryx ctx rg
`;
    const filtered = filterDiffForJudge(diff);
    expect(filtered).toContain("PipelineFlow.tsx");
    expect(filtered).not.toContain("gdctx");
  });

  test("keeps a source file whose path merely resembles an excluded one", () => {
    const diff = `diff --git a/src/claude-helpers.ts b/src/claude-helpers.ts
+++ b/src/claude-helpers.ts
+export const x = 1;
`;
    expect(filterDiffForJudge(diff)).toContain("src/claude-helpers.ts");
  });

  test("an empty diff stays empty", () => {
    expect(filterDiffForJudge("")).toBe("");
  });
});

describe("assertBlinded", () => {
  test("a clean diff passes, so the refusal below is not vacuous", () => {
    expect(() => assertBlinded(ON_DIFF, "the context-on diff")).not.toThrow();
  });

  test("a surviving mention drops the cell rather than judging it with a caveat", () => {
    // There is no way to subtract the knowledge after the judge has read it.
    const leaky = `${ON_DIFF}+// see the keryx wiki page for this module\n`;
    expect(() => assertBlinded(leaky, "the context-on diff")).toThrow(/dropped rather than judged/);
  });

  test("the check is case-insensitive", () => {
    expect(() => assertBlinded("+// Metaproject says so", "d")).toThrow();
  });
});

describe("judgePair", () => {
  test("calibration runs FIRST, on the same diff as both A and B", async () => {
    // Before the real pair, so a judge that cannot pass it never sees the pair and
    // cannot contaminate the record with an answer that will be discarded.
    const { model, calls } = scriptedModel(["tie", "A", "B"]);
    await judgePair({ model, onDiff: ON_DIFF, offDiff: OFF_DIFF });
    expect(calls[0]?.diffA).toBe(calls[0]?.diffB ?? "x");
  });

  test("a consistent preference for the context arm survives both orders", async () => {
    // Context arm is A in the forward order and B in the reverse, so a real
    // preference reads "A" then "B".
    const { model } = scriptedModel(["tie", "A", "B"]);
    const verdict = await judgePair({ model, onDiff: ON_DIFF, offDiff: OFF_DIFF });
    expect(verdict.consistent).toBe(true);
    expect(favours(verdict)).toBe("context-on");
  });

  test("a consistent preference for the control arm is reported as such", async () => {
    const { model } = scriptedModel(["tie", "B", "A"]);
    expect(favours(await judgePair({ model, onDiff: ON_DIFF, offDiff: OFF_DIFF }))).toBe("context-off");
  });

  test("a preference that flips with position is a TIE, not a weak preference", async () => {
    // "A" then "A" means the judge picked whatever was shown first. At n=1 a weak
    // preference and position bias are indistinguishable, so the rule is explicit.
    const { model } = scriptedModel(["tie", "A", "A"]);
    const verdict = await judgePair({ model, onDiff: ON_DIFF, offDiff: OFF_DIFF });
    expect(verdict.consistent).toBe(false);
    expect(verdict.choice).toBe("tie");
    expect(verdict.reason).toContain("position bias");
  });

  test("`neither` in both orders is preserved — an expected outcome, not a cop-out", async () => {
    // The ticket is a real bug with a non-obvious cause; both arms failing is a
    // perfectly likely result and must be reportable as itself.
    const { model } = scriptedModel(["tie", "neither", "neither"]);
    const verdict = await judgePair({ model, onDiff: ON_DIFF, offDiff: OFF_DIFF });
    expect(verdict.choice).toBe("neither");
    expect(favours(verdict)).toBe("neither");
  });

  test("a judge that picks a winner against itself invalidates its own cell", async () => {
    const { model } = scriptedModel(["A", "A", "B"]);
    const verdict = await judgePair({ model, onDiff: ON_DIFF, offDiff: OFF_DIFF });
    expect(verdict.calibrated).toBe(false);
    expect(verdict.choice).toBe("tie");
    expect(verdict.reason).toContain("carries no information");
  });

  test("the criterion reaches the model unchanged, in every call", async () => {
    const { model, calls } = scriptedModel(["tie", "tie", "tie"]);
    await judgePair({ model, onDiff: ON_DIFF, offDiff: OFF_DIFF });
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.criterion).toBe(T2_CRITERION);
  });

  test("the criterion describes the outcome, not one implementation", () => {
    // A fix that moves the clamp, one that computes from the raw position and one
    // that splits the function must all be able to satisfy it.
    expect(T2_CRITERION).toContain("must receive the drag position");
    expect(T2_CRITERION).not.toContain("clampInnerStepPosition");
    expect(T2_CRITERION).toContain("`neither`");
  });

  test("a leaking diff refuses before any model call is made", async () => {
    const { model, calls } = scriptedModel(["tie", "A", "B"]);
    await expect(
      judgePair({ model, onDiff: `${ON_DIFF}+// keryx said so\n`, offDiff: OFF_DIFF }),
    ).rejects.toThrow(/dropped rather than judged/);
    expect(calls).toHaveLength(0);
  });
});
