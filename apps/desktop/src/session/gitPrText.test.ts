import { describe, expect, test } from "bun:test";
import type { PrInfo } from "../platform/commands";
import { ciTitle, prTitle, threadsTitle } from "./gitPrText";

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 1234,
  url: "https://github.com/o/r/pull/1234",
  isDraft: false,
  reviewDecision: "",
  ci: "passed",
  checksPassed: 14,
  checksFailed: 0,
  checksPending: 0,
  unresolvedThreads: 0,
  ...over,
});

describe("git status tooltips", () => {
  test("the CI rollup is spelled out", () => {
    expect(ciTitle(pr({ ci: "failed", checksFailed: 2 }))).toBe("CI: 2 failed, 14 passed");
    expect(ciTitle(pr({ ci: "pending", checksPending: 3, checksPassed: 1 }))).toBe("CI: 3 running, 1 passed");
    expect(ciTitle(pr())).toBe("CI: 14 passed");
  });

  test("no checks means no CI tooltip", () => {
    expect(ciTitle(pr({ ci: "none", checksPassed: 0 }))).toBeNull();
  });

  test("threads are counted in the singular and plural", () => {
    expect(threadsTitle(1)).toBe("1 unresolved review thread");
    expect(threadsTitle(3)).toBe("3 unresolved review threads");
  });

  test("a draft PR says so", () => {
    expect(prTitle(pr({ isDraft: true }))).toContain("(draft)");
  });
});
