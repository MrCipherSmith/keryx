import { describe, expect, test } from "bun:test";
import {
  estimateRequestTokens,
  estimateWithUsageAnchor,
  isContextOverflowError,
  needsCompaction,
  overflowTargetTokens,
  parseOverflowLimits,
  snapshotRequest,
  toUsageAnchor,
  type EstimatableMessage,
} from "./context-guard";
import type { NormalizedToolDefinition } from "./types";

// Flow 387 T7 (AC3): replayed reasoning bytes + provider-usage anchoring.
describe("replayed reasoning in the estimate (flow 387 T7)", () => {
  test("counts reasoning.replay payloads that the old content-only estimate missed", () => {
    const history: EstimatableMessage[] = [
      { content: "ok", reasoning: { replay: [{ data: "x".repeat(400_000) }, { data: { enc: "y".repeat(400) } }] } },
    ];
    // 400_000 + JSON.stringify({enc:"y"*400}).length (410) + "ok" (2), chars/4.
    expect(estimateRequestTokens(history, "", [])).toBe(Math.round(400_412 / 4));
    expect(estimateRequestTokens([{ content: "ok" }], "", [])).toBe(1);
  });

  test("a request with large replayed reasoning trips the guard the content-only estimate misses", () => {
    const history: EstimatableMessage[] = [
      { content: "q" },
      { content: "a", reasoning: { replay: [{ data: "z".repeat(600_000) }] } },
    ];
    const window = 100_000;
    expect(needsCompaction(Math.round(("q" + "a").length / 4), window)).toBe(false);
    expect(needsCompaction(estimateRequestTokens(history, "", []), window)).toBe(true);
  });
});

describe("estimateWithUsageAnchor (flow 387 T7)", () => {
  const sys = "s".repeat(40);
  const base = [{ content: "a".repeat(400) }, { content: "b".repeat(400) }];

  test("falls back to the full estimate with no anchor", () => {
    expect(estimateWithUsageAnchor(base, sys, [], undefined)).toBe(estimateRequestTokens(base, sys, []));
  });

  test("uses reported input tokens plus an estimate of messages appended since", () => {
    const anchor = toUsageAnchor(snapshotRequest(base, sys, []), 5_000);
    const history = [...base, { content: "c".repeat(800) }];
    expect(estimateWithUsageAnchor(history, sys, [], anchor)).toBe(5_000 + 200);
  });

  test("counts a change in system-instruction size since the anchored request", () => {
    const anchor = toUsageAnchor(snapshotRequest(base, sys, []), 5_000);
    expect(estimateWithUsageAnchor(base, sys + "p".repeat(400), [], anchor)).toBe(5_000 + 100);
  });

  test("counts replayed reasoning in the appended messages", () => {
    const anchor = toUsageAnchor(snapshotRequest(base, sys, []), 5_000);
    const history = [...base, { content: "", reasoning: { replay: [{ data: "r".repeat(4_000) }] } }];
    expect(estimateWithUsageAnchor(history, sys, [], anchor)).toBe(5_000 + 1_000);
  });

  test("drops the anchor when history shrank or the anchored prefix changed", () => {
    const anchor = toUsageAnchor(snapshotRequest(base, sys, []), 5_000);
    const shrunk = [base[0] as EstimatableMessage];
    expect(estimateWithUsageAnchor(shrunk, sys, [], anchor)).toBe(estimateRequestTokens(shrunk, sys, []));
    const spliced = [{ content: "summary" }, { content: "other" }, { content: "tail" }];
    expect(estimateWithUsageAnchor(spliced, sys, [], anchor)).toBe(estimateRequestTokens(spliced, sys, []));
  });

  test("ignores missing, zero or non-finite reported usage", () => {
    const snap = snapshotRequest(base, sys, []);
    expect(toUsageAnchor(snap, undefined)).toBeUndefined();
    expect(toUsageAnchor(snap, 0)).toBeUndefined();
    expect(toUsageAnchor(snap, Number.NaN)).toBeUndefined();
    expect(toUsageAnchor(snapshotRequest([], sys, []), 100)).toBeUndefined();
  });
});

describe("estimateRequestTokens", () => {
  test("sums message content only when there is nothing else to count", () => {
    expect(estimateRequestTokens([], "", [])).toBe(0);
    expect(estimateRequestTokens([{ content: "abcd" }], "", [])).toBe(1);
    expect(
      estimateRequestTokens([{ content: "a".repeat(400) }, { content: "b".repeat(400) }], "", []),
    ).toBe(200);
  });

  test("includes toolCalls[].arguments — content alone undercounts a tool-call-heavy round", () => {
    const withoutArgs = estimateRequestTokens([{ content: "" }], "", []);
    const withArgs = estimateRequestTokens(
      [{ content: "", toolCalls: [{ arguments: "x".repeat(400) }] }],
      "",
      [],
    );
    expect(withoutArgs).toBe(0);
    expect(withArgs).toBe(100);
  });

  test("includes the system instruction", () => {
    expect(estimateRequestTokens([], "s".repeat(40), [])).toBe(10);
  });

  test("includes JSON.stringify(toolDefs) — the tool schema payload sent every round", () => {
    const toolDefs: NormalizedToolDefinition[] = [
      { name: "t", description: "", inputSchema: { type: "object", properties: {} } },
    ];
    const withTools = estimateRequestTokens([], "", toolDefs);
    expect(withTools).toBe(Math.round(JSON.stringify(toolDefs).length / 4));
    expect(withTools).toBeGreaterThan(0);
  });

  test("an empty tool list contributes nothing (no phantom '[]' bytes)", () => {
    expect(estimateRequestTokens([], "", [])).toBe(0);
  });
});

