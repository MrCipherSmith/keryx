import { describe, expect, test } from "bun:test";
import {
  estimateRequestTokens,
  estimateWithUsageAnchor,
  needsCompaction,
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
