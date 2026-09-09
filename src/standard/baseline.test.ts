import { expect, test } from "bun:test";
import { classifyBaseline, classifyBaselineStatuses, type BaselineStatus } from "./baseline";

test("classifies a passing main baseline separately from a failing PR", () => {
  const result = classifyBaselineStatuses("pass", "fail");
  expect(result.classification).toBe("baseline-green");
  expect(result.prIntroducedFailure).toBe(true);
  expect(result.blocking).toBe(true);
});

test("does not attribute a PR failure when main is already red", () => {
  const result = classifyBaselineStatuses("fail", "fail");
  expect(result.classification).toBe("baseline-red");
  expect(result.prIntroducedFailure).toBe(false);
  // A MEASURED red main is the one legitimate excuse, and it stays one.
  expect(result.blocking).toBe(false);
});

test("missing provenance is baseline-unknown", () => {
  const result = classifyBaseline(null, null);
  expect(result.classification).toBe("baseline-unknown");
  expect(result.prIntroducedFailure).toBe(false);
});

/**
 * F-240-04 (flow 240 T7). CI folded every non-zero `standard validate` exit into
 * `status=fail`, so a baseline job whose CLI simply would not boot published
 * `baseline-red` — and a red baseline excused every PR failure. Reproduced
 * before the fix, feeding the measured statuses to this classifier:
 *
 *   --baseline pass    --pr fail -> baseline-green,   exit 1  (gate holds)
 *   --baseline fail    --pr fail -> baseline-red,     exit 0
 *   --baseline unknown --pr fail -> baseline-unknown, exit 0  <- the hole
 *
 * CI now reports `unknown` for "the command produced no verdict", which closes
 * the first half. This closes the second: an UNMEASURED baseline excuses
 * nothing, and a PR check that itself did not run has not passed.
 */
test("F-240-04: an unmeasured baseline does not excuse a PR failure", () => {
  const result = classifyBaselineStatuses("unknown", "fail");
  expect(result.classification).toBe("baseline-unknown");
  expect(result.blocking).toBe(true);
  expect(result.reasons.join("\n")).toMatch(/never measured|cannot be excused/i);
});

test("F-240-04: a PR check that produced no verdict is never a pass", () => {
  for (const baseline of ["pass", "fail", "unknown"] as const) {
    const result = classifyBaselineStatuses(baseline, "unknown");
    expect(result.prNotRun).toBe(true);
    expect(result.blocking).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/did not run|no verdict/i);
  }
});

/**
 * The whole exit-code surface in one table, so a future edit to `blocking` has
 * to change a stated decision rather than slip through on the three cases
 * somebody happened to write a test for. `blocking` maps 1:1 onto the process
 * exit code in `src/commands/standard.ts`.
 */
test("the blocking rule is total over baseline x pr", () => {
  const expected: Record<string, boolean> = {
    "pass/pass": false,
    "pass/fail": true,
    "pass/unknown": true,
    "fail/pass": false,
    "fail/fail": false, // measured red main: diagnostic, not attributable
    "fail/unknown": true,
    "unknown/pass": false, // the PR's own check ran and passed; nothing to block
    "unknown/fail": true,
    "unknown/unknown": true,
  };
  const statuses: BaselineStatus[] = ["pass", "fail", "unknown"];
  const actual: Record<string, boolean> = {};
  for (const baseline of statuses) {
    for (const pr of statuses) {
      actual[`${baseline}/${pr}`] = classifyBaselineStatuses(baseline, pr).blocking;
    }
  }
  expect(actual).toEqual(expected);
});