describe("needsCompaction", () => {
  test("undefined window never trips the guard, at any estimate", () => {
    expect(needsCompaction(0, undefined)).toBe(false);
    expect(needsCompaction(1_000_000, undefined)).toBe(false);
  });

  test("trips at/above 85% of a known window", () => {
    expect(needsCompaction(849, 1000)).toBe(false);
    expect(needsCompaction(850, 1000)).toBe(true);
    expect(needsCompaction(851, 1000)).toBe(true);
  });

  test("well under the threshold never trips", () => {
    expect(needsCompaction(100, 1000)).toBe(false);
  });
});

// Flow 387 review r1 F-005: provider-specific overflow wording.
describe("isContextOverflowError per provider shape (flow 387 review r1 F-005)", () => {
  test("Anthropic: plain message and the raw invalid_request_error body", () => {
    expect(
      isContextOverflowError({ kind: "invalid_request", message: "prompt is too long: 210000 tokens > 200000 maximum" }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        kind: "unknown",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
      }),
    ).toBe(true);
  });

  test("Gemini: input token count exceeds the maximum", () => {
    expect(
      isContextOverflowError({
        kind: "invalid_request",
        message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048575).",
      }),
    ).toBe(true);
  });

  test("auth, rate-limit and 5xx errors are never matched, even with overflow wording", () => {
    const message = "prompt is too long: input token count (9) exceeds the context window";
    for (const kind of ["auth", "rate_limit", "server_error", "unavailable"]) {
      expect(isContextOverflowError({ kind, message })).toBe(false);
    }
    expect(isContextOverflowError({ kind: "invalid_request", message: "bad tool schema" })).toBe(false);
  });
});

describe("parseOverflowLimits / overflowTargetTokens", () => {
  // flow 387 review r1 F-006
  test("reads the figures out of each provider's wording", () => {
    expect(parseOverflowLimits("prompt is too long: 210000 tokens > 200000 maximum")).toEqual({
      actual: 210000,
      limit: 200000,
    });
    expect(
      parseOverflowLimits("maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens."),
    ).toEqual({ actual: 150000, limit: 128000 });
    expect(
      parseOverflowLimits("The input token count (1200000) exceeds the maximum number of tokens allowed (1048575)."),
    ).toEqual({ actual: 1200000, limit: 1048575 });
    expect(parseOverflowLimits("your prompt contains at least 200001 input tokens")).toEqual({ actual: 200001 });
    expect(parseOverflowLimits("too long")).toEqual({});
  });

  test("target is 70% of the stated limit, else of the window, else unknown", () => {
    expect(overflowTargetTokens({ limit: 100_000 }, 500_000, 90_000)).toBe(70_000);
    expect(overflowTargetTokens({}, 100_000, 90_000)).toBe(70_000);
    expect(overflowTargetTokens({}, undefined, 90_000)).toBeUndefined();
  });

  test("scales the target by how far the estimator under-measured", () => {
    // Estimator said 100K, provider counted 200K: an estimator-unit target must be half of 70K.
    expect(overflowTargetTokens({ limit: 100_000, actual: 200_000 }, undefined, 100_000)).toBe(35_000);
  });

  // flow 387 review r2 F-027: the branches the cases above never reach.
  test("does not scale when the estimator did not under-measure", () => {
    // The provider counted LESS than (or as much as) the estimate: the estimate was not low.
    expect(overflowTargetTokens({ limit: 100_000, actual: 50_000 }, undefined, 100_000)).toBe(70_000);
    expect(overflowTargetTokens({ limit: 100_000, actual: 100_000 }, undefined, 100_000)).toBe(70_000);
  });

  test("an estimate of 0 is never used as a divisor", () => {
    expect(overflowTargetTokens({ limit: 100_000, actual: 200_000 }, undefined, 0)).toBe(70_000);
  });

  test("scales against the configured window when the message stated no limit", () => {
    expect(overflowTargetTokens({ actual: 200_000 }, 100_000, 100_000)).toBe(35_000);
  });

  test("the limit the provider stated wins over the configured window", () => {
    expect(overflowTargetTokens({ limit: 100_000 }, 1_000_000, 10_000)).toBe(70_000);
  });

  test("reads comma- and underscore-grouped figures", () => {
    expect(parseOverflowLimits("The input token count (1,200,000) exceeds the maximum number of tokens allowed (1,048,576).")).toEqual({
      actual: 1_200_000,
      limit: 1_048_576,
    });
    expect(parseOverflowLimits("maximum context length is 128_000 tokens, resulted in 150_000 tokens")).toEqual({
      actual: 150_000,
      limit: 128_000,
    });
  });

  test("reads a limit stated as a context window or limit, and ignores zero or missing figures", () => {
    expect(parseOverflowLimits("exceeds a context window of 32768")).toEqual({ limit: 32768 });
    expect(parseOverflowLimits("maximum context length is 0 tokens")).toEqual({});
    expect(parseOverflowLimits(undefined)).toEqual({});
  });
});
