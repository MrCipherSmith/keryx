// Tests for the run-scoped budget/count ledger (flow 090, Phase 3 / AC1, AC2).
import { describe, expect, test } from "bun:test";
import type { BudgetReservation, ParentRemainingBudget } from "./isolation";
import { RemainingBudgetLedger } from "./ledger";

function res(id: string, runtime: number, toolCalls?: number): BudgetReservation {
  return toolCalls !== undefined
    ? { reservationId: id, maxRuntimeMs: runtime, maxToolCalls: toolCalls }
    : { reservationId: id, maxRuntimeMs: runtime };
}

describe("RemainingBudgetLedger — aggregate never over-grants (AC1)", () => {
  test("cumulative admitted runtime + tool-calls never exceed the initial budget", () => {
    // Deterministic 'property' sweep: many initial budgets x many reservation
    // sizes, no RNG. The invariant is checked after every admit.
    for (let initRuntime = 1_000; initRuntime <= 100_000; initRuntime += 7_000) {
      for (let initTools = 1; initTools <= 40; initTools += 3) {
        const initial: ParentRemainingBudget = { maxRuntimeMs: initRuntime, maxToolCalls: initTools };
        const ledger = new RemainingBudgetLedger(initial);
        let sumRuntime = 0;
        let sumTools = 0;
        for (let i = 0; i < 60; i++) {
          const r = res(`r${i}`, 1_000 + ((i * 1_300) % 9_000), 1 + (i % 5));
          const admitted = ledger.admit(r);
          if (admitted.ok) {
            sumRuntime += admitted.reservation.maxRuntimeMs;
            sumTools += admitted.reservation.maxToolCalls ?? 0;
          }
          // Invariant holds unconditionally after every admit (granted or denied).
          expect(sumRuntime).toBeLessThanOrEqual(initRuntime);
          expect(sumTools).toBeLessThanOrEqual(initTools);
        }
      }
    }
  });

  test("a denied admit leaves ledger state unchanged (no partial decrement / count bump)", () => {
    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 5_000, maxToolCalls: 3 });
    const first = ledger.admit(res("a", 4_000, 2));
    expect(first.ok).toBe(true);
    const remainingBefore = ledger.remaining;
    const countBefore = ledger.childCount;

    const over = ledger.admit(res("b", 999_999, 999));
    expect(over.ok).toBe(false);
    expect(ledger.remaining).toEqual(remainingBefore);
    expect(ledger.childCount).toBe(countBefore);
  });

  test("decrements across BOTH admitWaves and ad-hoc admit (single authority)", () => {
    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 10_000, maxToolCalls: 10 });
    const wavesOk = ledger.admitWaves([
      { reservations: [res("w1", 3_000, 2), res("w2", 3_000, 2)] },
    ]);
    expect(wavesOk.ok).toBe(true);
    expect(ledger.childCount).toBe(2);
    expect(ledger.remaining).toEqual({ maxRuntimeMs: 4_000, maxToolCalls: 6 });

    const adhoc = ledger.admit(res("a1", 4_000, 6));
    expect(adhoc.ok).toBe(true);
    expect(ledger.remaining).toEqual({ maxRuntimeMs: 0, maxToolCalls: 0 });

    // Nothing more fits — fail closed.
    expect(ledger.admit(res("a2", 1, 1)).ok).toBe(false);
  });
});

describe("RemainingBudgetLedger — child count cap (AC2)", () => {
  test("admits up to maxChildren then denies with a distinct reason", () => {
    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 1_000_000 }, { maxChildren: 2 });
    expect(ledger.admit(res("a", 1_000)).ok).toBe(true);
    expect(ledger.admit(res("b", 1_000)).ok).toBe(true);
    const third = ledger.admit(res("c", 1_000));
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain("child count cap 2 reached");
  });
});

// --- flow 101: optional cost dimension --------------------------------------

function costRes(id: string, runtime: number, cost: number): BudgetReservation {
  return { reservationId: id, maxRuntimeMs: runtime, costUnits: cost };
}

describe("RemainingBudgetLedger — cost dimension (flow 101)", () => {
  test("with maxCostUnits, admits within cost then denies over it (AC2)", () => {
    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 1_000_000 }, { maxCostUnits: 100 });
    expect(ledger.admit(costRes("a", 1_000, 60)).ok).toBe(true);
    expect(ledger.costRemaining).toBe(40);
    const over = ledger.admit(costRes("b", 1_000, 50));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain("cost cap exceeded");
    // denied admit leaves cost + count unchanged (AC3)
    expect(ledger.costRemaining).toBe(40);
    expect(ledger.childCount).toBe(1);
  });

  test("a reservation without costUnits consumes 0 cost", () => {
    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 1_000_000 }, { maxCostUnits: 10 });
    expect(ledger.admit(res("a", 1_000)).ok).toBe(true);
    expect(ledger.costRemaining).toBe(10);
  });

  test("no maxCostUnits => cost not tracked, behavior unchanged (AC4)", () => {
    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 5_000, maxToolCalls: 3 });
    expect(ledger.costRemaining).toBeUndefined();
    // costUnits on the reservation is ignored when no ceiling is set
    expect(ledger.admit(costRes("a", 1_000, 9_999)).ok).toBe(true);
    expect(ledger.costRemaining).toBeUndefined();
  });

  test("aggregate admitted cost never exceeds maxCostUnits (AC5 property)", () => {
    for (let cap = 10; cap <= 500; cap += 37) {
      const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 10_000_000 }, { maxCostUnits: cap });
      let sum = 0;
      for (let i = 0; i < 80; i++) {
        const cost = 1 + ((i * 13) % 40);
        const r = ledger.admit(costRes(`r${i}`, 1_000, cost));
        if (r.ok) sum += cost;
        expect(sum).toBeLessThanOrEqual(cap);
      }
    }
  });

  test("cost denial leaves budget/count unchanged (all checks before mutation, AC3)", () => {
    const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 100_000, maxToolCalls: 10 }, { maxCostUnits: 5 });
    const before = ledger.remaining;
    const denied = ledger.admit(costRes("big", 1_000, 9_999));
    expect(denied.ok).toBe(false);
    expect(ledger.remaining).toEqual(before);
    expect(ledger.childCount).toBe(0);
    expect(ledger.costRemaining).toBe(5);
  });
});

