import { describe, expect, test } from "bun:test";
import { createUsageTracker } from "./usage-tracker";

describe("usage tracker", () => {
  test("turn and session totals update live and sum ended turns", () => {
    let t = 0;
    const tr = createUsageTracker({ now: () => t });
    tr.startTurn();
    tr.addUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 });
    t = 2000;
    let s = tr.snapshot();
    expect(s.turnRunning).toBe(true);
    expect(s.turn.tokensIn).toBe(100);
    expect(s.turn.activeMs).toBe(2000);
    expect(s.session.activeMs).toBe(2000);
    tr.setTurnCost(0.5);
    tr.endTurn();
    t = 50_000; // idle gap is not counted
    tr.startTurn();
    tr.addUsage({ inputTokens: 50, outputTokens: 5, cacheWriteTokens: 7 });
    t = 51_000;
    s = tr.snapshot();
    expect(s.turn.tokensIn).toBe(50);
    expect(s.session.tokensIn).toBe(150);
    expect(s.session.cacheRead).toBe(40);
    expect(s.session.cacheWrite).toBe(7);
    expect(s.session.activeMs).toBe(3000);
    expect(s.session.costUsd).toBe(0.5);
    tr.endTurn();
    s = tr.snapshot();
    expect(s.turnRunning).toBe(false);
    expect(s.turns).toBe(2);
    expect(s.turn.activeMs).toBe(1000);
  });

  test("cost stays unknown without a priced turn", () => {
    const tr = createUsageTracker({ now: () => 0 });
    tr.startTurn();
    tr.addUsage({ inputTokens: 1 });
    tr.endTurn();
    expect(tr.snapshot().session.costUsd).toBeUndefined();
  });
});
