// RED tests for R2-3 bound-wave scheduling (flow 025, W13+/W12+/W15+ / T5).
//
// `planExtensionWave` (T6's job, `src/harness/extension/bound-wave.ts`, does
// NOT exist yet) composes ONLY already-GREEN modules:
//   - W13 `planWaves` (`../parallel/scheduler`) — bounded ready-set waves,
//     aggregate budget folding, cancellation, and cycle detection.
//   - W15 `registerExtension`/`CapabilityGrant` (`./registry`) — an
//     unregistered/ungranted extension fails closed at discovery.
//   - R2-1 `dispatchExtension` (`./execute`) — a canonical, grant-bounded
//     child dispatch; fails closed on `registration.ok === false`.
//   - W12 `inheritBudget`/`BudgetReservation`/`ParentRemainingBudget`
//     (`../child/isolation`) — the budget vocabulary `planWaves` folds.
//   - `EvidenceRecord` (`../evidence/types`) — the per-attempt evidence shape.
//
// The missing-module import below is the expected RED failure ("Cannot find
// module './bound-wave'") — NOT a bug in this test file. Do NOT create
// bound-wave.ts here (T6's job).
//
// ---------------------------------------------------------------------------
// PINNED API (T6 impl must match exactly):
//
//   export interface ExtensionWaveTask {
//     taskId: string;
//     dependsOn: string[];
//     registration: RegisterExtensionResult;   // W15 registerExtension() result
//     capabilityGrant: CapabilityGrant;         // bounds dispatch.allowed_actions
//     budgetRequest: BudgetReservation;         // folded by planWaves/inheritBudget
//     cancelled?: boolean;                      // optional, mirrors ChildTask
//     sessionId: string;
//     attempt: { attemptId: string; number: number };
//     branchId: string;
//     contextManifestHash: string;              // sha256
//     policyFingerprint: string;                // sha256
//     task: { title: string; description: string };
//     acceptanceCriteria: string[];              // non-empty
//     dispatchArtifact: DispatchArtifactRef;
//     resultArtifact: DispatchArtifactRef;
//   }
//   export interface PlanExtensionWaveInput {
//     tasks: ExtensionWaveTask[];
//     config: PlanWavesConfig;                   // { maxConcurrency; parentRemaining }
//     parentRunId: string;
//     canonicalContractVersion: string;
//   }
//   export interface PlanExtensionWaveDeps {
//     idSeq: () => string;
//     clock: () => string;
//     checkApproval?: typeof checkApproval;       // unused by these scenarios
//   }
//   export interface BoundWave {
//     taskIds: string[];
//     dispatches: CanonicalDispatch[];            // 1:1 with taskIds, per ./execute
//     attemptEvidence: EvidenceRecord[];           // 1:1 with taskIds, per ../evidence/types
//   }
//   export type PlanExtensionWaveResult =
//     | { ok: true; waves: BoundWave[] }
//     | { ok: false; reason: string };
//   export function planExtensionWave(
//     input: PlanExtensionWaveInput,
//     deps: PlanExtensionWaveDeps,
//   ): PlanExtensionWaveResult;
//
// Fail-closed rules pinned by these tests:
//   - Any task whose `registration.ok === false` denies the WHOLE plan (no
//     wave ever binds that extension) — mirrors `dispatchExtension`'s own
//     fail-closed check, applied BEFORE scheduling.
//   - The aggregate budget ceiling and cycle/degenerate-concurrency denials
//     are propagated verbatim from the REUSED `planWaves` (never
//     reimplemented) — reasons still match /budget|exceed/i and /cycle/i.
//   - `maxConcurrency` still bounds every wave (no wave's `taskIds.length` may
//     exceed it).
//   - Every SCHEDULED task carries a `dispatchExtension`-built dispatch
//     bounded to its own `capabilityGrant.capabilities`.
//   - Every SCHEDULED task carries its OWN, distinct `EvidenceRecord` in
//     `attemptEvidence` — a later planning call never mutates a prior
//     attempt's evidence object.
//
// Deterministic + OFFLINE: all ids/hashes/timestamps are fixture constants or
// injected via `deps` (no `Date.now()`, `Math.random()`, network, or fs).
import { describe, expect, test } from "bun:test";
import type { BudgetReservation, ParentRemainingBudget } from "../child/isolation";
import type { EvidenceRecord } from "../evidence/types";
import type { PlanWavesConfig } from "../parallel/scheduler";

