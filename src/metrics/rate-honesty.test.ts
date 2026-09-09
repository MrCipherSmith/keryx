// AC-M08 (metrics-and-validation.md §"M08 — preregistration до нового опыта",
// decision-traceability.md row M08): a report carries recall/precision/F1/candidates/task
// success/latency/P50/P95 *and uncertainty*, and equivalence is never claimed from a
// failed threshold. The corollary these tests pin down is the one the norm states one
// section earlier (§M07): "Неполная подготовка → INCOMPLETE, не нулевой recall" — an
// absence of trials must never be rendered as a measured zero.
//
// Before this suite, `deriveRate(0, 0, r)` returned
//   {successes: 0, n: 0, rate: 0, ci95: {lower: 0, upper: 0}, reliability: r}
// — a maximally confident 0% with a zero-width interval, identical in numeric shape to a
// genuinely measured, unanimous failure. A consumer reading `.rate` and `.ci95` and not
// `.reliability` could not tell the two apart, and the value is publishable.

import { describe, expect, test } from "bun:test";
import {
  deriveRate,
  isMeasuredRate,
  wilsonInterval,
  type PairedBenchmarkManifestV2,
  type PairedBenchmarkRunV2,
} from "./benchmark";
import { validatePairedBenchmarkV2 } from "./benchmark";
import {
  buildAblationManifest,
  buildRawBaselineManifest,
  buildRawBaselineRun,
  computeAblationDelta,
  type AblationTaskInput,
  type RawBaselineTaskInput,
} from "./ablation-runner";
import { buildComparativeReport, validateComparativeReport, type ComparativeLegs } from "./comparative";

const seeds = [1, 2, 3];

function ablationTask(taskId: string, onSuccess: boolean, offSuccess: boolean): AblationTaskInput {
  return {
    taskId,
    contextOn: {
      variant: "context-on",
      samples: seeds.map((seed) => ({ seed, success: onSuccess, tokens: 100, toolCalls: 2 })),
    },
    contextOff: {
      variant: "context-off",
      samples: seeds.map((seed) => ({ seed, success: offSuccess, tokens: 120, toolCalls: 5 })),
    },
  };
}

function keryxLeg(): PairedBenchmarkManifestV2 {
  return buildAblationManifest(
    [ablationTask("t1", true, false), ablationTask("t2", true, false), ablationTask("t3", false, false)],
    { ladder: "harness", model: "fixture-model" },
  );
}

describe("deriveRate: no trials is not a measured zero", () => {
  test("a real denominator still yields a measured rate with a Wilson interval", () => {
    const rate = deriveRate(8, 10, "exact");
    expect(isMeasuredRate(rate)).toBe(true);
    if (!isMeasuredRate(rate)) throw new Error("unreachable");
    expect(rate.rate).toBeCloseTo(0.8, 10);
    expect(rate.ci95.lower).toBeGreaterThan(0);
    expect(rate.ci95.upper).toBeLessThanOrEqual(1);
    // No `incomplete` marker on a measured rate: existing serialized fixtures are unchanged.
    expect("incomplete" in rate).toBe(false);
  });

  test("n = 0 yields a null rate and a null interval, never 0 / [0,0]", () => {
    const rate = deriveRate(0, 0, "exact");
    expect(isMeasuredRate(rate)).toBe(false);
    expect(rate.rate).toBeNull();
    expect(rate.ci95).toBeNull();
    expect(rate.n).toBe(0);
    expect(rate.incomplete).toBe("no-trials");
  });

  test("the reliability level does not rescue the numeric shape: unknown is null too", () => {
    // The defect's sharpest edge: even when the caller admits it does not know, the old
    // code still emitted a confident numeric zero.
    const rate = deriveRate(0, 0, "unknown");
    expect(rate.rate).toBeNull();
    expect(rate.ci95).toBeNull();
  });

  test("a measured unanimous failure stays a real 0 and is distinguishable from no data", () => {
    const measuredZero = deriveRate(0, 5, "exact");
    const noData = deriveRate(0, 0, "exact");
    expect(isMeasuredRate(measuredZero)).toBe(true);
    expect(measuredZero.rate).toBe(0);
    // The whole point: these two must not serialize to the same numbers.
    expect(JSON.stringify(measuredZero)).not.toBe(JSON.stringify(noData));
  });

  test("wilsonInterval refuses a degenerate denominator at the primitive layer", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(0, -1)).toBeNull();
    expect(wilsonInterval(0, Number.NaN)).toBeNull();
    expect(wilsonInterval(8, 10)).not.toBeNull();
  });
});

describe("the manifest builders refuse a run with no trials", () => {
  test("buildRawBaselineRun refuses fewer than the stochastic floor of seed samples", () => {
    expect(() => buildRawBaselineRun("t1", [])).toThrow(/seed samples/);
  });

  test("buildRawBaselineManifest refuses a task with no samples, like buildAblationManifest", () => {
    const inputs: RawBaselineTaskInput[] = [
      { taskId: "t1", samples: [] },
      { taskId: "t2", samples: [] },
      { taskId: "t3", samples: [] },
    ];
    expect(() => buildRawBaselineManifest(inputs)).toThrow(/seed samples/);
  });

  test("buildRawBaselineManifest still accepts a well-formed raw leg", () => {
    const inputs: RawBaselineTaskInput[] = ["t1", "t2", "t3"].map((taskId) => ({
      taskId,
      samples: seeds.map((seed) => ({ seed, success: false, tokens: null })),
    }));
    const manifest = buildRawBaselineManifest(inputs, { ladder: "comparative", model: "fixture-model" });
    expect(manifest.runs).toHaveLength(3);
    const rate = manifest.runs[0]!.rates!.taskSuccess!;
    expect(isMeasuredRate(rate)).toBe(true);
    expect(rate.rate).toBe(0);
    expect(validatePairedBenchmarkV2(manifest).valid).toBe(true);
  });
});

