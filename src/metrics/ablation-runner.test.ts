import { describe, expect, test } from "bun:test";
import { validatePairedBenchmark } from "./benchmark";
import {
  ablationTaskId,
  buildAblationManifest,
  buildAblationRun,
  buildRawBaselineManifest,
  buildRawBaselineRun,
  computeAblationDelta,
  type AblationSeedSample,
  type AblationTaskInput,
  type RawBaselineSeedSample,
} from "./ablation-runner";

function samples(...values: Array<[boolean, number | null, number]>): AblationSeedSample[] {
  return values.map(([success, tokens, toolCalls], index) => ({ seed: index + 1, success, tokens, toolCalls }));
}

// Three tasks mirroring the real ablation slice's shape: keryx tooling (context-on) wins on
// task A, both variants tie on task B, and context-off happens to win on task C (a real
// ablation must be able to report an honest loss, not just wins).
const TASK_A: AblationTaskInput = {
  taskId: ablationTaskId("wilson-interval"),
  contextOn: { variant: "context-on", samples: samples([true, 1000, 2], [true, 1100, 2], [true, 950, 3]) },
  contextOff: { variant: "context-off", samples: samples([false, 2200, 6], [true, 2400, 7], [false, 2100, 5]) },
};
const TASK_B: AblationTaskInput = {
  taskId: ablationTaskId("extract-facts"),
  contextOn: { variant: "context-on", samples: samples([true, 900, 2], [true, 950, 2], [true, 880, 2]) },
  contextOff: { variant: "context-off", samples: samples([true, 1800, 4], [true, 1900, 5], [true, 1750, 4]) },
};
const TASK_C: AblationTaskInput = {
  taskId: ablationTaskId("worktree-port"),
  contextOn: { variant: "context-on", samples: samples([false, 1200, 3], [true, 1150, 3], [false, 1300, 4]) },
  contextOff: { variant: "context-off", samples: samples([true, 1600, 3], [true, 1550, 3], [true, 1500, 3]) },
};

describe("ablationTaskId", () => {
  test("namespaces under harness:ablation:, distinct from the metastore oracles", () => {
    expect(ablationTaskId("wilson-interval")).toBe("harness:ablation:wilson-interval");
  });
});

describe("buildAblationRun", () => {
  test("success rate reflects the exact fraction of successful seeds, with a Wilson CI", () => {
    const run = buildAblationRun(TASK_A.taskId, TASK_A.contextOn, { model: "deepseek-v4-flash" });
    expect(run.variant).toBe("context-on");
    expect(run.caseKind).toBe("stochastic");
    expect(run.seeds).toEqual([1, 2, 3]);
    expect(run.rates?.taskSuccess?.successes).toBe(3);
    expect(run.rates?.taskSuccess?.n).toBe(3);
    expect(run.rates?.taskSuccess?.rate).toBe(1);
    expect(run.rates?.taskSuccess?.ci95.lower).toBeGreaterThan(0);
  });

  test("tool-call distribution carries one sample per seed with a real median/spread", () => {
    const run = buildAblationRun(TASK_A.taskId, TASK_A.contextOff);
    expect(run.distribution?.samples).toHaveLength(3);
    expect(run.distribution?.samples.map((s) => s.value)).toEqual([6, 7, 5]);
    expect(run.distribution?.median).toBe(6);
    expect(run.distribution?.spread).toBeGreaterThan(0);
  });

  test("token cost is the median across seeds, never a fabricated per-seed value", () => {
    const run = buildAblationRun(TASK_A.taskId, TASK_A.contextOn);
    expect(run.cost?.tokens?.raw.value).toBe(1000); // median of 1000, 1100, 950
    expect(run.cost?.tokens?.raw.reliability).toBe("exact");
  });

  test("an all-null token variant omits cost.tokens rather than reporting a fabricated zero", () => {
    const noTokens: AblationSeedSample[] = [
      { seed: 1, success: true, tokens: null, toolCalls: 1 },
      { seed: 2, success: true, tokens: null, toolCalls: 1 },
      { seed: 3, success: true, tokens: null, toolCalls: 1 },
    ];
    const run = buildAblationRun(TASK_A.taskId, { variant: "context-on", samples: noTokens });
    expect(run.cost).toBeUndefined();
  });
});