// PINNED API under test — T6 impl exports these; imports fail until then
// (expected RED: "Cannot find module './bound-wave'").
import { planExtensionWave } from "./bound-wave";
import type {
  BoundWave,
  ExtensionWaveTask,
  PlanExtensionWaveDeps,
  PlanExtensionWaveInput,
  PlanExtensionWaveResult,
} from "./bound-wave";
import type { CanonicalDispatch, DispatchArtifactRef } from "./execute";
import { registerExtension } from "./registry";
import type { CapabilityGrant, RegisterExtensionResult } from "./registry";

// ---------------------------------------------------------------------------
// Deterministic fixtures (mirrors scheduler.test.ts / execute.test.ts style).
// ---------------------------------------------------------------------------

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

/** Fresh, deterministic idSeq/clock per call — mirrors execute.test.ts's makeDispatchDeps(). */
function makeWaveDeps(): PlanExtensionWaveDeps {
  let idCounter = 0;
  return {
    idSeq: () => `wave-${idCounter++}`,
    clock: () => "2026-07-13T00:00:00.000Z",
  };
}

function makeCapabilityGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return { grantId: "grant-025-1", capabilities: ["read"], ...overrides };
}

function makeRegisteredRegistration(
  extensionId: string,
  capabilityGrant: CapabilityGrant,
): RegisterExtensionResult {
  return registerExtension({
    extensionId,
    manifest: { manifestHash: HASH_A, extensionVersion: "1.0.0" },
    capabilityGrant,
  });
}

function makeUnregisteredRegistration(extensionId: string): RegisterExtensionResult {
  // No manifest, no capabilityGrant -> registerExtension denies (ok:false).
  return registerExtension({ extensionId });
}

function makeArtifactRef(id: string, kind: string, hash: string): DispatchArtifactRef {
  return { artifactId: id, kind, path: `artifacts/${id}.json`, hash };
}

/** A well-formed ExtensionWaveTask; every field overridable for scenario setup. */
function makeTask(overrides: Partial<ExtensionWaveTask> & { taskId: string }): ExtensionWaveTask {
  const taskId = overrides.taskId;
  const capabilityGrant = overrides.capabilityGrant ?? makeCapabilityGrant();
  const registration =
    overrides.registration ?? makeRegisteredRegistration(`ext-${taskId}`, capabilityGrant);
  const base: ExtensionWaveTask = {
    taskId,
    dependsOn: [],
    registration,
    capabilityGrant,
    budgetRequest: { reservationId: `res-${taskId}`, maxRuntimeMs: 10_000 },
    sessionId: "session-025-1",
    attempt: { attemptId: `attempt-${taskId}`, number: 1 },
    branchId: `branch-${taskId}`,
    contextManifestHash: HASH_B,
    policyFingerprint: HASH_C,
    task: { title: `Run ${taskId}`, description: `Bounded extension dispatch for ${taskId}.` },
    acceptanceCriteria: [`${taskId} completes within its granted capabilities`],
    dispatchArtifact: makeArtifactRef(`${taskId}-dispatch`, "child-dispatch", HASH_D),
    resultArtifact: makeArtifactRef(`${taskId}-result`, "final-report", HASH_A),
  };
  return { ...base, ...overrides };
}

function makeInput(
  tasks: ExtensionWaveTask[],
  config: PlanWavesConfig,
  overrides: Partial<PlanExtensionWaveInput> = {},
): PlanExtensionWaveInput {
  return {
    tasks,
    config,
    parentRunId: "run-025-parent",
    canonicalContractVersion: "1.0.0",
    ...overrides,
  };
}

