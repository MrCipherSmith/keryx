// Regression-lock — W15 H-01 security hardening, AC4 (flow 017, dispatch
// 017-T5, task H-01, reviewer track: security).
//
// Pins that the existing W12 child-inheritance and W13 scheduler fail-closed
// invariants ALREADY hold under a handful of adversarial red-team inputs.
// Unlike the other W15 T5 files, this suite is expected to be GREEN
// immediately — it is a regression-lock over prior (already-implemented,
// already-tested) modules, not new hardening. If any assertion here is
// unexpectedly RED, that is a signal of a real prior bug in W12/W13 — per
// dispatch instructions, STOP and report it rather than "fixing" the source
// from a T5 (test-only) dispatch.
//
// Reuses:
//   - `inheritPolicy`/`inheritBudget` from `./child/isolation` (W12 / CA-02).
//   - `planWaves` from `./parallel/scheduler` (W13 / PA-01).
// No new production code; no edits to the imported modules; fixtures mirror
// `src/harness/child/isolation.test.ts` / `src/harness/parallel/scheduler.test.ts`
// (no invented profile/task shape). Deterministic: no `Date.now`/`Math.random`/
// network/fs; `deps.idSeq` (where required) is a fixed counter.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { PolicyProfile } from "./policy/types";
import { inheritBudget, inheritPolicy, type BudgetReservation, type ParentRemainingBudget } from "./child/isolation";
import { planWaves, type ChildTask, type PlanWavesConfig } from "./parallel/scheduler";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function makeProfile(overrides: Partial<PolicyProfile> = {}): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1.0.0",
    fingerprint: sha256("monitored-trusted-local:1.0.0"),
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "ask", shell: "ask", network: "ask", delegate: "ask" },
    requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// W12 `inheritPolicy` — per-capability escalation is denied UNCONDITIONALLY,
// even under a narrower child trustMode (SC_R08_ROLE_CANNOT_ESCALATE).
// ---------------------------------------------------------------------------

describe("regression-lock — W12 inheritPolicy denies a per-capability escalation under a narrower-trust child", () => {
  test("a read-only-trust child that escalates the network capability to allow is denied, despite its narrower overall trustMode", () => {
    const parent = makeProfile({
      trustMode: "trusted-local",
      defaults: { read: "allow", write: "ask", shell: "ask", network: "deny", delegate: "ask" },
    });
    const child = makeProfile({
      profileId: "read-only-review",
      trustMode: "read-only", // narrower trust overall
      defaults: { read: "allow", write: "deny", shell: "deny", network: "allow", delegate: "deny" }, // but network escalated deny -> allow
    });
    const result = inheritPolicy(parent, child);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/network/i);
  });

  test("a child broader trustMode than the parent is denied outright", () => {
    const parent = makeProfile({ trustMode: "read-only" });
    const child = makeProfile({ trustMode: "untrusted" });
    const result = inheritPolicy(parent, child);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W12 `inheritBudget` — a child request exceeding the parent's remaining
// budget is denied, never clamped up.
// ---------------------------------------------------------------------------

describe("regression-lock — W12 inheritBudget denies a child exceeding parent remaining", () => {
  test("a child maxRuntimeMs request exceeding parent remaining is denied", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 1000, maxToolCalls: 10 };
    const childRequest: BudgetReservation = { reservationId: "child-1", maxRuntimeMs: 5000, maxToolCalls: 2 };
    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/maxRuntimeMs/);
  });

  test("a child maxToolCalls request exceeding parent remaining tool calls is denied", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 10_000, maxToolCalls: 3 };
    const childRequest: BudgetReservation = { reservationId: "child-2", maxRuntimeMs: 1000, maxToolCalls: 50 };
    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(false);
  });

  test("a child requesting a tool-call cap when the parent exposes none is denied (cannot be proven a subset)", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 10_000 };
    const childRequest: BudgetReservation = { reservationId: "child-3", maxRuntimeMs: 1000, maxToolCalls: 1 };
    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W13 `planWaves` — a dependency cycle and a degenerate maxConcurrency are
// both denied, no partial plan.
// ---------------------------------------------------------------------------

describe("regression-lock — W13 planWaves denies a dependency cycle", () => {
  test("a two-task mutual dependency cycle denies the whole plan (no partial waves)", () => {
    const tasks: ChildTask[] = [
      { taskId: "a", dependsOn: ["b"], budgetRequest: { reservationId: "r-a", maxRuntimeMs: 100 } },
      { taskId: "b", dependsOn: ["a"], budgetRequest: { reservationId: "r-b", maxRuntimeMs: 100 } },
    ];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 10_000 } };
    const result = planWaves(tasks, config);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/cycle/i);
  });

  test("a self-dependent task denies the whole plan", () => {
    const tasks: ChildTask[] = [
      { taskId: "self", dependsOn: ["self"], budgetRequest: { reservationId: "r-self", maxRuntimeMs: 100 } },
    ];
    const config: PlanWavesConfig = { maxConcurrency: 1, parentRemaining: { maxRuntimeMs: 10_000 } };
    const result = planWaves(tasks, config);
    expect(result.ok).toBe(false);
  });
});

describe("regression-lock — W13 planWaves denies a degenerate maxConcurrency", () => {
  test("maxConcurrency: 0 denies the plan (never a silent hang / zero-progress wave)", () => {
    const tasks: ChildTask[] = [
      { taskId: "a", dependsOn: [], budgetRequest: { reservationId: "r-a", maxRuntimeMs: 100 } },
    ];
    const config: PlanWavesConfig = { maxConcurrency: 0, parentRemaining: { maxRuntimeMs: 10_000 } };
    const result = planWaves(tasks, config);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/maxConcurrency/);
  });

  test("a negative maxConcurrency denies the plan", () => {
    const tasks: ChildTask[] = [
      { taskId: "a", dependsOn: [], budgetRequest: { reservationId: "r-a", maxRuntimeMs: 100 } },
    ];
    const config: PlanWavesConfig = { maxConcurrency: -1, parentRemaining: { maxRuntimeMs: 10_000 } };
    const result = planWaves(tasks, config);
    expect(result.ok).toBe(false);
  });
});
