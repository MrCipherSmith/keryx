import { describe, expect, test } from "bun:test";
import { validatePairedBenchmarkV2, type PairedBenchmarkRunV2 } from "./benchmark";

function baseRun(overrides: Partial<PairedBenchmarkRunV2>): PairedBenchmarkRunV2 {
  return {
    task_id: "harness:comparative:demo",
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
    ...overrides,
  };
}

function manifest(runs: PairedBenchmarkRunV2[]) {
  return {
    protocol: "paired-3-5-v2" as const,
    ladder: "comparative" as const,
    task_ids: [...new Set(runs.map((r) => r.task_id))],
    runs,
  };
}

describe("validatePairedBenchmarkV2 — paired-cell invariant", () => {
  test("still rejects a mismatched context-on/off pair (unchanged behavior)", () => {
    const result = validatePairedBenchmarkV2(
      manifest([
        baseRun({ task_id: "t1", variant: "context-on" }),
        baseRun({ task_id: "t1", variant: "baseline" }),
        baseRun({ task_id: "t2", variant: "context-on" }),
        baseRun({ task_id: "t2", variant: "context-off" }),
        baseRun({ task_id: "t3", variant: "context-on" }),
        baseRun({ task_id: "t3", variant: "context-off" }),
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("t1") && e.includes("not a complementary pair"))).toBe(true);
  });

  test("a lone `baseline` run per task is valid — no complement required", () => {
    const result = validatePairedBenchmarkV2(
      manifest([
        baseRun({ task_id: "t1", variant: "baseline" }),
        baseRun({ task_id: "t2", variant: "baseline" }),
        baseRun({ task_id: "t3", variant: "baseline" }),
      ]),
    );
    expect(result.valid).toBe(true);
  });

  test("existing with-keryx/without-keryx pairing is still enforced", () => {
    const result = validatePairedBenchmarkV2(
      manifest([
        baseRun({ task_id: "t1", variant: "with-keryx" }),
        baseRun({ task_id: "t2", variant: "with-keryx" }),
        baseRun({ task_id: "t3", variant: "with-keryx" }),
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not paired"))).toBe(true);
  });
});

describe("validatePairedBenchmarkV2 — AC-5 leakage exclusion", () => {
  test("a manifest containing any run with leakageAssertion: failed is invalid", () => {
    const result = validatePairedBenchmarkV2(
      manifest([
        baseRun({ task_id: "t1", variant: "context-on", leakageAssertion: "failed" }),
        baseRun({ task_id: "t1", variant: "context-off" }),
        baseRun({ task_id: "t2", variant: "context-on" }),
        baseRun({ task_id: "t2", variant: "context-off" }),
        baseRun({ task_id: "t3", variant: "context-on" }),
        baseRun({ task_id: "t3", variant: "context-off" }),
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("AC-5"))).toBe(true);
  });

  test("leakageAssertion: passed is valid and unaffected", () => {
    const result = validatePairedBenchmarkV2(
      manifest([
        baseRun({ task_id: "t1", variant: "context-on", leakageAssertion: "passed" }),
        baseRun({ task_id: "t1", variant: "context-off", leakageAssertion: "passed" }),
        baseRun({ task_id: "t2", variant: "context-on", leakageAssertion: "passed" }),
        baseRun({ task_id: "t2", variant: "context-off", leakageAssertion: "passed" }),
        baseRun({ task_id: "t3", variant: "context-on", leakageAssertion: "passed" }),
        baseRun({ task_id: "t3", variant: "context-off", leakageAssertion: "passed" }),
      ]),
    );
    expect(result.valid).toBe(true);
  });
});