function expectOk(
  result: PlanExtensionWaveResult,
): asserts result is { ok: true; waves: BoundWave[] } {
  if (!result.ok) throw new Error(`expected ok:true, got ok:false (reason: ${result.reason})`);
}

function expectDenied(
  result: PlanExtensionWaveResult,
): asserts result is { ok: false; reason: string } {
  if (result.ok) throw new Error("expected ok:false, got ok:true");
}

function flattenTaskIds(waves: readonly BoundWave[]): string[] {
  return waves.flatMap((wave) => wave.taskIds);
}

// ============================================================================
// (a) Concurrency ceiling
// ============================================================================

describe("planExtensionWave: concurrency ceiling bounds every wave", () => {
  test("3 independent REGISTERED tasks with maxConcurrency:2 -> no wave exceeds 2, all 3 scheduled", () => {
    const tasks = [makeTask({ taskId: "t-1" }), makeTask({ taskId: "t-2" }), makeTask({ taskId: "t-3" })];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectOk(result);
    for (const wave of result.waves) {
      expect(wave.taskIds.length).toBeLessThanOrEqual(2);
    }
    expect(flattenTaskIds(result.waves).sort()).toEqual(["t-1", "t-2", "t-3"]);
  });
});

// ============================================================================
// (b) Aggregate budget ok
// ============================================================================

describe("planExtensionWave: aggregate budget within parentRemaining is granted", () => {
  test("Σ budgetRequests <= parentRemaining -> ok:true, Σ granted reservations <= parentRemaining", () => {
    const tasks = [
      makeTask({ taskId: "p-1", budgetRequest: { reservationId: "res-p-1", maxRuntimeMs: 50_000 } }),
      makeTask({ taskId: "p-2", budgetRequest: { reservationId: "res-p-2", maxRuntimeMs: 50_000 } }),
    ];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectOk(result);
    expect(flattenTaskIds(result.waves).sort()).toEqual(["p-1", "p-2"]);
  });
});

// ============================================================================
// (c) Aggregate budget breach
// ============================================================================

