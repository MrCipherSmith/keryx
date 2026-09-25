// Flow 331, AC5/AC6/AC7 — the cost cap that guards a live run.
import { describe, expect, test } from "bun:test";
import { assertEstimateWithinCap, CostCapExceededError, CostCapTracker, defaultCostCap, DEFAULT_MAX_CALLS, DEFAULT_MAX_COST_USD } from "./cost-cap";

describe("defaultCostCap", () => {
  test("matches the documented defaults ($0.10, 300 calls)", () => {
    expect(defaultCostCap()).toEqual({ maxCostUsd: 0.1, maxCalls: 300 });
    expect(DEFAULT_MAX_COST_USD).toBe(0.1);
    expect(DEFAULT_MAX_CALLS).toBe(300);
  });
});

describe("CostCapTracker: post-flight enforcement", () => {
  test("accepts usage under the cap and accumulates", () => {
    const tracker = new CostCapTracker({ maxCostUsd: 1, maxCalls: 100 });
    tracker.record({ cost: 0.1, jevCalls: 10 });
    tracker.record({ cost: 0.2, jevCalls: 10 });
    expect(tracker.totals.costUsd).toBeCloseTo(0.3, 10);
    expect(tracker.totals.calls).toBe(20);
  });

  test("refuses the exact usage that would cross the cost cap, and does not partially apply it", () => {
    const tracker = new CostCapTracker({ maxCostUsd: 0.1, maxCalls: 300 });
    tracker.record({ cost: 0.05, jevCalls: 5 });
    expect(() => tracker.record({ cost: 0.06, jevCalls: 1 })).toThrow(CostCapExceededError);
    // The rejected call must not have been applied.
    expect(tracker.totals).toEqual({ costUsd: 0.05, calls: 5 });
  });

  test("refuses the exact usage that would cross the call-count cap", () => {
    const tracker = new CostCapTracker({ maxCostUsd: 10, maxCalls: 10 });
    tracker.record({ cost: 0, jevCalls: 9 });
    expect(() => tracker.record({ cost: 0, jevCalls: 2 })).toThrow(CostCapExceededError);
    expect(tracker.totals.calls).toBe(9);
  });

  test("usage landing exactly on the cap is accepted (the cap is a ceiling, not a strict-less-than)", () => {
    const tracker = new CostCapTracker({ maxCostUsd: 0.1, maxCalls: 300 });
    tracker.record({ cost: 0.1, jevCalls: 300 });
    expect(tracker.totals).toEqual({ costUsd: 0.1, calls: 300 });
  });
});

describe("assertEstimateWithinCap: pre-flight refusal", () => {
  test("an estimate comfortably under the cap does not throw", () => {
    expect(() => assertEstimateWithinCap({ cost: 0.0001, jevCalls: 16 })).not.toThrow();
  });

  test("an estimate that would exceed the cap under the safety factor is refused before any live call", () => {
    expect(() => assertEstimateWithinCap({ cost: 0.06, jevCalls: 10 }, defaultCostCap(), 2)).toThrow(CostCapExceededError);
  });

  test("a call-count estimate over the cap is refused regardless of cost", () => {
    expect(() => assertEstimateWithinCap({ cost: 0, jevCalls: 301 })).toThrow(CostCapExceededError);
  });
});