describe("buildAblationManifest", () => {
  test("assembles a paired-3-5-v2 manifest for the harness ladder that validates", () => {
    const manifest = buildAblationManifest([TASK_A, TASK_B, TASK_C], { model: "deepseek-v4-flash" });
    expect(manifest.protocol).toBe("paired-3-5-v2");
    expect(manifest.ladder).toBe("harness");
    expect(manifest.task_ids).toHaveLength(3);
    expect(manifest.runs).toHaveLength(6); // 3 tasks x 2 variants

    const result = validatePairedBenchmark(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("never claims a speed/comparative result — the manifest always reports claimed: false", () => {
    const manifest = buildAblationManifest([TASK_A, TASK_B, TASK_C]);
    expect(manifest.speedClaim).toEqual({ claimed: false });
  });

  test("rejects a variant with fewer than the 3-seed stochastic floor", () => {
    const short: AblationTaskInput = {
      taskId: ablationTaskId("too-few-seeds"),
      contextOn: { variant: "context-on", samples: samples([true, 100, 1], [true, 100, 1]) },
      contextOff: TASK_A.contextOff,
    };
    expect(() => buildAblationManifest([TASK_A, TASK_B, short])).toThrow(/needs >= 3/);
  });

  test("each task pairs exactly its two complementary variants (context-on/context-off)", () => {
    const manifest = buildAblationManifest([TASK_A, TASK_B, TASK_C]);
    for (const taskId of manifest.task_ids) {
      const runs = manifest.runs.filter((r) => r.task_id === taskId);
      expect(runs.map((r) => r.variant).sort()).toEqual(["context-off", "context-on"]);
    }
  });
});

describe("computeAblationDelta", () => {
  test("reports context-on beating context-off honestly (task A)", () => {
    const delta = computeAblationDelta(TASK_A);
    expect(delta.successRateOn).toBe(1);
    expect(delta.successRateOff).toBeCloseTo(1 / 3);
    expect(delta.medianToolCallsOn).toBeLessThan(delta.medianToolCallsOff as number);
  });

  test("reports context-off beating context-on honestly (task C) — deltas are not massaged toward a conclusion", () => {
    const delta = computeAblationDelta(TASK_C);
    expect(delta.successRateOff).toBe(1);
    expect(delta.successRateOn).toBeCloseTo(1 / 3);
  });

  test("median tokens is null (not zero) when a variant reported no usage", () => {
    const noTokens: AblationTaskInput = {
      taskId: ablationTaskId("no-usage"),
      contextOn: {
        variant: "context-on",
        samples: [
          { seed: 1, success: true, tokens: null, toolCalls: 1 },
          { seed: 2, success: true, tokens: null, toolCalls: 1 },
          { seed: 3, success: true, tokens: null, toolCalls: 1 },
        ],
      },
      contextOff: TASK_A.contextOff,
    };
    const delta = computeAblationDelta(noTokens);
    expect(delta.medianTokensOn).toBeNull();
    expect(delta.medianTokensOff).not.toBeNull();
  });
});

describe("buildRawBaselineRun", () => {
  const SAMPLES: RawBaselineSeedSample[] = [
    { seed: 1, success: false, tokens: null },
    { seed: 2, success: false, tokens: null },
    { seed: 3, success: true, tokens: null },
  ];

  test("variant is the unpaired `baseline`, with a real (trivially-zero) tool-call distribution", () => {
    const run = buildRawBaselineRun(ablationTaskId("wilson-interval"), SAMPLES, { model: "deepseek-v4-flash" });
    expect(run.variant).toBe("baseline");
    expect(run.ladder).toBe("comparative");
    expect(run.distribution?.samples.every((s) => s.value === 0)).toBe(true);
    expect(run.distribution?.median).toBe(0);
    expect(run.rates?.taskSuccess?.successes).toBe(1);
    expect(run.rates?.taskSuccess?.n).toBe(3);
  });

  test("omits cost.tokens rather than fabricating a value when the provider reported no usage", () => {
    const run = buildRawBaselineRun(ablationTaskId("wilson-interval"), SAMPLES);
    expect(run.cost).toBeUndefined();
  });

  test("includes cost.tokens (median) when usage WAS reported", () => {
    const withTokens: RawBaselineSeedSample[] = [
      { seed: 1, success: false, tokens: 200 },
      { seed: 2, success: false, tokens: 220 },
      { seed: 3, success: true, tokens: 210 },
    ];
    const run = buildRawBaselineRun(ablationTaskId("wilson-interval"), withTokens);
    expect(run.cost?.tokens?.raw.value).toBe(210);
  });
});

describe("buildRawBaselineManifest", () => {
  test("assembles a valid, unpaired comparative-ladder manifest", () => {
    const manifest = buildRawBaselineManifest(
      [
        { taskId: ablationTaskId("a"), samples: [{ seed: 1, success: true, tokens: null }, { seed: 2, success: true, tokens: null }, { seed: 3, success: false, tokens: null }] },
        { taskId: ablationTaskId("b"), samples: [{ seed: 1, success: false, tokens: null }, { seed: 2, success: false, tokens: null }, { seed: 3, success: false, tokens: null }] },
        { taskId: ablationTaskId("c"), samples: [{ seed: 1, success: false, tokens: null }, { seed: 2, success: true, tokens: null }, { seed: 3, success: false, tokens: null }] },
      ],
      { model: "deepseek-v4-flash" },
    );
    expect(manifest.ladder).toBe("comparative");
    expect(manifest.runs).toHaveLength(3);
    expect(manifest.runs.every((r) => r.variant === "baseline")).toBe(true);
    const result = validatePairedBenchmark(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
