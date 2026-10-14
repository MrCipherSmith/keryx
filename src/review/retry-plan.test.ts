import { describe, expect, test } from "bun:test";
import { type RetryState, emptyRetryState, noEngineReason, planRetry } from "./retry-plan";
import { buildSlices, sliceSourceFromDiff } from "./slice";

function gitFile(filePath: string, count: number): string {
  const lines = Array.from({ length: count }, (_, n) => `+const v${n} = ${n};`);
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,0 +1,${count} @@\n${lines.join("\n")}\n`;
}

const built = buildSlices(sliceSourceFromDiff(gitFile("src/admin/ExamplePage.tsx", 40)), { maxBytes: 20_000 });
const textOf = (id: string): string => built.slices.find((slice) => slice.id === id)!.text;

function ask(reviewer: string, state: RetryState, needs: string[] = ["browser measurements at 1280px"]) {
  return planRetry({
    manifest: built.manifest,
    reviewer,
    result: { reviewer, status: "NEEDS_CONTEXT", needs_context: needs },
    state,
    readSliceText: (entry) => textOf(entry.id),
  });
}

describe("NEEDS_CONTEXT is one refill", () => {
  test("the first NEEDS_CONTEXT re-dispatches the role with its questions", () => {
    const first = ask("review-layout", emptyRetryState());
    expect(first.decision).toBe("context");
    expect(first.needsContext).toEqual(["browser measurements at 1280px"]);
    expect(first.state.reviewers["review-layout"]?.status).toBe("NEEDS_CONTEXT");
  });

  test("a second NEEDS_CONTEXT for review-layout is Not run with the reason `layout: no engine`", () => {
    const first = ask("review-layout", emptyRetryState());
    const second = ask("review-layout", first.state);
    expect(second.decision).toBe("not-run");
    expect(second.reason).toBe("layout: no engine");
    expect(second.reportLine).toContain("**Not run:** review-layout");
    expect(second.reportLine).toContain("layout: no engine");
    expect(second.state.reviewers["review-layout"]?.notRun).toBe(true);
    expect(second.wave).toEqual([]);
  });

  test("any other role gets the generic reason `no engine`", () => {
    const first = ask("review-logic", emptyRetryState());
    const second = ask("review-logic", first.state);
    expect(second.decision).toBe("not-run");
    expect(second.reason).toBe("no engine");
    expect(noEngineReason("review-logic")).toBe("no engine");
    expect(noEngineReason("review-layout")).toBe("layout: no engine");
  });

  test("a second NEEDS_CONTEXT with nothing new and no browser ask is Not run for lack of progress, not for a missing engine", () => {
    const first = ask("review-logic", emptyRetryState(), ["which module owns the retry cap?"]);
    const second = ask("review-logic", first.state, ["Which module owns the retry cap?"]);
    expect(second.decision).toBe("not-run");
    expect(second.reason).toBe("no progress after one context refill");
    expect(second.reportLine).not.toContain("no engine");
  });

  test("a browser ask that names a route without a browser is not read as a missing engine", () => {
    const first = ask("review-layout", emptyRetryState(), ["measure at 1280px, or source-only is fine if no browser is available"]);
    const second = ask("review-layout", first.state, ["measure at 1280px, or source-only is fine if no browser is available"]);
    expect(second.reason).toBe("no progress after one context refill");
  });

  test("a second NEEDS_CONTEXT that asks something new still gets its refill", () => {
    const first = ask("review-logic", emptyRetryState(), ["which module owns the retry cap?"]);
    const second = ask("review-logic", first.state, ["which module owns the retry cap?", "what does the caller pass for timeoutMs?"]);
    expect(second.decision).toBe("context");
    expect(second.needsContext).toEqual(["which module owns the retry cap?", "what does the caller pass for timeoutMs?"]);
    expect(second.stalls).toBe(0);
    const third = ask("review-logic", second.state, ["what does the caller pass for timeoutMs?"]);
    expect(third.decision).toBe("not-run");
  });

  test("a second NEEDS_CONTEXT that covered a new slice still gets its refill", () => {
    const first = ask("review-layout", emptyRetryState());
    const id = built.manifest.slices[0]!.id;
    const second = planRetry({
      manifest: built.manifest,
      reviewer: "review-layout",
      result: { reviewer: "review-layout", status: "NEEDS_CONTEXT", needs_context: ["browser measurements at 1280px"], slices: [id] },
      state: first.state,
      readSliceText: (entry) => textOf(entry.id),
    });
    expect(second.decision).toBe("context");
    expect(second.progress).toBe(true);
  });

  test("the refill count is per role: a second role's first question is still a refill", () => {
    const layout = ask("review-layout", emptyRetryState());
    const other = ask("review-logic", layout.state);
    expect(other.decision).toBe("context");
  });

  test("a role that never asked for context is untouched by the rule: DONE is still accepted", () => {
    const done = planRetry({
      manifest: built.manifest,
      reviewer: "review-layout",
      result: { reviewer: "review-layout", status: "DONE" },
      state: emptyRetryState(),
      readSliceText: (entry) => textOf(entry.id),
    });
    expect(done.decision).toBe("accepted");
  });
});
