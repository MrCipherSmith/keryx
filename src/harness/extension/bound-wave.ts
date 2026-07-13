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
//   - W7/W12 `childResultToEvidence` (`../child/spawn`) + `EvidenceRecord`
//     (`../evidence/types`) — the per-attempt, isolated evidence shape.
//
// Fail-closed and deterministic: the ONLY non-determinism is the injected
// `deps.idSeq`/`deps.clock` (no `Date.now`/`Math.random`/network/fs/real
// async). This module NEVER writes flow.json (D-02) — planning never owns
// completion. Optional fields are set via conditional spread to respect
// `exactOptionalPropertyTypes`.
import type { BudgetReservation } from "../child/isolation";
import type { CanonicalSubagentResult } from "../child/contract";
import { childResultToEvidence } from "../child/spawn";
import type { EvidenceRecord } from "../evidence/types";
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
 * Build a minimal, canonical `subagent-result` for the per-attempt evidence
 * record. The evidence path only reads `status` (onto `artifact.kind`); the
 * remaining fields are present so the object stays schema-shaped. Fresh per
 * call — never shared/aliased across attempts.
 */
function buildAttemptResult(
  input: PlanExtensionWaveInput,
  dispatchId: string,
  createdAt: string,
): CanonicalSubagentResult {
  return {
    contract_version: input.canonicalContractVersion,
    run_id: input.parentRunId,
    dispatch_id: dispatchId,
    status: "DONE",
    summary: "Bound extension wave attempt scheduled.",
    acceptance: [],
    artifacts: [],
    changed_files: [],
    findings: [],
    questions: [],
    errors: [],
    metrics: {},
    timestamp_utc: createdAt,
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

      // (4) Per-attempt, isolated evidence via the REUSED childResultToEvidence.
      // Fresh canonical + fresh record per attempt — never shared/mutated.
      const attemptResult = buildAttemptResult(
        input,
        dispatchResult.dispatch.dispatch_id,
        deps.clock(),
      );
      const evidence = childResultToEvidence(
        { canonical: attemptResult, extension: dispatchResult.extension },
        dispatchDeps,
      );

      taskIds.push(task.taskId);
      dispatches.push(dispatchResult.dispatch);
      attemptEvidence.push(evidence);
    }

    waves.push({ taskIds, dispatches, attemptEvidence });
  }

  return { ok: true, waves };
}
