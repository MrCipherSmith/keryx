import { expect, test } from "bun:test";
import { RoutingBudgetLedger, effectiveRoutingCostCap } from "./routing-budget";

test("uses the strictest parent, task, and config cap", () => {
  expect(effectiveRoutingCostCap({ parentUsd: 10, taskUsd: 4, configUsd: 6 })).toBe(4);
  expect(effectiveRoutingCostCap({})).toBeNull();
});

test("classifier and execution reservations share atomic capacity", async () => {
  const ledger = new RoutingBudgetLedger({ parentUsd: 1 });
  const results = await Promise.all([
    Promise.resolve().then(() => ledger.reserve({ estimatedCostUsd: 0.6, purpose: "classifier" })),
    Promise.resolve().then(() => ledger.reserve({ estimatedCostUsd: 0.6, purpose: "execution" })),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "budget-exceeded" });
});

test("reconciliation releases unused reservation and charges actual usage", () => {
  const ledger = new RoutingBudgetLedger({ configUsd: 1 });
  const reserved = ledger.reserve({ estimatedCostUsd: 0.8, purpose: "execution" });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  ledger.reconcile(reserved.reservation.id, 0.3);
  expect(ledger.snapshot()).toEqual({ capUsd: 1, spentUsd: 0.3, reservedUsd: 0, remainingUsd: 0.7 });
  expect(ledger.reserve({ estimatedCostUsd: 0.7, purpose: "execution" }).ok).toBe(true);
});

test("unknown price is blocked when any money cap exists", () => {
  const capped = new RoutingBudgetLedger({ taskUsd: 5, unknownCost: "allow" });
  expect(capped.reserve({ estimatedCostUsd: null, purpose: "execution" })).toEqual({ ok: false, reason: "cost-unknown" });
  const unbounded = new RoutingBudgetLedger({ unknownCost: "allow" });
  expect(unbounded.reserve({ estimatedCostUsd: null, purpose: "classifier" }).ok).toBe(true);
});

test("actual overrun prevents subsequent reservations", () => {
  const ledger = new RoutingBudgetLedger({ configUsd: 1 });
  const reserved = ledger.reserve({ estimatedCostUsd: 0.5, purpose: "execution" });
  if (!reserved.ok) throw new Error("expected reservation");
  ledger.reconcile(reserved.reservation.id, 1.2);
  expect(ledger.snapshot().remainingUsd).toBe(0);
  expect(ledger.reserve({ estimatedCostUsd: 0.01, purpose: "execution" })).toEqual({ ok: false, reason: "budget-exceeded" });
});
