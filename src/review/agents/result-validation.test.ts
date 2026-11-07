import { expect, test } from "bun:test";
import { reviewAgentResultStatus } from "./result-validation";
const result = { reviewer: "worker", status: "DONE", summary: "Reviewed", findings: [], stats: { blocker: 0, major: 0, minor: 0, info: 0 } };
test("validates native text and structured submission envelopes", () => {
  expect(reviewAgentResultStatus({ text: JSON.stringify(result) })).toBe("completed");
  expect(reviewAgentResultStatus({ text: "commentary", submittedResult: result })).toBe("completed");
});
test("invalid structured submission cannot fall back to valid text", () => {
  for (const submittedResult of [null, {}, "done", undefined]) {
    expect(() => reviewAgentResultStatus({ text: JSON.stringify(result), submittedResult })).toThrow("invalid_review_result");
  }
  expect(() => reviewAgentResultStatus({ text: "done" })).toThrow("invalid_review_result");
});
