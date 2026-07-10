import { expect, test } from "bun:test";
import { classifyBaseline, classifyBaselineStatuses } from "./baseline";

test("classifies a passing main baseline separately from a failing PR", () => {
  const result = classifyBaselineStatuses("pass", "fail");
  expect(result.classification).toBe("baseline-green");
  expect(result.prIntroducedFailure).toBe(true);
});

test("does not attribute a PR failure when main is already red", () => {
  const result = classifyBaselineStatuses("fail", "fail");
  expect(result.classification).toBe("baseline-red");
  expect(result.prIntroducedFailure).toBe(false);
});

test("missing provenance is baseline-unknown", () => {
  const result = classifyBaseline(null, null);
  expect(result.classification).toBe("baseline-unknown");
  expect(result.prIntroducedFailure).toBe(false);
});
