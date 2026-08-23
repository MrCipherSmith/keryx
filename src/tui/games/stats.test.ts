import { expect, test } from "bun:test";
import { addTurn, emptyTurnTotals, formatMs, formatTokens, type AgentTurnStats } from "./stats";

test("formatMs renders milliseconds and seconds", () => {
  expect(formatMs(undefined)).toBe("–");
  expect(formatMs(500)).toBe("500ms");
  expect(formatMs(1500)).toBe("1.5s");
  expect(formatMs(60_000)).toBe("60.0s");
});

test("formatTokens renders raw counts and k-abbreviation", () => {
  expect(formatTokens(undefined)).toBe("–");
  expect(formatTokens(12)).toBe("12");
  expect(formatTokens(12400)).toBe("12.4k");
});

test("addTurn accumulates totals and skips undefined fields", () => {
  const t1: AgentTurnStats = {
    provider: "p", model: "m", latencyMs: 100, totalMs: 250, inputTokens: 10, outputTokens: 2,
    reasoning: true, localFallback: false, error: false,
  };
  const t2: AgentTurnStats = {
    provider: "p", model: "m", latencyMs: undefined, totalMs: undefined, inputTokens: undefined,
    outputTokens: undefined, reasoning: false, localFallback: true, error: true,
  };
  const totals = addTurn(addTurn(emptyTurnTotals(), t1), t2);
  expect(totals.turns).toBe(2);
  expect(totals.latencyMs).toBe(100);
  expect(totals.totalMs).toBe(250);
  expect(totals.inputTokens).toBe(10);
  expect(totals.outputTokens).toBe(2);
  expect(totals.localFallbacks).toBe(1);
  expect(totals.errors).toBe(1);
});

test("emptyTurnTotals is zeroed", () => {
  expect(emptyTurnTotals()).toEqual({
    turns: 0, latencyMs: undefined, totalMs: undefined, inputTokens: undefined,
    outputTokens: undefined, localFallbacks: 0, errors: 0,
  });
});
