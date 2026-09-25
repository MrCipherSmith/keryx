// Flow 331, AC3/AC4/AC7 — metric computation.
import { describe, expect, test } from "bun:test";
import { ANECDOTAL_THRESHOLD_N, bootstrapMeanCi95, computeMetrics, hasMeasuredRate, varianceReport } from "./metrics";
import type { ComponentArmResult, ComponentNotAvailable } from "./types";

const usage = { jevCalls: 0, inputTokens: 0, cost: 0, wallClockMs: 0 };

describe("computeMetrics: unavailable component", () => {
  test("passes the reason through untouched", () => {
    const result: ComponentNotAvailable = { component: "flow-check-ac", arm: "with-jev", available: false, reason: "flow 328 not yet landed" };
    const metrics = computeMetrics(result);
    expect(metrics.available).toBe(false);
    expect(metrics).toMatchObject({ component: "flow-check-ac", arm: "with-jev", reason: "flow 328 not yet landed" });
  });
});

describe("computeMetrics: accuracy (closed-world classification, e.g. ci-triage)", () => {
  test("every prediction has a known truth -> a measured accuracy", () => {
    const result: ComponentArmResult = {
      component: "ci-triage",
      arm: "with-jev",
      available: true,
      n: 4,
      predictions: [
        { id: "c1", flagged: true, correct: true },
        { id: "c2", flagged: true, correct: true },
        { id: "c3", flagged: true, correct: false },
        { id: "c4", flagged: false, correct: true },
      ],
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const metrics = computeMetrics(result);
    expect(metrics.available).toBe(true);
    if (!metrics.available) throw new Error("unreachable");
    expect(metrics.accuracy?.n).toBe(4);
    expect(metrics.accuracy?.rate).toBeCloseTo(0.75, 5);
    expect(hasMeasuredRate(metrics.accuracy)).toBe(true);
  });

  test("any unscored prediction (correct: null) makes accuracy unmeasured, not partially counted", () => {
    const result: ComponentArmResult = {
      component: "ci-triage",
      arm: "with-jev",
      available: true,
      n: 2,
      predictions: [
        { id: "c1", flagged: true, correct: true },
        { id: "c2", flagged: true, correct: null },
      ],
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const metrics = computeMetrics(result);
    if (!metrics.available) throw new Error("unreachable");
    expect(metrics.accuracy).toBeNull();
  });

  test("zero predictions is an absence, never a confident zero", () => {
    const result: ComponentArmResult = {
      component: "ci-triage",
      arm: "without-jev",
      available: true,
      n: 0,
      predictions: [],
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const metrics = computeMetrics(result);
    if (!metrics.available) throw new Error("unreachable");
    expect(metrics.accuracy).toBeNull();
    expect(metrics.n).toBe(0);
    expect(metrics.anecdotal).toBe(true);
  });
});

describe("computeMetrics: precision/noise (open-world flagging, e.g. review-conform)", () => {
  test("precision + noise sum to the flagged count; unflagged items are not in the denominator", () => {
    const result: ComponentArmResult = {
      component: "review-conform",
      arm: "with-jev",
      available: true,
      n: 5,
      predictions: [
        { id: "clause-1", flagged: true, correct: true },
        { id: "clause-2", flagged: true, correct: false },
        { id: "clause-3", flagged: false, correct: true }, // satisfied, not flagged — outside the precision denominator
        { id: "clause-4", flagged: true, correct: null }, // flagged but correctness unknown — outside the precision denominator too
        { id: "clause-5", flagged: false, correct: null },
      ],
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const metrics = computeMetrics(result);
    if (!metrics.available) throw new Error("unreachable");
    expect(metrics.precision?.n).toBe(2);
    expect(metrics.precision?.rate).toBeCloseTo(0.5, 5);
    expect(metrics.noise?.n).toBe(2);
    expect(metrics.noise?.rate).toBeCloseTo(0.5, 5);
  });

  test("no flagged-with-known-correctness items -> null, not zero", () => {
    const result: ComponentArmResult = {
      component: "review-conform",
      arm: "without-jev",
      available: true,
      n: 3,
      predictions: [
        { id: "clause-1", flagged: false, correct: null },
        { id: "clause-2", flagged: false, correct: null },
        { id: "clause-3", flagged: false, correct: null },
      ],
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const metrics = computeMetrics(result);
    if (!metrics.available) throw new Error("unreachable");
    expect(metrics.precision).toBeNull();
    expect(metrics.noise).toBeNull();
  });
});

describe("AC4: anecdotal labelling", () => {
  test(`n < ${ANECDOTAL_THRESHOLD_N} is anecdotal; n >= ${ANECDOTAL_THRESHOLD_N} is not`, () => {
    const make = (n: number): ComponentArmResult => ({
      component: "x",
      arm: "with-jev",
      available: true,
      n,
      predictions: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, flagged: true, correct: true })),
      usage,
      addedTruePositives: null,
      notes: [],
    });
    const below = computeMetrics(make(ANECDOTAL_THRESHOLD_N - 1));
    const atThreshold = computeMetrics(make(ANECDOTAL_THRESHOLD_N));
    if (!below.available || !atThreshold.available) throw new Error("unreachable");
    expect(below.anecdotal).toBe(true);
    expect(atThreshold.anecdotal).toBe(false);
  });
});

describe("AC4: repeat-run variance", () => {
  test("identical repeats -> zero stddev, a degenerate (point) bootstrap interval", () => {
    const report = varianceReport("ci-triage", [0.625, 0.625, 0.625]);
    expect(report.repeats).toBe(3);
    expect(report.mean).toBeCloseTo(0.625, 5);
    expect(report.stddev).toBeCloseTo(0, 10);
    expect(report.bootstrapCi95?.lower).toBeCloseTo(0.625, 5);
    expect(report.bootstrapCi95?.upper).toBeCloseTo(0.625, 5);
  });

  test("varying repeats produce a wider interval than identical ones", () => {
    const steady = varianceReport("x", [0.5, 0.5, 0.5, 0.5]);
    const varying = varianceReport("x", [0.2, 0.5, 0.5, 0.8]);
    const width = (v: typeof steady): number => (v.bootstrapCi95 ? v.bootstrapCi95.upper - v.bootstrapCi95.lower : 0);
    expect(width(varying)).toBeGreaterThan(width(steady));
    expect(varying.stddev).toBeGreaterThan(steady.stddev);
  });

  test("bootstrap is deterministic for a fixed seed", () => {
    const a = bootstrapMeanCi95([0.1, 0.4, 0.9], 500, 7);
    const b = bootstrapMeanCi95([0.1, 0.4, 0.9], 500, 7);
    expect(a).toEqual(b);
  });

  test("a single repeat is a degenerate point interval, not null", () => {
    const report = varianceReport("x", [0.7]);
    expect(report.bootstrapCi95).toEqual({ lower: 0.7, upper: 0.7 });
  });

  test("zero repeats is an honest absence", () => {
    const report = varianceReport("x", []);
    expect(report.bootstrapCi95).toBeNull();
    expect(report.repeats).toBe(0);
  });
});
