// Flow 424 (AC9): the `action.review` block of a scheduled autonomous review.

import { describe, expect, test } from "bun:test";
import { normalizeReviewConfig, reviewConfigProblems, REVIEW_STALL_MINUTES_DEFAULT } from "./review-config";

const REF = "https://github.com/o/r/pull/7";

describe("reviewConfigProblems", () => {
  test("no block is valid", () => {
    expect(reviewConfigProblems(undefined, undefined)).toEqual([]);
  });

  test("a pull request URL with or without budgets is valid", () => {
    expect(reviewConfigProblems({ ref: REF }, undefined)).toEqual([]);
    expect(reviewConfigProblems({ ref: `${REF}/`, budgetMinutes: 90, budgetTokens: 500_000, stallMinutes: 5 }, undefined)).toEqual([]);
  });

  test("anything that is not a pull request URL is refused", () => {
    for (const ref of ["123", "https://github.com/o/r", "https://github.com/o/r/issues/7", "http://github.com/o/r/pull/7", "https://evil.example/o/r/pull/7", 7, undefined]) {
      expect(reviewConfigProblems({ ref }, undefined).join("\n")).toContain("action.review.ref");
    }
  });

  test("a bad budget is refused, not ignored", () => {
    expect(reviewConfigProblems({ ref: REF, budgetMinutes: 0 }, undefined).join("\n")).toContain("budgetMinutes");
    expect(reviewConfigProblems({ ref: REF, stallMinutes: -1 }, undefined).join("\n")).toContain("stallMinutes");
    expect(reviewConfigProblems({ ref: REF, budgetTokens: 1.5 }, undefined).join("\n")).toContain("budgetTokens");
    expect(reviewConfigProblems({ ref: REF, budgetMinutes: "soon" }, undefined).join("\n")).toContain("budgetMinutes");
  });

  test("an unknown field is refused", () => {
    expect(reviewConfigProblems({ ref: REF, budgetUsd: 3 }, undefined).join("\n")).toContain("action.review.budgetUsd: unknown field");
  });

  test("a non-object block is refused", () => {
    expect(reviewConfigProblems("pr", undefined).join("\n")).toContain("must be an object");
    expect(reviewConfigProblems([REF], undefined).join("\n")).toContain("must be an object");
  });

  test("it cannot be combined with a digest", () => {
    expect(reviewConfigProblems({ ref: REF }, { digest: {} }).join("\n")).toContain("cannot be combined with action.digest");
  });
});

describe("normalizeReviewConfig", () => {
  test("the stall limit defaults to ten minutes and the ref is trimmed", () => {
    expect(normalizeReviewConfig({ ref: ` ${REF} ` })).toEqual({ ref: REF, stallMinutes: REVIEW_STALL_MINUTES_DEFAULT });
    expect(REVIEW_STALL_MINUTES_DEFAULT).toBe(10);
  });

  test("the budgets are kept", () => {
    expect(normalizeReviewConfig({ ref: REF, budgetMinutes: 30, budgetTokens: 1000, stallMinutes: 3 })).toEqual({ ref: REF, budgetMinutes: 30, budgetTokens: 1000, stallMinutes: 3 });
  });

  test("a block with no ref normalizes to nothing", () => {
    expect(normalizeReviewConfig({})).toBeUndefined();
    expect(normalizeReviewConfig(undefined)).toBeUndefined();
  });
});