describe("computeAblationDelta does not fabricate a zero either", () => {
  test("an empty variant reports a null success rate, not 0", () => {
    const delta = computeAblationDelta({
      taskId: "t1",
      contextOn: { variant: "context-on", samples: [] },
      contextOff: { variant: "context-off", samples: [] },
    });
    expect(delta.successRateOn).toBeNull();
    expect(delta.successRateOff).toBeNull();
  });

  test("a populated variant still reports its measured rate", () => {
    const delta = computeAblationDelta(ablationTask("t1", true, false));
    expect(delta.successRateOn).toBe(1);
    expect(delta.successRateOff).toBe(0);
  });
});

describe("the validator rejects an unmeasured rate inside a scored manifest", () => {
  test("a hand-planted no-trials rate is refused with a message naming the cause", () => {
    const manifest = keryxLeg();
    (manifest.runs[0] as PairedBenchmarkRunV2).rates = { taskSuccess: deriveRate(0, 0, "exact") };
    const result = validatePairedBenchmarkV2(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("no trials");
  });

  test("a legacy zero-width interval on n = 0 is still refused", () => {
    const manifest = keryxLeg();
    (manifest.runs[0] as PairedBenchmarkRunV2).rates = {
      taskSuccess: { successes: 0, n: 0, rate: 0, ci95: { lower: 0, upper: 0 }, reliability: "exact" } as never,
    };
    const result = validatePairedBenchmarkV2(manifest).errors.join(" ");
    expect(result).toContain("without an explicit n");
  });

  // RESOLVED 2026-09-09, flow 238/T15: `n <= 0` alone let a fractional n like `1e-9`
  // through — a trial count is a positive integer, not a number merely greater than zero.
  test("a fractional n (e.g. 1e-9) is refused: a trial count is a positive integer", () => {
    const manifest = keryxLeg();
    (manifest.runs[0] as PairedBenchmarkRunV2).rates = {
      taskSuccess: { successes: 0, n: 1e-9, rate: 0, ci95: { lower: 0, upper: 1 }, reliability: "exact" } as never,
    };
    const result = validatePairedBenchmarkV2(manifest).errors.join(" ");
    expect(result).toContain("must be a positive integer, not a fraction");
  });
});

describe("the fabricated zero can no longer reach a comparative report", () => {
  test("a raw leg with no trials is refused at the builder, before any report exists", () => {
    const emptyRaw: RawBaselineTaskInput[] = ["t1", "t2", "t3"].map((taskId) => ({ taskId, samples: [] }));
    expect(() => buildRawBaselineManifest(emptyRaw, { ladder: "comparative", model: "fixture-model" })).toThrow(
      /seed samples/,
    );
  });

  test("even a hand-assembled unmeasured cell is null-valued and non-publishable", () => {
    // Bypass the builder guard entirely: forge the raw leg by hand, the way a future
    // caller with its own producer could. The report must still not publish a number.
    const forgedRawRun: PairedBenchmarkRunV2 = {
      task_id: "t1",
      variant: "baseline",
      run_id: "t1:baseline#1",
      ladder: "comparative",
      model: "fixture-model",
      cacheState: "unknown",
      leakageAssertion: "not-applicable",
      caseKind: "stochastic",
      tokenCap: null,
      seeds: [],
      quality: "measured",
      rates: { taskSuccess: deriveRate(0, 0, "exact") },
      human_interventions: null,
    };
    const keryx = keryxLeg();
    const legs: ComparativeLegs = {
      keryx,
      raw: { protocol: "paired-3-5-v2", ladder: "comparative", task_ids: ["t1"], runs: [forgedRawRun] },
      harness: keryx,
      harnessTargetName: "codex",
      harnessStatus: { adapter: "native-reviewed", fairness: "met" },
    };
    const report = buildComparativeReport(legs);
    const rawCell = report.cells.find((cell) => cell.cell === "raw");
    expect(rawCell).toBeDefined();
    expect(rawCell!.successRate.rate).toBeNull();
    expect(rawCell!.successRate.ci95).toBeNull();
    // A cell with no trials is not a publishable number, whatever the adapter/fairness say.
    expect(rawCell!.publishable).toBe(false);
    // And the validator agrees rather than contradicting the builder.
    expect(validateComparativeReport(report).valid).toBe(true);
  });

  test("a fully measured comparative report is unaffected", () => {
    const keryx = keryxLeg();
    const raw = buildRawBaselineManifest(
      ["t1", "t2", "t3"].map((taskId) => ({ taskId, samples: seeds.map((seed) => ({ seed, success: false, tokens: null })) })),
      { ladder: "comparative", model: "fixture-model" },
    );
    const report = buildComparativeReport({
      keryx,
      raw,
      harness: keryx,
      harnessTargetName: "codex",
      harnessStatus: { adapter: "native-reviewed", fairness: "met" },
    });
    expect(report.cells.every((cell) => cell.publishable)).toBe(true);
    expect(report.cells.every((cell) => isMeasuredRate(cell.successRate))).toBe(true);
    expect(validateComparativeReport(report).valid).toBe(true);
  });
});
