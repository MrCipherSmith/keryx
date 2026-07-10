import { test, expect } from "bun:test";
import { computeTrend, type HistoryPoint } from "./history";

function points(scores: number[]): HistoryPoint[] {
  return scores.map((score, index) => ({
    generatedAt: `t${index}`,
    gate: "pass",
    projectScore: score,
    scores: { project: score, "module:x": score - 1 },
  }));
}

test("improving trend when score rises beyond threshold", () => {
  const trend = computeTrend(points([80, 85, 92]), "project");
  expect(trend.direction).toBe("improving");
  expect(trend.first).toBe(80);
  expect(trend.current).toBe(92);
  expect(trend.delta).toBe(12);
  expect(trend.min).toBe(80);
  expect(trend.max).toBe(92);
  expect(trend.count).toBe(3);
});

test("declining trend when score drops beyond threshold", () => {
  expect(computeTrend(points([90, 80]), "project").direction).toBe("declining");
});

test("stable within the +/-2 band", () => {
  expect(computeTrend(points([90, 91]), "project").direction).toBe("stable");
});

test("a single point is unknown", () => {
  expect(computeTrend(points([90]), "project").direction).toBe("unknown");
});

test("missing scope yields an empty unknown trend", () => {
  const trend = computeTrend(points([90, 91]), "module:missing");
  expect(trend.count).toBe(0);
  expect(trend.direction).toBe("unknown");
  expect(trend.current).toBe(null);
});

test("resolves a non-project scope series", () => {
  const trend = computeTrend(points([80, 90]), "module:x");
  expect(trend.series).toEqual([79, 89]);
});
