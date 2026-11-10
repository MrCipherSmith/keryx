import { describe, expect, test } from "bun:test";
import { createTurnUsage, installTurnUsageSink } from "./turn-usage";
import { usageFooterSegments } from "./usage-format";
import { createUsageTracker, type UsageReport } from "./usage-tracker";

// Regression for the double count: the shell wrapped `io.onUsage` on every turn and never restored it,
// so turn N's usage reached `usageTracker.addUsage` N times. These drive several turns through ONE io.

const PRICE_PER_TOKEN = 1 / 1_000_000; // $1 per million input tokens

function harness() {
  const io: { onUsage?: (usage: UsageReport) => void } = {};
  const baseCalls: UsageReport[] = [];
  io.onUsage = (usage) => {
    baseCalls.push(usage);
  };
  const slot = installTurnUsageSink(io);
  let clock = 0;
  const tracker = createUsageTracker({ now: () => clock });
  const footer: { tokensIn?: number; costUsd?: number | undefined } = {};

  const runTurn = (reports: UsageReport[]) => {
    tracker.startTurn();
    const turn = createTurnUsage({
      tracker: () => tracker,
      cost: (t) => t.input * PRICE_PER_TOKEN,
      onUpdate: (t, costUsd) => {
        footer.tokensIn = t.input;
        footer.costUsd = costUsd;
      },
    });
    const sink = (usage: UsageReport) => turn.onUsage(usage);
    slot.set(sink);
    for (const report of reports) io.onUsage?.(report);
    slot.clear(sink);
    clock += 1_000;
    tracker.endTurn();
    return turn;
  };
  return { io, baseCalls, tracker, footer, runTurn };
}

describe("turn usage through one shared io (flow 483)", () => {
  test("session totals and cost grow by exactly one turn per turn", () => {
    const h = harness();
    const tokens: number[] = [];
    const costs: Array<number | undefined> = [];
    for (let turn = 1; turn <= 4; turn++) {
      h.runTurn([{ inputTokens: 1000, outputTokens: 10 }]);
      const snap = h.tracker.snapshot();
      tokens.push(snap.session.tokensIn);
      costs.push(snap.session.costUsd);
      expect(snap.turn.tokensIn).toBe(1000);
      expect(snap.turn.costUsd).toBeCloseTo(1000 * PRICE_PER_TOKEN, 9);
    }
    expect(tokens).toEqual([1000, 2000, 3000, 4000]);
    costs.forEach((cost, i) => expect(cost).toBeCloseTo((i + 1) * 0.001, 9));
    expect(h.tracker.snapshot().session.tokensOut).toBe(40);
  });

  test("several reports in one turn sum once and the footer figures stay per-turn", () => {
    const h = harness();
    h.runTurn([{ inputTokens: 500 }]);
    const turn = h.runTurn([{ inputTokens: 300 }, { inputTokens: 200, cacheReadTokens: 100 }]);
    expect(turn.totals).toEqual({ input: 500, output: 0, cacheRead: 100, cacheWrite: 0 });
    expect(h.footer.tokensIn).toBe(500);
    expect(h.tracker.snapshot().session.tokensIn).toBe(1000);
  });

  test("the base hook runs once per event, however many turns came before", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.runTurn([{ inputTokens: 1 }]);
    expect(h.baseCalls).toHaveLength(5);
  });

  test("a usage event outside a turn reaches the base hook but not the tracker", () => {
    const h = harness();
    h.runTurn([{ inputTokens: 10 }]);
    h.io.onUsage?.({ inputTokens: 99 });
    expect(h.baseCalls).toHaveLength(2);
    expect(h.tracker.snapshot().session.tokensIn).toBe(10);
  });

  test("a finished turn cannot unseat the next turn's sink", () => {
    const io: { onUsage?: (usage: UsageReport) => void } = {};
    const slot = installTurnUsageSink(io);
    const got: string[] = [];
    const first = () => {
      got.push("first");
    };
    const second = () => {
      got.push("second");
    };
    slot.set(first);
    slot.set(second);
    slot.clear(first); // the old turn settles late
    io.onUsage?.({ inputTokens: 1 });
    expect(got).toEqual(["second"]);
  });

  test("the footer segments of a multi-turn session read the true totals", () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.runTurn([{ inputTokens: 1000 }]);
    const text = (usageFooterSegments(h.tracker.snapshot()) ?? []).map((s) => s.text).join("");
    expect(text).toContain("session \u21913.0k");
    expect(text).toContain("$0.0030");
  });
});
