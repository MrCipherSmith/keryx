// Bound parallel wave scheduling for registered extensions (flow 025, R2-3 /
// T6). Composes ONLY already-GREEN modules — no rewrite of prior behavior:
//   - W13 `planWaves` (`../parallel/scheduler`) — bounded ready-set waves,
//     aggregate budget folding, cancellation, cycle + degenerate-concurrency
//     denial. Reused verbatim for ALL scheduling/budget/cycle reasoning.
//   - W15 `registerExtension`/`CapabilityGrant` (`./registry`) — an
//     unregistered/ungranted extension fails closed at discovery.
//   - R2-1 `dispatchExtension` (`./execute`) — a canonical, grant-bounded child
//     dispatch; fails closed on `registration.ok === false`.
//   - W12 `BudgetReservation`/`ParentRemainingBudget` (`../child/isolation`) —
//     the budget vocabulary `planWaves` folds.
//   - W7 `EvidenceRecord` (`../evidence/types`) — the per-attempt, isolated
//     evidence shape. NOTE: planning-time evidence is built LOCALLY (see
//     `buildPlannedAttemptEvidence`) rather than via W12 `childResultToEvidence`,
//     because a planned (not-yet-run) attempt has no canonical, TERMINAL
//     `CanonicalSubagentStatus` disposition to stamp — see review-polish item E.
//
// Fail-closed and deterministic: the ONLY non-determinism is the injected
// `deps.idSeq`/`deps.clock` (no `Date.now`/`Math.random`/network/fs/real
// async). This module NEVER writes flow.json (D-02) — planning never owns
// completion. Optional fields are set via conditional spread to respect
// `exactOptionalPropertyTypes`.
import type { BudgetReservation } from "../child/isolation";
import type { ChildContractExtension } from "../child/contract";
import type {
  EvidenceArtifactRef,
  EvidenceCausalIds,
  EvidenceProvenance,
  EvidenceRecord,
} from "../evidence/types";
import type { checkApproval } from "../mutation/approval";
import { planWaves } from "../parallel/scheduler";
import type { ChildTask, PlanWavesConfig } from "../parallel/scheduler";
import { dispatchExtension } from "./execute";
import type { CanonicalDispatch, DispatchArtifactRef, DispatchExtensionInput } from "./execute";
import type { CapabilityGrant, RegisterExtensionResult } from "./registry";

/**
 * One extension to schedule into a bounded wave: its dependency edges, its
 * registration/grant (bounding the dispatch it earns), its budget request (the
 * scheduler folds it), and every field {@link dispatchExtension} needs to build
 * a canonical, grant-bounded child dispatch plus a correlated evidence record.
 */
export interface ExtensionWaveTask {
  taskId: string;
  dependsOn: string[];
  registration: RegisterExtensionResult;
  capabilityGrant: CapabilityGrant;
  budgetRequest: BudgetReservation;
  cancelled?: boolean;
  sessionId: string;
  attempt: { attemptId: string; number: number };
  branchId: string;
  contextManifestHash: string;
  policyFingerprint: string;
  task: { title: string; description: string };
  acceptanceCriteria: string[];
  dispatchArtifact: DispatchArtifactRef;
  resultArtifact: DispatchArtifactRef;
}

/** Inputs to {@link planExtensionWave}. */
export interface PlanExtensionWaveInput {
  tasks: ExtensionWaveTask[];
  config: PlanWavesConfig;
  parentRunId: string;
  canonicalContractVersion: string;
}

/** Injected, deterministic id/clock sources (+ an unused approval hook). */
export interface PlanExtensionWaveDeps {
  idSeq: () => string;
  clock: () => string;
  checkApproval?: typeof checkApproval;
}

/**
 * One bound wave: the scheduled `taskIds` (from the reused `planWaves`), the
 * index-aligned grant-bounded `dispatches`, and the index-aligned, distinct
 * per-attempt `attemptEvidence`.
 */
export interface BoundWave {
  taskIds: string[];
  dispatches: CanonicalDispatch[];
  attemptEvidence: EvidenceRecord[];
}

/** Result of {@link planExtensionWave}: the bound wave plan or a fail-closed denial. */
export type PlanExtensionWaveResult =
  | { ok: true; waves: BoundWave[] }
  | { ok: false; reason: string };

/**
 * Build a distinct, immutable per-attempt {@link EvidenceRecord} for a PLANNED
 * (not-yet-run) extension dispatch (review-polish item E).
 *
 * This does NOT reuse W12 `childResultToEvidence`, whose `artifact.kind` is
 * `child-result:${status}` — that would require a canonical, TERMINAL
 * `CanonicalSubagentStatus` (DONE/…/FAILED) that a merely-scheduled attempt does
 * not have (the parent owns status/completion, D-02). Instead the artifact kind
 * signals a planned dispatch (`"extension-dispatch-planned"`), never a completed
 * disposition. Isolation is preserved: a fresh record per attempt (distinct
 * `evidenceId` from `deps.idSeq()`), correlated to the attempt via
 * `causal.attemptId`, never aliased or mutated across attempts. The frozen
 * enum is left untouched.
 */
