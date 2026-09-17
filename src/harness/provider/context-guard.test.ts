import { describe, expect, test } from "bun:test";
import { estimateRequestTokens, needsCompaction } from "./context-guard";
import type { NormalizedToolDefinition } from "./types";

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
