// Tests for adaptive model escalation (flow 094, Phase 5).
import { describe, expect, test } from "bun:test";
import type { CanonicalSubagentResult } from "./contract";
import { RemainingBudgetLedger } from "./ledger";
import {
  classifyInitialTier,
  escalate,
  shouldEscalate,
  type EscalationContext,
  type EscalationDeps,
} from "./escalation";

const TIERS = ["cheap", "standard", "deep"] as const;

function result(
  status: CanonicalSubagentResult["status"],
  acceptance: CanonicalSubagentResult["acceptance"] = [],
  metrics: Record<string, unknown> = {},
): CanonicalSubagentResult {
  return {
    contract_version: "1.0.0",
    run_id: "run-1",
    dispatch_id: "d1",
    status,
    summary: "",
    acceptance,
    artifacts: [],
    changed_files: [],
    findings: [],
    questions: [],
    errors: [],
    metrics,
    timestamp_utc: "1970-01-01T00:00:00.000Z",
  };
}

function makeDeps(runRung: EscalationDeps["runRung"]): EscalationDeps {
  let n = 0;
  return { runRung, idSeq: () => `id-${n++}`, clock: () => "1970-01-01T00:00:00.000Z" };
}

function makeCtx(overrides: Partial<EscalationContext> = {}): EscalationContext {
  return {
    runId: "run-1",
    dispatchId: "d1",
    branchId: "b1",
    description: "simple refactor",
    reservationFor: (tier) => ({ reservationId: `res-${tier}`, maxRuntimeMs: 10_000, maxToolCalls: 5 }),
    ledger: new RemainingBudgetLedger({ maxRuntimeMs: 1_000_000, maxToolCalls: 1_000 }),
    ...overrides,
  };
}

describe("classifyInitialTier (AC1)", () => {
  test("high-signal terms pick the highest tier", () => {
    expect(classifyInitialTier("fix a critical security vulnerability", TIERS)).toBe("deep");
    expect(classifyInitialTier("production incident", TIERS)).toBe("deep");
  });

  test("low-signal terms pick the lowest tier", () => {
    expect(classifyInitialTier("simple rename of a variable", TIERS)).toBe("cheap");
    expect(classifyInitialTier("fix a typo", TIERS)).toBe("cheap");
  });

  test("neutral descriptions pick the middle tier", () => {
    expect(classifyInitialTier("add a new endpoint", TIERS)).toBe("standard");
  });

  test("empty ladder throws", () => {
    expect(() => classifyInitialTier("x", [])).toThrow();
  });
});

describe("shouldEscalate (AC2)", () => {
  test("adverse dispositions escalate with a trigger", () => {
    expect(shouldEscalate(result("FAILED"))).toEqual({ escalate: true, trigger: "status:FAILED" });
    expect(shouldEscalate(result("BLOCKED"))).toEqual({ escalate: true, trigger: "status:BLOCKED" });
    expect(shouldEscalate(result("NEEDS_CONTEXT"))).toEqual({ escalate: true, trigger: "status:NEEDS_CONTEXT" });
  });

  test("an unmet acceptance criterion escalates", () => {
    const r = result("DONE", [{ criterion: "AC1", status: "not_met" }]);
    expect(shouldEscalate(r)).toEqual({ escalate: true, trigger: "acceptance:not_met" });
  });

  test("metrics threshold escalates when it fires", () => {
    const r = result("DONE", [], { toolCalls: 99 });
    expect(shouldEscalate(r, { metricsThreshold: (m) => (m.toolCalls as number) > 50 })).toEqual({
      escalate: true,
      trigger: "metrics-threshold",
    });
  });

  test("DONE / DONE_WITH_CONCERNS with all acceptance met does not escalate", () => {
    expect(shouldEscalate(result("DONE", [{ criterion: "AC1", status: "met" }]))).toEqual({ escalate: false });
    expect(shouldEscalate(result("DONE_WITH_CONCERNS", [{ criterion: "AC1", status: "met" }]))).toEqual({
      escalate: false,
    });
  });
});

describe("escalate driver (AC3/AC4/AC5)", () => {
  test("cheap fails then standard succeeds: one tier_escalated event, stops on success", () => {
    const ctx = makeCtx({ description: "simple task" }); // starts at cheap
    const deps = makeDeps((tier) => (tier === "cheap" ? result("FAILED") : result("DONE")));
    const out = escalate({ tiers: TIERS }, ctx, deps);

    expect(out.stopped).toBe("success");
    expect(out.finalTier).toBe("standard");
    expect(out.attempts.map((a) => a.tier)).toEqual(["cheap", "standard"]);
    expect(out.attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toEqual({
      schemaVersion: 1,
      type: "tier_escalated",
      dispatch_id: "d1",
      run_id: "run-1",
      recorded_at: "1970-01-01T00:00:00.000Z",
      data: { from_tier: "cheap", to_tier: "standard", trigger: "status:FAILED", attempt_number: 1 },
    });
  });

  test("no escalation when the first rung succeeds", () => {
    const ctx = makeCtx({ description: "add a feature" }); // starts at standard
    const deps = makeDeps(() => result("DONE", [{ criterion: "AC1", status: "met" }]));
    const out = escalate({ tiers: TIERS }, ctx, deps);
    expect(out.stopped).toBe("success");
    expect(out.finalTier).toBe("standard");
    expect(out.attempts).toHaveLength(1);
    expect(out.events).toHaveLength(0);
  });

  test("ladder exhaustion: every rung fails, stops at the top", () => {
    const ctx = makeCtx({ description: "simple task" });
    const deps = makeDeps(() => result("FAILED"));
    const out = escalate({ tiers: TIERS }, ctx, deps);
    expect(out.stopped).toBe("ladder-exhausted");
    expect(out.finalTier).toBe("deep");
    expect(out.attempts.map((a) => a.tier)).toEqual(["cheap", "standard", "deep"]);
    expect(out.events).toHaveLength(2);
  });

  test("budget self-truncation: a denied next rung stops with no event (AC5)", () => {
    const ctx = makeCtx({
      description: "simple task", // starts at cheap
      ledger: new RemainingBudgetLedger({ maxRuntimeMs: 10_000, maxToolCalls: 5 }), // room for exactly one rung
    });
    const deps = makeDeps(() => result("FAILED"));
    const out = escalate({ tiers: TIERS }, ctx, deps);
    expect(out.stopped).toBe("budget-exhausted");
    expect(out.attempts.map((a) => a.tier)).toEqual(["cheap"]);
    expect(out.events).toHaveLength(0); // standard never ran => no escalation event
  });

  test("budget denied on the very first rung => budget-exhausted, no attempts", () => {
    const ctx = makeCtx({
      description: "simple task",
      ledger: new RemainingBudgetLedger({ maxRuntimeMs: 1, maxToolCalls: 0 }),
    });
    const deps = makeDeps(() => result("DONE"));
    const out = escalate({ tiers: TIERS }, ctx, deps);
    expect(out.stopped).toBe("budget-exhausted");
    expect(out.attempts).toHaveLength(0);
    expect(out.finalResult).toBeNull();
  });
});

describe("escalate — determinism (AC6)", () => {
  test("identical inputs with fresh ledger + deps yield deep-equal results", () => {
    const runRung: EscalationDeps["runRung"] = (tier) => (tier === "cheap" ? result("FAILED") : result("DONE"));
    const a = escalate({ tiers: TIERS }, makeCtx({ description: "simple task" }), makeDeps(runRung));
    const b = escalate({ tiers: TIERS }, makeCtx({ description: "simple task" }), makeDeps(runRung));
    expect(a).toEqual(b);
  });
});
