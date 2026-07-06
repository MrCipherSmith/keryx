import { test, expect } from "bun:test";
import {
  complexityPenalty,
  coveragePenalty,
  healthScore,
  regressionScore,
  riskScore,
  trendOf,
} from "./scoring";
import { DEFAULT_HEALTH_CONFIG as C } from "./config";

test("riskScore applies priority weights", () => {
  expect(riskScore({ P0: 1, P1: 2, P2: 0, P3: 0 }, C.scoring.priorityWeights)).toBe(
    100 + 40,
  );
});

test("complexityPenalty counts functions above threshold (not sum of excess)", () => {
  // threshold 10, weight 2 -> 12 and 20 are above -> 2 * 2
  expect(complexityPenalty([5, 12, 20], C)).toBe(2 * C.scoring.complexityWeight);
  expect(complexityPenalty([1, 2, 3], C)).toBe(0);
});

test("coveragePenalty is zero at/above target and null coverage", () => {
  expect(coveragePenalty(80, C)).toBe(0);
  expect(coveragePenalty(90, C)).toBe(0);
  expect(coveragePenalty(70, C)).toBe(10 * C.scoring.coverageWeight);
  expect(coveragePenalty(null, C)).toBe(0);
});

test("healthScore normalizes per LOC and clamps to [0,100]", () => {
  expect(healthScore({ risk: 0, coverage: 0, complexity: 0, loc: 1000 }, C)).toBe(100);
  expect(healthScore({ risk: 100, coverage: 0, complexity: 0, loc: 1000 }, C)).toBe(0);
  expect(healthScore({ risk: 100, coverage: 0, complexity: 0, loc: 2000 }, C)).toBe(50);
  // large penalty on tiny scope still clamps at 0
  expect(healthScore({ risk: 9999, coverage: 0, complexity: 0, loc: 10 }, C)).toBe(0);
});

test("trendOf classifies against baseline", () => {
  expect(trendOf(95, 90)).toBe("improved");
  expect(trendOf(85, 90)).toBe("regressed");
  expect(trendOf(91, 90)).toBe("stable");
  expect(trendOf(90, null)).toBe("unknown");
});

test("regressionScore is baseline minus current", () => {
  expect(regressionScore(85, 90)).toBe(5);
  expect(regressionScore(95, 90)).toBe(-5);
  expect(regressionScore(90, null)).toBe(0);
});
