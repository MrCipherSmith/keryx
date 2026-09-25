// Flow 331, AC4/AC7 — the report generator's honesty rules.
import { describe, expect, test } from "bun:test";
import { deriveRate } from "../../src/metrics/benchmark";
import { buildReport, formatRate, renderMarkdown } from "./report";
import { computeMetrics } from "./metrics";
import type { ComponentArmResult, ComponentNotAvailable } from "./types";

const usage = { jevCalls: 2, inputTokens: 100, cost: 0.0001, wallClockMs: 50 };

describe("formatRate: AC4 rule 1 — never a bare percentage", () => {
  test("a measured rate carries n and a 95% CI", () => {
    const rate = deriveRate(5, 8, "exact");
    const text = formatRate(rate);
    expect(text).toContain("n=8");
    expect(text).toContain("95% CI");
    expect(text).toContain("%");
  });

  test("null / unmeasured never renders as 0% — it says 'not measured'", () => {
    expect(formatRate(null)).toBe("not measured (n=0)");
    expect(formatRate(deriveRate(0, 0, "exact"))).toBe("not measured (n=0)");
    expect(formatRate(null)).not.toContain("0%");
  });
});

describe("renderMarkdown: AC4 anecdotal labelling", () => {
  test("a component with n < 10 is marked **anecdotal** in the table row", () => {
    const result: ComponentArmResult = {
      component: "ci-triage",
      arm: "with-jev",
      available: true,
      n: 8,
      predictions: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, flagged: true, correct: i % 2 === 0 })),
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const report = buildReport(
      [computeMetrics(result)],
      [],
      {
        generatedAt: "2026-09-25T00:00:00.000Z",
        mode: "offline",
        datasetCounts: { packages: 1, findings: 1, byLabel: { "true-positive": 1, "false-positive": 0, unlabeled: 0 } },
        totalUsage: { jevCalls: 2, cost: 0.0001, wallClockMs: 50 },
        notes: [],
      },
    );
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("**anecdotal**");
    expect(markdown).toContain("n=8");
  });

  test("a component with n >= 10 is not marked anecdotal", () => {
    const result: ComponentArmResult = {
      component: "ci-triage",
      arm: "with-jev",
      available: true,
      n: 12,
      predictions: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, flagged: true, correct: true })),
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const report = buildReport(
      [computeMetrics(result)],
      [],
      {
        generatedAt: "2026-09-25T00:00:00.000Z",
        mode: "offline",
        datasetCounts: { packages: 1, findings: 1, byLabel: { "true-positive": 1, "false-positive": 0, unlabeled: 0 } },
        totalUsage: { jevCalls: 2, cost: 0.0001, wallClockMs: 50 },
        notes: [],
      },
    );
    const row = renderMarkdown(report)
      .split("\n")
      .find((line) => line.includes("n=12"));
    expect(row).toBeDefined();
    expect(row).not.toContain("**anecdotal**");
  });
});

describe("renderMarkdown: AC4 anecdotal labelling is rate-level (flow 331, small fixes)", () => {
  test("a large-n component with a small flagged subset marks precision anecdotal even though the component's own n is not", () => {
    const predictions = [
      { id: "clause-1", flagged: true, correct: true },
      { id: "clause-2", flagged: true, correct: true },
      { id: "clause-3", flagged: true, correct: false },
      // 17 more predictions, unflagged and unscored — pushes the component's
      // overall n to 20 (well above the anecdotal threshold) while leaving
      // precision's actual denominator (the flagged-with-known-correctness
      // subset) at 3.
      ...Array.from({ length: 17 }, (_, i) => ({ id: `u${i}`, flagged: false, correct: null })),
    ];
    const result: ComponentArmResult = {
      component: "review-conform",
      arm: "with-jev",
      available: true,
      n: 20,
      predictions,
      usage,
      addedTruePositives: null,
      notes: [],
    };
    const metrics = computeMetrics(result);
    if (!metrics.available) throw new Error("unreachable");
    expect(metrics.n).toBe(20);
    expect(metrics.precision?.n).toBe(3);

    const markdown = renderMarkdown(
      buildReport([metrics], [], {
        generatedAt: "2026-09-25T00:00:00.000Z",
        mode: "offline",
        datasetCounts: { packages: 1, findings: 1, byLabel: { "true-positive": 1, "false-positive": 0, unlabeled: 0 } },
        totalUsage: { jevCalls: 0, cost: 0, wallClockMs: 0 },
        notes: [],
      }),
    );
    const row = markdown.split("\n").find((line) => line.startsWith("| review-conform |"));
    expect(row).toBeDefined();
    // The component-level tag (n=20) is not anecdotal...
    expect(row).toContain("(n=20)");
    // ...but precision's own n=3 is, and the row says so right next to that number.
    expect(row).toContain("precision: 66.7% (n=3");
    expect(row).toMatch(/precision: 66\.7% \(n=3, 95% CI \[[^\]]*\]\) \*\*anecdotal\*\*/);
  });
});

describe("renderMarkdown: not-available components", () => {
  test("prints the reason, not a metric", () => {
    const na: ComponentNotAvailable = { component: "flow-check-ac", arm: "with-jev", available: false, reason: "flow 328 not yet landed" };
    const report = buildReport(
      [computeMetrics(na)],
      [],
      {
        generatedAt: "2026-09-25T00:00:00.000Z",
        mode: "offline",
        datasetCounts: { packages: 0, findings: 0, byLabel: { "true-positive": 0, "false-positive": 0, unlabeled: 0 } },
        totalUsage: { jevCalls: 0, cost: 0, wallClockMs: 0 },
        notes: [],
      },
    );
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("not available");
    expect(markdown).toContain("flow 328 not yet landed");
  });
});

describe("renderMarkdown: variance section (AC4 rule 3)", () => {
  test("present only when the run measured repeats", () => {
    const reportWithout = buildReport([], [], {
      generatedAt: "x",
      mode: "offline",
      datasetCounts: { packages: 0, findings: 0, byLabel: { "true-positive": 0, "false-positive": 0, unlabeled: 0 } },
      totalUsage: { jevCalls: 0, cost: 0, wallClockMs: 0 },
      notes: [],
    });
    expect(renderMarkdown(reportWithout)).not.toContain("Variance across repeated");

    const reportWith = buildReport(
      [],
      [{ component: "ci-triage", repeats: 2, values: [0.6, 0.65], mean: 0.625, stddev: 0.025, bootstrapCi95: { lower: 0.6, upper: 0.65 } }],
      {
        generatedAt: "x",
        mode: "live",
        datasetCounts: { packages: 0, findings: 0, byLabel: { "true-positive": 0, "false-positive": 0, unlabeled: 0 } },
        totalUsage: { jevCalls: 0, cost: 0, wallClockMs: 0 },
        notes: [],
      },
    );
    expect(renderMarkdown(reportWith)).toContain("Variance across repeated");
  });
});