describe("planExtensionWave: aggregate budget breach denies the whole plan (propagated from planWaves)", () => {
  test("Σ budgetRequests exceeds parentRemaining -> ok:false, reason mentions budget", () => {
    const tasks = [
      makeTask({ taskId: "b-1", budgetRequest: { reservationId: "res-b-1", maxRuntimeMs: 40_000 } }),
      makeTask({ taskId: "b-2", budgetRequest: { reservationId: "res-b-2", maxRuntimeMs: 40_000 } }),
      makeTask({ taskId: "b-3", budgetRequest: { reservationId: "res-b-3", maxRuntimeMs: 40_000 } }),
    ];
    const config: PlanWavesConfig = { maxConcurrency: 3, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectDenied(result);
    expect(result.reason).toMatch(/budget|exceed/i);
    expect("waves" in result).toBe(false);
  });
});

// ============================================================================
// (d) Registered-only fail-closed
// ============================================================================

describe("planExtensionWave: an unregistered extension fails the WHOLE plan closed", () => {
  test("one task with registration.ok===false -> ok:false, reason mentions registration; no wave binds it", () => {
    const badRegistration = makeUnregisteredRegistration("ext-unregistered");
    expect(badRegistration.ok).toBe(false);

    const tasks = [
      makeTask({ taskId: "good-1" }),
      makeTask({ taskId: "bad-1", registration: badRegistration }),
    ];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectDenied(result);
    expect(result.reason).toMatch(/regist/i);
    expect("waves" in result).toBe(false);
  });
});

// ============================================================================
// (e) Per-task extension dispatch
// ============================================================================

describe("planExtensionWave: every scheduled task carries a grant-bounded dispatch", () => {
  test("each task's dispatch.allowed_actions equals exactly its own capabilityGrant.capabilities", () => {
    const grantA = makeCapabilityGrant({ grantId: "grant-a", capabilities: ["read"] });
    const grantB = makeCapabilityGrant({ grantId: "grant-b", capabilities: ["read", "write"] });
    const tasks = [
      makeTask({ taskId: "d-1", capabilityGrant: grantA }),
      makeTask({ taskId: "d-2", capabilityGrant: grantB }),
    ];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectOk(result);
    const allDispatches: CanonicalDispatch[] = result.waves.flatMap((wave) => wave.dispatches);
    expect(allDispatches).toHaveLength(2);

    const byTaskCapabilities = new Map<string, string[]>([
      ["d-1", grantA.capabilities],
      ["d-2", grantB.capabilities],
    ]);
    for (const wave of result.waves) {
      expect(wave.dispatches).toHaveLength(wave.taskIds.length);
      wave.taskIds.forEach((taskId, index) => {
        const dispatch = wave.dispatches[index];
        if (!dispatch) throw new Error(`expected a dispatch at index ${index} for ${taskId}`);
        const expectedCapabilities = byTaskCapabilities.get(taskId);
        if (expectedCapabilities === undefined) throw new Error(`no fixture capabilities for ${taskId}`);
        expect(dispatch.allowed_actions).toEqual(expectedCapabilities);
      });
    }
  });
});

// ============================================================================
// (f) Per-attempt evidence isolation + immutability
// ============================================================================

describe("planExtensionWave: each attempt has its own distinct, immutable EvidenceRecord", () => {
  test("attemptEvidence has one distinct EvidenceRecord per scheduled task, correlated by attemptId", () => {
    const tasks = [makeTask({ taskId: "e-1" }), makeTask({ taskId: "e-2" })];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectOk(result);
    const allEvidence: EvidenceRecord[] = result.waves.flatMap((wave) => wave.attemptEvidence);
    expect(allEvidence).toHaveLength(2);

    // Distinct per task: unique evidenceId per attempt.
    const evidenceIds = new Set(allEvidence.map((record) => record.evidenceId));
    expect(evidenceIds.size).toBe(allEvidence.length);

    // Each attempt's evidence is correlated back to that task's own attemptId.
    for (const wave of result.waves) {
      wave.taskIds.forEach((taskId, index) => {
        const record = wave.attemptEvidence[index];
        if (!record) throw new Error(`expected evidence at index ${index} for ${taskId}`);
        const task = tasks.find((t) => t.taskId === taskId);
        if (!task) throw new Error(`fixture missing for ${taskId}`);
        expect(record.causal.attemptId).toBe(task.attempt.attemptId);
        expect(record.schemaVersion).toBe(1);
      });
    }
  });

  test("a second planning call never mutates a prior attempt's evidence record (deep-equal before/after)", () => {
    const tasks = [makeTask({ taskId: "e-1" }), makeTask({ taskId: "e-2" })];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };
    const input = makeInput(tasks, config);

    const first = planExtensionWave(input, makeWaveDeps());
    expectOk(first);
    const firstEvidenceSnapshot = JSON.parse(JSON.stringify(first.waves.flatMap((w) => w.attemptEvidence)));

    // A second, independent planning call (e.g. a re-plan) with fresh deps.
    const second = planExtensionWave(input, makeWaveDeps());
    expectOk(second);

    // The FIRST result's evidence objects must still deep-equal their
    // pre-second-call snapshot — the second call must not have reached back
    // and mutated the first attempt's evidence.
    const firstEvidenceAfter = first.waves.flatMap((w) => w.attemptEvidence);
    expect(JSON.parse(JSON.stringify(firstEvidenceAfter))).toEqual(firstEvidenceSnapshot);
  });
});