function buildPlannedAttemptEvidence(
  extension: ChildContractExtension,
  deps: PlanExtensionWaveDeps,
): EvidenceRecord {
  const causal: EvidenceCausalIds = {
    runId: extension.parentRunId,
    sessionId: extension.sessionId,
    correlationId: deps.idSeq(),
    attemptId: extension.attempt.attemptId,
    branchId: extension.branchId,
  };

  const artifact: EvidenceArtifactRef = {
    artifactId: extension.durableResultArtifact.artifactId,
    kind: "extension-dispatch-planned",
    hash: extension.durableResultArtifact.hash,
    ...(extension.durableResultArtifact.path !== undefined
      ? { path: extension.durableResultArtifact.path }
      : {}),
  };

  const provenance: EvidenceProvenance = {
    provenanceId: deps.idSeq(),
    trustLevel: "derived",
    sourceKind: "extension-wave-plan",
  };

  return {
    schemaVersion: 1,
    evidenceId: deps.idSeq(),
    causal,
    kind: "custom",
    artifact,
    provenance,
    recordedAt: deps.clock(),
  };
}

/**
 * Plan a set of registered extensions into bounded parallel waves. Fail-closed,
 * deterministic, and additive — it COMPOSES the reused modules, reimplementing
 * none of their reasoning:
 *
 *   1. Registered-only (checked FIRST, before scheduling): if ANY task's
 *      `registration.ok === false`, the WHOLE plan is denied (reason names
 *      registration) — no wave ever binds that extension.
 *   2. Bounded schedule: each task maps to a `ChildTask` and the reused
 *      `planWaves` owns concurrency, aggregate budget folding, cancellation,
 *      cycle detection, and degenerate concurrency — its `{ok:false;reason}` is
 *      PROPAGATED verbatim.
 *   3. Per-task dispatch: each scheduled task earns a `dispatchExtension`-built
 *      canonical dispatch bounded to its own `capabilityGrant.capabilities`; a
 *      dispatch denial propagates fail-closed.
 *   4. Per-attempt evidence: each scheduled attempt gets its OWN distinct
 *      `childResultToEvidence` record (unique `evidenceId`, correlated by
 *      `attemptId`); records are fresh objects, never aliased or mutated across
 *      attempts or planning calls.
 *
 * Pure aside from the injected `deps.idSeq`/`deps.clock`.
 */
export function planExtensionWave(
  input: PlanExtensionWaveInput,
  deps: PlanExtensionWaveDeps,
): PlanExtensionWaveResult {
  // (1) Registered-only, fail-closed BEFORE any scheduling: a single
  // unregistered extension denies the WHOLE plan — no wave binds it.
  for (const task of input.tasks) {
    if (task.registration.ok === false) {
      return {
        ok: false,
        reason: `Extension wave denied: task "${task.taskId}" is not registered (${task.registration.reason}).`,
      };
    }
  }

  const taskById = new Map<string, ExtensionWaveTask>(
    input.tasks.map((task) => [task.taskId, task] as const),
  );

  // (2) Bounded schedule via the REUSED planWaves — concurrency, aggregate
  // budget, cancellation, cycle + degenerate concurrency all belong to it.
  const childTasks: ChildTask[] = input.tasks.map((task) => ({
    taskId: task.taskId,
    dependsOn: task.dependsOn,
    budgetRequest: task.budgetRequest,
    ...(task.cancelled !== undefined ? { cancelled: task.cancelled } : {}),
  }));

  const planResult = planWaves(childTasks, input.config, { idSeq: deps.idSeq });
  if (!planResult.ok) {
    // Propagate the scheduler's denial verbatim (budget/cycle/maxConcurrency).
    return { ok: false, reason: planResult.reason };
  }

  const dispatchDeps = { idSeq: deps.idSeq, clock: deps.clock };
  const waves: BoundWave[] = [];

  for (const wave of planResult.waves) {
    const taskIds: string[] = [];
    const dispatches: CanonicalDispatch[] = [];
    const attemptEvidence: EvidenceRecord[] = [];

    for (const taskId of wave.taskIds) {
      const task = taskById.get(taskId);
      if (task === undefined) {
        // Defensive: planWaves only schedules taskIds it was given, but guard
        // the lookup rather than index blindly (fail closed, no partial plan).
        return {
          ok: false,
          reason: `Extension wave denied: scheduled task "${taskId}" is not in the input set.`,
        };
      }

      // (3) Per-task, grant-bounded canonical dispatch via the REUSED
      // dispatchExtension. It also fails closed on an unregistered extension —
      // a defense-in-depth echo of step (1).
      const dispatchInput: DispatchExtensionInput = {
        registration: task.registration,
        capabilityGrant: task.capabilityGrant,
        reservedBudget: task.budgetRequest,
        parentRunId: input.parentRunId,
        sessionId: task.sessionId,
        attempt: task.attempt,
        branchId: task.branchId,
        contextManifestHash: task.contextManifestHash,
        policyFingerprint: task.policyFingerprint,
        canonicalContractVersion: input.canonicalContractVersion,
        task: task.task,
        acceptanceCriteria: task.acceptanceCriteria,
        dispatchArtifact: task.dispatchArtifact,
        resultArtifact: task.resultArtifact,
      };
      const dispatchResult = dispatchExtension(dispatchInput, dispatchDeps);
      if (!dispatchResult.ok) {
        return { ok: false, reason: dispatchResult.reason };
      }

      // (4) Per-attempt, isolated PLANNING-TIME evidence (item E): a fresh record
      // per attempt whose artifact kind signals a planned dispatch, never a
      // fabricated terminal `child-result:DONE` disposition. Never shared/mutated.
      const evidence = buildPlannedAttemptEvidence(dispatchResult.extension, deps);

      taskIds.push(task.taskId);
      dispatches.push(dispatchResult.dispatch);
      attemptEvidence.push(evidence);
    }

    waves.push({ taskIds, dispatches, attemptEvidence });
  }

  return { ok: true, waves };
}
