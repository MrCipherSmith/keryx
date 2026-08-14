import { describe, expect, test } from "bun:test";
import { deriveRate, type PairedBenchmarkManifestV2, type PairedBenchmarkRunV2 } from "./benchmark";
import { buildComparativeReport, validateComparativeReport, type ComparativeLegs } from "./comparative";

const TASK_IDS = ["harness:ablation:a", "harness:ablation:b", "harness:ablation:c"];

function run(overrides: Partial<PairedBenchmarkRunV2>): PairedBenchmarkRunV2 {
  return {
    task_id: "harness:ablation:a",
    variant: "context-on",
    ladder: "harness",
    model: "deepseek-v4-flash",
    cacheState: "unknown",
    leakageAssertion: "not-applicable",
    caseKind: "stochastic",
    tokenCap: null,
    seeds: [1, 2, 3],
    quality: "measured",
    human_interventions: null,
    rates: { taskSuccess: deriveRate(3, 3, "exact") },
    distribution: { samples: [], median: 2, spread: 0, reliability: "exact" },
    ...overrides,
  };
}

function keryxManifest(model: string): PairedBenchmarkManifestV2 {
  const runs: PairedBenchmarkRunV2[] = TASK_IDS.flatMap((taskId) => [
    run({ task_id: taskId, variant: "context-on", model }),
    run({ task_id: taskId, variant: "context-off", model }),
  ]);
  return { protocol: "paired-3-5-v2", ladder: "harness", task_ids: TASK_IDS, runs };
}

function rawManifest(model: string): PairedBenchmarkManifestV2 {
  const runs: PairedBenchmarkRunV2[] = TASK_IDS.map((taskId) => run({ task_id: taskId, variant: "baseline", model }));
  return { protocol: "paired-3-5-v2", ladder: "comparative", task_ids: TASK_IDS, runs };
}

function harnessManifest(model: string): PairedBenchmarkManifestV2 {
  const runs: PairedBenchmarkRunV2[] = TASK_IDS.flatMap((taskId) => [
    run({ task_id: taskId, variant: "context-on", model, ladder: "harness" }),
    run({ task_id: taskId, variant: "context-off", model, ladder: "harness" }),
  ]);
  return { protocol: "paired-3-5-v2", ladder: "harness", task_ids: TASK_IDS, runs };
}

describe("buildComparativeReport", () => {
  test("produces keryx-on/keryx-off/raw/harness cells for every shared task", () => {
    const legs: ComparativeLegs = {
      keryx: keryxManifest("deepseek-v4-flash"),
      raw: rawManifest("deepseek-v4-flash"),
      harness: harnessManifest("gpt-5.6-sol"),
      harnessTargetName: "codex",
      harnessStatus: { adapter: "native-reviewed", fairness: "not-met", fairnessNote: "model not held constant: gpt-5.6-sol vs deepseek-v4-flash" },
    };
    const report = buildComparativeReport(legs);
    expect(report.referenceModel).toBe("deepseek-v4-flash");
    expect(report.cells).toHaveLength(TASK_IDS.length * 4);
    const cellsForA = report.cells.filter((c) => c.taskId === "harness:ablation:a");
    expect(cellsForA.map((c) => c.cell).sort()).toEqual(["harness", "keryx-off", "keryx-on", "raw"]);
  });

  test("AC-6: harness cells are non-publishable when fairness is not met; keryx cells are", () => {
    const legs: ComparativeLegs = {
      keryx: keryxManifest("deepseek-v4-flash"),
      raw: rawManifest("deepseek-v4-flash"),
      harness: harnessManifest("gpt-5.6-sol"),
      harnessTargetName: "codex",
      harnessStatus: { adapter: "native-reviewed", fairness: "not-met", fairnessNote: "model not held constant" },
    };
    const report = buildComparativeReport(legs);
    const harnessCells = report.cells.filter((c) => c.cell === "harness");
    const keryxCells = report.cells.filter((c) => c.cell !== "harness");
    expect(harnessCells.every((c) => c.publishable === false)).toBe(true);
    expect(keryxCells.every((c) => c.publishable === true)).toBe(true);
  });

  test("a pending adapter is also non-publishable", () => {
    const legs: ComparativeLegs = {
      keryx: keryxManifest("deepseek-v4-flash"),
      raw: rawManifest("deepseek-v4-flash"),
      harness: harnessManifest("deepseek-v4-flash"),
      harnessTargetName: "opencode",
      harnessStatus: { adapter: "pending", fairness: "met" },
    };
    const report = buildComparativeReport(legs);
    expect(report.cells.filter((c) => c.cell === "harness").every((c) => c.publishable === false)).toBe(true);
  });
});

describe("validateComparativeReport", () => {
  test("valid report from buildComparativeReport passes", () => {
    const legs: ComparativeLegs = {
      keryx: keryxManifest("deepseek-v4-flash"),
      raw: rawManifest("deepseek-v4-flash"),
      harness: harnessManifest("gpt-5.6-sol"),
      harnessTargetName: "codex",
      harnessStatus: { adapter: "native-reviewed", fairness: "not-met", fairnessNote: "model not held constant" },
    };
    const result = validateComparativeReport(buildComparativeReport(legs));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects a hand-tampered report claiming a not-met cell is publishable", () => {
    const legs: ComparativeLegs = {
      keryx: keryxManifest("deepseek-v4-flash"),
      raw: rawManifest("deepseek-v4-flash"),
      harness: harnessManifest("gpt-5.6-sol"),
      harnessTargetName: "codex",
      harnessStatus: { adapter: "native-reviewed", fairness: "not-met", fairnessNote: "model not held constant" },
    };
    const report = buildComparativeReport(legs);
    const tampered = {
      ...report,
      cells: report.cells.map((c) => (c.cell === "harness" ? { ...c, publishable: true } : c)),
    };
    const result = validateComparativeReport(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("AC-6"))).toBe(true);
  });

  test("rejects a non-met fairness status with no fairnessNote", () => {
    const legs: ComparativeLegs = {
      keryx: keryxManifest("deepseek-v4-flash"),
      raw: rawManifest("deepseek-v4-flash"),
      harness: harnessManifest("gpt-5.6-sol"),
      harnessTargetName: "codex",
      harnessStatus: { adapter: "native-reviewed", fairness: "not-met" },
    };
    const result = validateComparativeReport(buildComparativeReport(legs));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fairnessNote"))).toBe(true);
  });
});