// ============================================================================
// (f2) Planning disposition must not fabricate a completed status
// (review-polish item E, flow 028/T5)
// ============================================================================
//
// RED today: `buildAttemptResult` hardcodes `status: "DONE"` for every planned
// attempt, so `attemptEvidence[i].artifact.kind` is unconditionally
// `"child-result:DONE"` — even though `planExtensionWave` only SCHEDULES the
// attempt; the parent owns status/completion (D-02), and a child/plan-time
// attempt has not actually run yet. `"DONE"` is a canonical, TERMINAL
// disposition (`CanonicalSubagentStatus` in `../child/contract.ts`) and must
// not be fabricated at planning time.
//
// NOTE for T6: `CanonicalSubagentStatus` is a FROZEN enum with exactly
// `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED | FAILED` — every value
// is itself a terminal disposition; there is no neutral
// "scheduled"/"pending"/"planned" value in it. Do NOT extend that frozen enum
// to manufacture one. If no existing value is an honest fit, T6 must STOP and
// report rather than force-fit or widen the enum (e.g. reconsider whether
// `planExtensionWave` should be building a canonical disposition via
// `childResultToEvidence` at plan time at all).
describe("E — planExtensionWave's per-attempt disposition is not a fabricated completion status", () => {
  test("each planned attempt's attemptEvidence[i].artifact.kind is NOT 'child-result:DONE' (planning must not fabricate a completed disposition)", () => {
    const tasks = [makeTask({ taskId: "e-status-1" }), makeTask({ taskId: "e-status-2" })];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectOk(result);
    const allEvidence = result.waves.flatMap((wave) => wave.attemptEvidence);
    expect(allEvidence.length).toBeGreaterThan(0);
    for (const record of allEvidence) {
      expect(record.artifact.kind).not.toBe("child-result:DONE");
    }
  });
});

// ============================================================================
// (g) Cycle / degenerate concurrency (propagated from planWaves)
// ============================================================================

describe("planExtensionWave: dependency cycles and degenerate concurrency deny the plan (propagated from planWaves)", () => {
  test("a 2-node dependency cycle denies the plan, reason mentions cycle", () => {
    const tasks = [
      makeTask({ taskId: "c-x", dependsOn: ["c-y"] }),
      makeTask({ taskId: "c-y", dependsOn: ["c-x"] }),
    ];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectDenied(result);
    expect(result.reason).toMatch(/cycle/i);
  });

  test("maxConcurrency < 1 denies the plan, reason mentions maxConcurrency", () => {
    const tasks = [makeTask({ taskId: "solo" })];
    const config: PlanWavesConfig = { maxConcurrency: 0, parentRemaining: { maxRuntimeMs: 100_000 } };

    const result = planExtensionWave(makeInput(tasks, config), makeWaveDeps());

    expectDenied(result);
    expect(result.reason).toMatch(/maxConcurrency/i);
  });
});

// ============================================================================
// (h) Determinism
// ============================================================================

describe("planExtensionWave: deterministic (same input + same deps shape twice -> deep-equal result)", () => {
  test("identical input with fresh, identically-sequenced deps twice yields a deep-equal result", () => {
    const tasks = [makeTask({ taskId: "det-1" }), makeTask({ taskId: "det-2" }), makeTask({ taskId: "det-3" })];
    const config: PlanWavesConfig = { maxConcurrency: 2, parentRemaining: { maxRuntimeMs: 100_000 } };
    const input = makeInput(tasks, config);

    const first = planExtensionWave(input, makeWaveDeps());
    const second = planExtensionWave(input, makeWaveDeps());

    expect(first).toEqual(second);
  });

  test("identical input on a denial fixture (registered-only fail-closed) twice yields a deep-equal denial", () => {
    const badRegistration = makeUnregisteredRegistration("ext-unregistered-det");
    const tasks = [makeTask({ taskId: "det-bad", registration: badRegistration })];
    const config: PlanWavesConfig = { maxConcurrency: 1, parentRemaining: { maxRuntimeMs: 100_000 } };
    const input = makeInput(tasks, config);

    const first = planExtensionWave(input, makeWaveDeps());
    const second = planExtensionWave(input, makeWaveDeps());

    expect(first).toEqual(second);
  });
});

// Reference the imported type-only symbols so `ParentRemainingBudget` /
// `BudgetReservation` stay pinned as part of this suite's documented contract
// even though fixtures above construct their literal shapes inline.
type _PinnedBudgetShapesReferenced = { budget: BudgetReservation; remaining: ParentRemainingBudget };