// --- flow 171 (Phase D / PRD R8, AC10): concurrency-safety investigation ---
//
// Phase D's `executeWaves` (`../parallel/scheduler.ts`) introduces the
// harness's FIRST real concurrent execution path — wave siblings dispatched
// via `Promise.allSettled`. This ledger, and everything it composes
// (`inheritBudget` in `./isolation`, `spawnSubagent` in `./orchestrate`), was
// written and exercised only under sequential spawning.
//
// Direct code reading (not assumption) of the full grant path found NO
// `await` anywhere between a budget check and its corresponding decrement:
//   - `RemainingBudgetLedger.admit()` (./ledger.ts) is a single synchronous
//     function body: `maxChildren` check -> `inheritBudget()` subset check ->
//     cost-ceiling check -> mutate `this.remainingBudget`/`this.admittedChildren`
//     — no `await` anywhere in that sequence.
//   - `inheritBudget()` (./isolation.ts) is itself fully synchronous (pure
//     comparisons, no I/O, no Promise).
//   - `spawnSubagent()` (./orchestrate.ts), the facade Phase D's concurrent
//     `run()` callers would actually invoke, calls `spawnChild()` then
//     `ctx.ledger.admit()` with no `await` between them either — the whole
//     function is synchronous.
//
// Because JavaScript's event loop runs a synchronous function body to
// completion before any other microtask/macrotask gets a turn, concurrent
// CALLERS (e.g. many wave-sibling tasks each invoking `ledger.admit(...)`
// after their own independent async work) cannot interleave BETWEEN one
// call's check and its own decrement — there is no `await` inside `admit()`
// to yield at. The ledger is therefore ALREADY safe for concurrent use, by
// virtue of being synchronous — not because it was designed with concurrency
// in mind. No production code change was needed; this section only adds a
// regression test proving the property empirically under a genuinely
// concurrent-looking calling pattern, so a future change that accidentally
// introduces an `await` inside `admit()` (or anything it calls) would be
// caught here.
describe("RemainingBudgetLedger — concurrency-safety under concurrent-looking callers (flow 171, Phase D / AC10, PRD R8)", () => {
  test("many callers racing to admit() after an unpredictable number of event-loop yields never cause the ledger to over-grant", async () => {
    const initial: ParentRemainingBudget = { maxRuntimeMs: 100_000, maxToolCalls: 50 };
    const ledger = new RemainingBudgetLedger(initial);

    // 30 callers each request 4_000ms/2 tool-calls. Aggregate demand
    // (120_000ms / 60 tool-calls) deliberately EXCEEDS the budget
    // (100_000ms / 50 tool-calls), so some callers MUST be denied — the
    // property under test is that whichever ones ARE granted never sum past
    // the original budget, even when every caller "arrives" at its own
    // `admit()` call through a different, unpredictable number of
    // microtask/macrotask hops first (simulating wave siblings that each do
    // different amounts of async work before reaching their own budget
    // grant).
    const callers = Array.from({ length: 30 }, (_, i) => async () => {
      for (let hop = 0; hop < i % 5; hop++) {
        await Promise.resolve();
      }
      if (i % 3 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return ledger.admit(res(`c${i}`, 4_000, 2));
    });

    const results = await Promise.all(callers.map((run) => run()));

    let sumRuntime = 0;
    let sumTools = 0;
    let admittedCount = 0;
    for (const r of results) {
      if (r.ok) {
        admittedCount += 1;
        sumRuntime += r.reservation.maxRuntimeMs;
        sumTools += r.reservation.maxToolCalls ?? 0;
      }
    }

    // The core invariant: cumulative granted budget never exceeds what the
    // parent started with, even under concurrent-looking arrival order.
    expect(sumRuntime).toBeLessThanOrEqual(initial.maxRuntimeMs);
    expect(sumTools).toBeLessThanOrEqual(initial.maxToolCalls ?? Number.POSITIVE_INFINITY);

    // Non-vacuous: some callers were admitted (proves this isn't an
    // all-denied no-op) and some were denied (proves the aggregate cap
    // actually bound something real under this concurrent access pattern).
    expect(admittedCount).toBeGreaterThan(0);
    expect(admittedCount).toBeLessThan(30);

    // The ledger's own bookkeeping matches the sum of what it actually
    // granted — no drift from a missed/duplicated decrement.
    expect(ledger.remaining).toEqual({
      maxRuntimeMs: initial.maxRuntimeMs - sumRuntime,
      maxToolCalls: (initial.maxToolCalls ?? 0) - sumTools,
    });
    expect(ledger.childCount).toBe(admittedCount);
  });
});
