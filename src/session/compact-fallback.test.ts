import { expect, test } from "bun:test";
import { compactInTurn, compactMessages, compactWithFallback } from "./compact";
import { estimateRequestTokens } from "../harness/provider/context-guard";
import type { NormalizedMessage } from "../harness/provider/types";

// Flow 387 T11 (Part B, AC9): compaction inside one long operator turn.

function user(content: string): NormalizedMessage {
  return { role: "user", content, provenance: "project" };
}
function pair(id: string, chars: number, args = "{}"): NormalizedMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      provenance: "model",
      toolCalls: [{ id, name: "read_file", arguments: args }],
    },
    { role: "tool", content: "r".repeat(chars), provenance: "tool", toolCallId: id },
  ];
}
/** One operator request followed by `count` tool round trips. */
function oneLongTurn(count: number, chars: number): NormalizedMessage[] {
  const h: NormalizedMessage[] = [user("продолжай")];
  for (let i = 0; i < count; i++) {
    h.push(...pair(`c${i}`, chars, JSON.stringify({ path: `src/f${i}.ts` })));
  }
  return h;
}
/** Every tool message's call is the assistant message directly before its group. */
function expectBalanced(context: readonly NormalizedMessage[]): void {
  const calls = new Set<string>();
  for (const m of context) {
    for (const c of m.role === "assistant" ? (m.toolCalls ?? []) : []) {
      calls.add(c.id);
    }
    if (m.role === "tool") {
      expect(calls.has(m.toolCallId ?? "")).toBe(true);
    }
  }
}

test("compactMessages alone removes nothing inside a single turn; the fallback does", () => {
  const h = oneLongTurn(30, 4_000);
  expect(compactMessages(h, { keepLastUserTurns: 3 }).noop).toBe(true);
  expect(compactWithFallback(h, { keepLastUserTurns: 3, tailTokens: 5_000 }).noop).toBe(false);
});

test("in-turn cut keeps the operator message and a balanced verbatim tail", () => {
  const h = oneLongTurn(30, 4_000); // ~1000 tokens per result
  const r = compactInTurn(h, { tailTokens: 5_000 });
  expect(r.noop).toBe(false);
  const kept = r.context.filter((m) => m.role !== "user" || m.content === "продолжай");
  expect(kept.some((m) => m.content === "продолжай")).toBe(true);
  expect(r.context.length).toBeLessThan(h.length);
  expectBalanced(r.context);
  // The last message is untouched and the tail is bounded near the budget.
  expect(r.context[r.context.length - 1]).toBe(h[h.length - 1]);
  expect(estimateRequestTokens(r.context, "", [])).toBeLessThan(8_000);
});

test("in-turn summary lists files read and tools run from the removed part", () => {
  const r = compactInTurn(oneLongTurn(30, 4_000), { tailTokens: 5_000 });
  expect(r.summaryText).toContain("Files read: src/f0.ts");
  expect(r.summaryText).toContain("Tools run: read_file ×");
});

test("a tool result that starts the tail is cut with its call, never orphaned", () => {
  // Parallel calls: one assistant message, three results.
  const h: NormalizedMessage[] = [
    user("go"),
    ...pair("a", 40_000),
    {
      role: "assistant",
      content: "",
      provenance: "model",
      toolCalls: [
        { id: "p1", name: "read_file", arguments: "{}" },
        { id: "p2", name: "read_file", arguments: "{}" },
        { id: "p3", name: "read_file", arguments: "{}" },
      ],
    },
    { role: "tool", content: "x".repeat(8_000), provenance: "tool", toolCallId: "p1" },
    { role: "tool", content: "x".repeat(8_000), provenance: "tool", toolCallId: "p2" },
    { role: "tool", content: "x".repeat(8_000), provenance: "tool", toolCallId: "p3" },
  ];
  // Budget lands between p1 and p2 results; the group must go whole.
  const r = compactInTurn(h, { tailTokens: 4_500 });
  expectBalanced(r.context);
});

test("fallback tries fewer operator turns before cutting inside the turn", () => {
  const h: NormalizedMessage[] = [
    user("one"),
    ...pair("a", 4_000),
    user("two"),
    ...pair("b", 4_000),
    user("three"),
    ...pair("c", 4_000),
  ];
  const r = compactWithFallback(h, { keepLastUserTurns: 3, fits: (ctx) => ctx.length < h.length - 1 });
  expect(r.noop).toBe(false);
  // 3 turns requested but only keeping 2 removed anything; a whole turn was cut, no in-turn cut.
  expect(r.context.some((m) => m.content === "two")).toBe(true);
  expect(r.context.some((m) => m.content === "one")).toBe(false);
});

test("fallback cuts inside the turn when one turn alone is over the limit", () => {
  const h = oneLongTurn(30, 4_000);
  const fits = (ctx: readonly NormalizedMessage[]): boolean => estimateRequestTokens(ctx, "", []) < 12_000;
  const r = compactWithFallback(h, { keepLastUserTurns: 3, fits, tailTokens: 5_000 });
  expect(r.noop).toBe(false);
  expect(fits(r.context)).toBe(true);
  expectBalanced(r.context);
});

test("in-turn cut is a noop when the turn is already within the tail budget", () => {
  expect(compactInTurn(oneLongTurn(3, 400), { tailTokens: 20_000 }).noop).toBe(true);
});

test("F-012: the in-turn cut counts replayed reasoning when sizing its tail", () => {
  // Ten rounds, each with a tiny result but 16K chars (4K tokens) of replayed reasoning.
  const h: NormalizedMessage[] = [user("go")];
  for (let i = 0; i < 10; i++) {
    const [assistant, tool] = pair(`r${i}`, 100);
    h.push(
      {
        ...(assistant as NormalizedMessage),
        reasoning: { replay: [{ providerId: "openai-codex", kind: "encrypted_content", data: "Z".repeat(16_000) }] },
      },
      tool as NormalizedMessage,
    );
  }
  const r = compactInTurn(h, { tailTokens: 9_000 });
  expect(r.noop).toBe(false);
  const kept = r.context.filter((m) => m.role === "assistant" || m.role === "tool");
  // Content alone would let all ten rounds fit (~600 tokens); with reasoning counted
  // only about two rounds fit a 9K-token tail.
  expect(kept.filter((m) => m.role === "assistant").length).toBeLessThanOrEqual(3);
  expect(estimateRequestTokens(kept, "", [])).toBeLessThan(13_000);
  expectBalanced(r.context);
});
