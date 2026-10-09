import { describe, expect, test } from "bun:test";
import { checkDispatch } from "./dispatch-check";
import { notRunLine, planRetry } from "./retry-plan";
import { buildSlices, sliceSourceFromDiff } from "./slice";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_context: {
      request: { raw: "review the change" },
      scope: { mode: "diff", files: ["src/a.ts"] },
      routing: { selected_reviewers: ["review-logic"] },
      token_policy: { context_mode: "light", omissions: [] },
    },
    reviewer: "review-logic",
    scope_mode: "diff",
    model: { tier: "standard", tier_reasons: ["base"], tier_resolution: "session-fallback", model_discovery: {}, inherit: true },
    budget: { max_findings: 10 },
    ...overrides,
  };
}

function gitFile(filePath: string, count: number): string {
  const lines = Array.from({ length: count }, (_, n) => `+const v${n} = ${n};`);
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,0 +1,${count} @@\n${lines.join("\n")}\n`;
}

describe("checkDispatch", () => {
  test("a diff-scope payload with no slice and no diff is refused with REVIEWER_INPUT_NO_SLICE", async () => {
    const result = await checkDispatch([payload()]);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("REVIEWER_INPUT_NO_SLICE");
  });

  test("a payload that breaks the schema is REVIEWER_INPUT_INVALID", async () => {
    const result = await checkDispatch([payload({ budget: { max_findings: 0 }, slices: ["slice-01"] })], {
      pathBytes: () => 10,
    });
    expect(result.errors.some((error) => error.code === "REVIEWER_INPUT_INVALID")).toBe(true);
  });

  test("a named slice that fits passes; one over the ceiling is refused", async () => {
    const manifest = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 5))).manifest;
    const fits = await checkDispatch([payload({ slices: ["slice-01"] })], { manifest });
    expect(fits.errors).toEqual([]);
    expect(fits.ok).toBe(true);

    const over = await checkDispatch([payload({ slices: ["slice-01"] })], { manifest, maxBytes: 10 });
    expect(over.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_TOO_LARGE"]);
  });

  test("an unknown slice is REVIEWER_INPUT_SLICE_UNKNOWN", async () => {
    const manifest = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", 5))).manifest;
    const result = await checkDispatch([payload({ slices: ["slice-99"] })], { manifest });
    expect(result.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_SLICE_UNKNOWN"]);
  });

  test("a whole-diff string over the ceiling is refused, a small one passes, path scope needs no slice", async () => {
    const big = await checkDispatch([payload({ diff: "x".repeat(500) })], { maxBytes: 300 });
    expect(big.errors.map((error) => error.code)).toEqual(["REVIEWER_INPUT_TOO_LARGE"]);
    const small = await checkDispatch([payload({ diff: "x".repeat(100) })], { maxBytes: 300 });
    expect(small.ok).toBe(true);
    const path = await checkDispatch([payload({ scope_mode: "path", target_path: "src/a.ts" })]);
    expect(path.ok).toBe(true);
  });
});

describe("planRetry", () => {
  const diff = Array.from({ length: 6 }, (_, index) => gitFile(`src/m/f${index}.ts`, 60)).join("");
  const built = buildSlices(sliceSourceFromDiff(diff), { maxBytes: 20_000 });
  const textOf = (id: string): string => built.slices.find((slice) => slice.id === id)!.text;
  const base = {
    manifest: built.manifest,
    reviewer: "review-logic",
    readSliceText: (entry: { id: string }) => textOf(entry.id),
  };
  const empty = { schemaVersion: 1 as const, reviewers: {} };

  test("a finished status is accepted", () => {
    const plan = planRetry({ ...base, result: { status: "DONE" }, state: empty });
    expect(plan.decision).toBe("accepted");
  });

  test("the first INCOMPLETE gets one retry on slices at most half the size", () => {
    const largest = Math.max(...built.manifest.slices.map((slice) => slice.bytes));
    const plan = planRetry({ ...base, result: { status: "INCOMPLETE" }, state: empty });
    expect(plan.decision).toBe("retry");
    expect(plan.newSlices.length).toBeGreaterThan(built.manifest.slices.length);
    for (const slice of plan.newSlices) {
      expect(slice.bytes).toBeLessThanOrEqual(largest / 2);
      expect(slice.id.startsWith("r1-review-logic-")).toBe(true);
      expect(slice.attempt).toBe(1);
    }
    expect(plan.state.reviewers["review-logic"]).toEqual({ attempt: 1, status: "INCOMPLETE", notRun: false });
  });

  test("a second failure is not-run with the report line, and is never retried again", () => {
    const first = planRetry({ ...base, result: { status: "INCOMPLETE" }, state: empty });
    const second = planRetry({ ...base, result: { status: "BLOCKED" }, state: first.state });
    expect(second.decision).toBe("not-run");
    expect(second.reportLine).toBe(notRunLine("review-logic", "BLOCKED"));
    expect(second.reportLine).toContain("- **Not run:** review-logic");
    expect(second.reportLine).toContain("never counted as a clean pass");
    expect(second.newSlices).toEqual([]);
    expect(second.state.reviewers["review-logic"]?.notRun).toBe(true);
  });

  test("the attempt in the result itself also counts", () => {
    const plan = planRetry({ ...base, result: { status: "INCOMPLETE", attempt: 1 }, state: empty });
    expect(plan.decision).toBe("not-run");
  });

  test("a slice too small to halve is not-run rather than an endless retry", () => {
    const tiny = buildSlices(sliceSourceFromDiff(gitFile("src/t.ts", 1)));
    const plan = planRetry({
      manifest: tiny.manifest,
      result: { status: "INCOMPLETE" },
      reviewer: "review-logic",
      state: empty,
      readSliceText: () => tiny.slices[0]!.text,
    });
    expect(plan.decision).toBe("not-run");
  });
});
