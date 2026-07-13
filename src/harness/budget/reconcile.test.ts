// RED tests — W15 H-01 security hardening, SC_R16_BUDGET_RESERVATION
// (flow 017, dispatch 017-T5, task H-01, reviewer track: security).
//
// Closes the AC4 deferred @release-0 concern pinned in
// `.metaproject/flows/017-2026-07-13-keryx-harness-w15-hardening/context.md`:
// no budget reconciliation exists. This suite pins the PURE, deterministic
// `reconcileBudget` surface — under `src/harness/budget/reconcile.ts` (does
// NOT exist yet) — that reconciles planned/reserved/consumed/remaining with a
// reliability tag, and fails closed on over-consumption or negative
// remaining. Reuses the W7 reliability vocabulary (`SourceReliability` from
// `src/harness/context/manifest.ts`, already `"exact" | "estimated" |
// "unknown"`) rather than inventing a new one.
//
// Expected RED: `./reconcile` does not exist, so every import below fails
// ("Cannot find module './reconcile'") until W15 T6 (impl) adds it. Until
// then this whole file fails to even load — that IS the RED signal (a
// missing-module import error, not an assertion failure).
//
// PINNED SURFACE under test (T6 impl must match exactly):
//   import type { SourceReliability } from "../context/manifest";
//   export interface ReconcileBudgetInput {
//     planned: number;
//     reserved: number;
//     consumed: number;
//     reliability: SourceReliability;
//   }
//   export type ReconcileBudgetResult =
//     | { ok: true; remaining: number; reliability: SourceReliability }
//     | { ok: false; reason: string };
//   export function reconcileBudget(input: ReconcileBudgetInput): ReconcileBudgetResult;
//
// Rules: `remaining = reserved - consumed` on the ok path; DENY (fail-closed)
// when `consumed > reserved` (would produce a negative remaining) OR when
// `reserved > planned` (a reservation cannot exceed what was planned). Pure,
// deterministic: no `Date.now`/`Math.random`/network/fs; identical input
// twice -> deep-equal output.
import { describe, expect, test } from "bun:test";
import type { SourceReliability } from "../context/manifest";
import { reconcileBudget, type ReconcileBudgetInput } from "./reconcile";

function makeInput(overrides: Partial<ReconcileBudgetInput> = {}): ReconcileBudgetInput {
  return {
    planned: 1000,
    reserved: 800,
    consumed: 500,
    reliability: "exact",
    ...overrides,
  };
}

// === Positive: planned/reserved/consumed reconcile with remaining ==========

describe("reconcileBudget — planned/reserved/consumed/remaining reconcile (SC_R16_BUDGET_RESERVATION)", () => {
  test("planned 1000 / reserved 800 / consumed 500 reconciles to remaining 300", () => {
    const result = reconcileBudget(makeInput());
    expect(result).toEqual({ ok: true, remaining: 300, reliability: "exact" });
  });

  test("reserved fully consumed reconciles to remaining 0 (boundary, still ok)", () => {
    const result = reconcileBudget(makeInput({ reserved: 800, consumed: 800 }));
    expect(result).toEqual({ ok: true, remaining: 0, reliability: "exact" });
  });

  test("reserved exactly equal to planned reconciles ok (boundary)", () => {
    const result = reconcileBudget(makeInput({ planned: 1000, reserved: 1000, consumed: 100 }));
    expect(result).toEqual({ ok: true, remaining: 900, reliability: "exact" });
  });

  for (const reliability of ["exact", "estimated", "unknown"] as const satisfies readonly SourceReliability[]) {
    test(`reliability "${reliability}" is preserved unchanged on the ok path`, () => {
      const result = reconcileBudget(makeInput({ reliability }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok:true");
      expect(result.reliability).toBe(reliability);
    });
  }
});

// === Negative: fail-closed on over-consumption / negative remaining =======

describe("reconcileBudget — fail-closed over-consumption and negative remaining (SC_R16_BUDGET_RESERVATION)", () => {
  test("consumed 900 > reserved 800 is denied (over-consumption, fail-closed)", () => {
    const result = reconcileBudget(makeInput({ reserved: 800, consumed: 900 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("consumed exceeding reserved by exactly 1 (boundary over-consumption) is denied", () => {
    const result = reconcileBudget(makeInput({ reserved: 800, consumed: 801 }));
    expect(result.ok).toBe(false);
  });

  test("reserved 1200 > planned 1000 is denied", () => {
    const result = reconcileBudget(makeInput({ planned: 1000, reserved: 1200, consumed: 500 }));
    expect(result.ok).toBe(false);
  });

  test("reserved exceeding planned by exactly 1 (boundary) is denied", () => {
    const result = reconcileBudget(makeInput({ planned: 1000, reserved: 1001, consumed: 0 }));
    expect(result.ok).toBe(false);
  });

  test("negative planned/reserved/consumed inputs are denied, never silently reconciled", () => {
    const result = reconcileBudget(makeInput({ planned: -1, reserved: 0, consumed: 0 }));
    expect(result.ok).toBe(false);
  });
});

// === Determinism ============================================================

describe("reconcileBudget — deterministic, pure (no clock/random/network/fs)", () => {
  test("the same input reconciled twice yields a deep-equal result", () => {
    const input = makeInput();
    const first = reconcileBudget(input);
    const second = reconcileBudget(input);
    expect(first).toEqual(second);
  });

  test("reconcileBudget does not mutate its input", () => {
    const input = makeInput();
    const snapshot = { ...input };
    reconcileBudget(input);
    expect(input).toEqual(snapshot);
  });
});
