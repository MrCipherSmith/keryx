// Flow 115 follow-up / stress finding M1: the ledger only ever decremented.
//
// A shell session's ledger starts at 15 min / 48 tool calls and each spawn
// reserves 5 min, so the FOURTH spawn was denied — measured: `admitted=3/10`,
// with `DEFAULT_MAX_CHILDREN = 16` never reached. A child that finished in two
// seconds still held five minutes of the parent's budget forever.
//
// Releasing the unused remainder is what makes the reservation a reservation
// rather than a permanent debit. The ledger stays deterministic: it never reads
// a clock — the caller measures and passes what was actually consumed.

import { expect, test } from "bun:test";
import { RemainingBudgetLedger } from "./ledger";

function reservation(id: string, runtime: number, toolCalls: number) {
  return { reservationId: id, maxRuntimeMs: runtime, maxToolCalls: toolCalls };
}

test("a finished child returns the budget it did not use", () => {
  const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 900_000, maxToolCalls: 48 });
  const admitted = ledger.admit(reservation("r1", 300_000, 16));
  expect(admitted.ok).toBe(true);
  expect(ledger.remaining).toEqual({ maxRuntimeMs: 600_000, maxToolCalls: 32 });

  // The child ran for 2 s and made 4 tool calls.
  ledger.release("r1", { maxRuntimeMs: 2_000, maxToolCalls: 4 });
  expect(ledger.remaining).toEqual({ maxRuntimeMs: 898_000, maxToolCalls: 44 });
});

test("releasing lets a session spawn far more than three children", () => {
  // The exact shape of the shell ledger.
  const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 15 * 60_000, maxToolCalls: 48 }, { maxChildren: 16 });
  let admittedCount = 0;
  for (let i = 0; i < 10; i++) {
    const res = reservation(`r${i}`, 5 * 60_000, 6);
    const result = ledger.admit(res);
    if (!result.ok) break;
    admittedCount += 1;
    // Each child finishes quickly and gives the remainder back.
    ledger.release(`r${i}`, { maxRuntimeMs: 1_500, maxToolCalls: 2 });
  }
  expect(admittedCount).toBe(10);
});

test("release never returns more than was granted, and is idempotent", () => {
  const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 100_000, maxToolCalls: 20 });
  ledger.admit(reservation("r1", 50_000, 10));
  expect(ledger.remaining).toEqual({ maxRuntimeMs: 50_000, maxToolCalls: 10 });

  // A child claiming to have used LESS than nothing cannot inflate the budget.
  ledger.release("r1", { maxRuntimeMs: -1_000, maxToolCalls: -5 });
  expect(ledger.remaining).toEqual({ maxRuntimeMs: 100_000, maxToolCalls: 20 });

  // A second release of the same reservation is a no-op, not a second refund.
  ledger.release("r1", { maxRuntimeMs: 0, maxToolCalls: 0 });
  expect(ledger.remaining).toEqual({ maxRuntimeMs: 100_000, maxToolCalls: 20 });
});

test("a child that overruns its reservation returns nothing", () => {
  const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 100_000, maxToolCalls: 20 });
  ledger.admit(reservation("r1", 50_000, 10));
  ledger.release("r1", { maxRuntimeMs: 90_000, maxToolCalls: 30 });
  // Consumed at least the whole reservation ⇒ nothing to give back.
  expect(ledger.remaining).toEqual({ maxRuntimeMs: 50_000, maxToolCalls: 10 });
});

test("releasing an unknown reservation is a no-op", () => {
  const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 100_000, maxToolCalls: 20 });
  ledger.release("never-admitted", { maxRuntimeMs: 1, maxToolCalls: 1 });
  expect(ledger.remaining).toEqual({ maxRuntimeMs: 100_000, maxToolCalls: 20 });
});

test("the lifetime child-count cap is NOT undone by a release", () => {
  // maxChildren is a lifetime cap on how many children were ever started; a
  // finished child does not buy back the right to start another one.
  const ledger = new RemainingBudgetLedger({ maxRuntimeMs: 100_000, maxToolCalls: 20 }, { maxChildren: 1 });
  expect(ledger.admit(reservation("r1", 10_000, 2)).ok).toBe(true);
  ledger.release("r1", { maxRuntimeMs: 100, maxToolCalls: 1 });
  expect(ledger.childCount).toBe(1);
  const second = ledger.admit(reservation("r2", 10_000, 2));
  expect(second.ok).toBe(false);
});
