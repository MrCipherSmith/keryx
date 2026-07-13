// Extension execution — canonical dispatch, escalation gate, and NEEDS_CONTEXT
// retry (flow 023, R2-1 / W12+ / W15+ / T6, reviewer track: security/contract).
//
// Composes ONLY already-GREEN modules — no rewrite of prior behavior:
//   - W15 registry (`registerExtension`/`CapabilityGrant`) bounds discovery:
//     an unregistered/ungranted extension fails closed BEFORE any dispatch is
//     built.
//   - W12 child contract (`buildChildDispatchExtension`/`parseChildResult`)
//     produces the frozen extension metadata and normalizes a STATUS-first
//     reply to the canonical `subagent-result` object BEFORE persistence.
//   - W12 isolation capability vocabulary (`isKnownCapability`) is the closed
//     `read/write/shell/network/delegate` set the escalation gate contains
//     against — any out-of-vocabulary capability fails closed.
//   - W10 approval (`checkApproval`, injected) decides whether an escalation's
//     recorded approval still authorizes the broader grant.
//
// Fail-closed at every gate. Deterministic: the only non-determinism is the
// injected `deps.idSeq`/`deps.clock` (no `Date.now`/`Math.random`/network/fs
// mutation). This module NEVER writes flow.json — the parent owns completion.
import { buildChildDispatchExtension, parseChildResult } from "../child/contract";
import type { ChildContractExtension, ParsedChildResult } from "../child/contract";
import type { BudgetReservation } from "../child/isolation";
import { isKnownCapability } from "../child/isolation";
import { checkApproval } from "../mutation/approval";
import type { ApprovalCheckInput } from "../mutation/approval";
import type { Provenance } from "../session/types";
import type { CapabilityGrant, RegisterExtensionResult } from "./registry";

// ---------------------------------------------------------------------------
// dispatchExtension — canonical child dispatch bounded to the grant.
// ---------------------------------------------------------------------------

/** A durable artifact reference used to seed the extension metadata. */
export interface DispatchArtifactRef {
  artifactId: string;
  kind: string;
  path: string;
  hash: string;
}

/** Inputs to {@link dispatchExtension}. */
export interface DispatchExtensionInput {
  /** MUST be `{ok:true;...}` from W15 `registerExtension`; `ok:false` refuses. */
  registration: RegisterExtensionResult;
  /** The registered extension's grant — bounds `dispatch.allowed_actions`. */
  capabilityGrant: CapabilityGrant;
  /** The coordinator's reserved child budget. */
  reservedBudget: BudgetReservation;
  parentRunId: string;
  sessionId: string;
  attempt: { attemptId: string; number: number };
  branchId: string;
  contextManifestHash: string;
  policyFingerprint: string;
  canonicalContractVersion: string;
  task: { title: string; description: string };
  acceptanceCriteria: string[];
  dispatchArtifact: DispatchArtifactRef;
  resultArtifact: DispatchArtifactRef;
}

/** Injected, deterministic id/clock sources. */
export interface DispatchExtensionDeps {
  idSeq: () => string;
  clock: () => string;
}

/**
 * A canonical `subagent-dispatch` object. Structurally a `Record<string,
 * unknown>` (the pinned surface), with the two correlated fields callers read
 * back — `dispatch_id` and `allowed_actions` — narrowed for type-safe access.
 */
export interface CanonicalDispatch {
  dispatch_id: string;
  allowed_actions: string[];
  [key: string]: unknown;
}

/** Result of {@link dispatchExtension}. */
export type DispatchExtensionResult =
  | {
      ok: true;
      dispatch: CanonicalDispatch;
      extension: ChildContractExtension;
      parseResult: (raw: string | ParsedChildResult) => ParsedChildResult;
    }
  | { ok: false; reason: string };

/**
 * Build a canonical child dispatch (validates as `subagent-dispatch`) plus the
 * frozen extension metadata (validates as `harness-child-contract-extension`),
 * bounded to the extension's granted capabilities.
 *
 * Fail-closed: `registration.ok === false` refuses immediately with NO dispatch
 * or extension built (the denied result carries only `{ok,reason}`). The
 * returned `parseResult` closes over a `subagent-result`-variant extension and
 * the SAME `dispatch_id`, so a STATUS-first reply normalizes (via the reused
 * `parseChildResult`) to the canonical object — never the raw STATUS string —
 * correlated back to this dispatch. Deterministic: only `deps.idSeq`/`clock`.
 */
export function dispatchExtension(
  input: DispatchExtensionInput,
  deps: DispatchExtensionDeps,
): DispatchExtensionResult {
  // Fail-closed on an unregistered/ungranted extension: no authority is built.
  if (input.registration.ok === false) {
    return {
      ok: false,
      reason: `Extension dispatch refused: the extension is not registered (${input.registration.reason}).`,
    };
  }

  const dispatchId = deps.idSeq();
  const createdAt = deps.clock();

  // Canonical `subagent-dispatch` — allowed_actions is bounded EXACTLY to the
  // grant (no broader authority than what was granted).
  const dispatch: CanonicalDispatch = {
    contract_version: input.canonicalContractVersion,
    run_id: input.parentRunId,
    dispatch_id: dispatchId,
    orchestrator: "harness-extension-coordinator",
    target_skill: input.registration.extensionId,
    task: { title: input.task.title, description: input.task.description },
    acceptance_criteria: [...input.acceptanceCriteria],
    context_refs: [],
    files_to_read: [],
    constraints: [],
    allowed_actions: [...input.capabilityGrant.capabilities],
    output_contract: {
      schema: "subagent-result.schema.json",
      artifact_path: input.resultArtifact.path,
    },
    budget: { max_runtime_ms: input.reservedBudget.maxRuntimeMs },
    provenance: { created_at: createdAt, created_by: input.registration.extensionId },
  };

  // The dispatch- and result-variant extensions differ ONLY in
  // `canonicalContract` (review-hardening fix #5): build both from one local
  // helper closing over the shared input so the two variants can never drift.
  const buildExt = (canonicalContract: "subagent-dispatch" | "subagent-result"): ChildContractExtension =>
    buildChildDispatchExtension({
      canonicalContract,
      canonicalContractVersion: input.canonicalContractVersion,
      parentRunId: input.parentRunId,
      sessionId: input.sessionId,
      attempt: input.attempt,
      branchId: input.branchId,
      contextManifestHash: input.contextManifestHash,
      policyFingerprint: input.policyFingerprint,
      budgetReservation: input.reservedBudget,
      durableResultArtifact: {
        artifactId: input.resultArtifact.artifactId,
        kind: input.resultArtifact.kind,
        hash: input.resultArtifact.hash,
        path: input.resultArtifact.path,
      },
    });

  // Frozen extension metadata for the DISPATCH variant.
  const extension = buildExt("subagent-dispatch");
  // The RESULT-variant extension the parser closes over: same correlation, but
  // `canonicalContract:"subagent-result"` for the eventual normalized reply.
  const resultExtension = buildExt("subagent-result");

  const parseResult = (raw: string | ParsedChildResult): ParsedChildResult =>
    parseChildResult(raw, {
      extension: resultExtension,
      runId: input.parentRunId,
      dispatchId,
      timestampUtc: deps.clock(),
      contractVersion: input.canonicalContractVersion,
    });

  return { ok: true, dispatch, extension, parseResult };
}

// ---------------------------------------------------------------------------
// evaluateExtensionGrant — subset grants; escalation requires policy+prov+approval.
// ---------------------------------------------------------------------------

/** Inputs to {@link evaluateExtensionGrant}. */
export interface EvaluateExtensionGrantInput {
  grantedCapabilities: string[];
  requestedCapabilities: string[];
  policyDecision?: "allow" | "ask" | "deny";
  provenance?: Provenance;
  approval?: ApprovalCheckInput;
}

/** Injected W10 approval check. */
export interface EvaluateExtensionGrantDeps {
  checkApproval: typeof checkApproval;
}

/** Result of {@link evaluateExtensionGrant} — a denial grants NOTHING. */
export type EvaluateExtensionGrantResult = { ok: true } | { ok: false; reason: string };

/**
 * Grant a requested capability set that is ⊆ the extension's grant; a BROADER
 * request (escalation) is DENIED unless ALL of an explicit `allow` policy
 * decision, a parent-linked provenance, and a valid W10 approval are present —
 * each missing piece independently denies and its reason names the piece.
 *
 * Fail-closed: any capability (granted OR requested) outside the fixed
 * `read/write/shell/network/delegate` vocabulary denies regardless of the
 * subset relationship; a `deny`/`ask` policy always denies an escalation; a
 * denied result carries no capability grant (only `{ok:false;reason}`).
 * Deterministic: no clock/RNG; the approval clock arrives inside `approval`.
 */
export function evaluateExtensionGrant(
  input: EvaluateExtensionGrantInput,
  deps: EvaluateExtensionGrantDeps,
): EvaluateExtensionGrantResult {
  // Fail-closed on an out-of-vocabulary capability BEFORE any subset reasoning:
  // an unknown capability can never be reasoned about as contained.
  for (const capability of [...input.grantedCapabilities, ...input.requestedCapabilities]) {
    if (!isKnownCapability(capability)) {
      return {
        ok: false,
        reason: `Extension grant refused: capability "${capability}" is outside the known vocabulary.`,
      };
    }
  }

  const granted = new Set(input.grantedCapabilities);
  const isSubset = input.requestedCapabilities.every((capability) => granted.has(capability));
  if (isSubset) {
    return { ok: true };
  }

  // Escalation (⊄ the grant): require policy + provenance + a valid approval,
  // each checked in order so its denial names the missing piece.
  if (input.policyDecision !== "allow") {
    return {
      ok: false,
      reason: "Escalation denied: an explicit policy decision of \"allow\" is required.",
    };
  }
  if (input.provenance === undefined) {
    return {
      ok: false,
      reason: "Escalation denied: a parent-linked provenance is required.",
    };
  }
  if (input.approval === undefined || deps.checkApproval(input.approval).kind !== "valid") {
    return {
      ok: false,
      reason: "Escalation denied: a valid approval is required.",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// retryWithContext — NEEDS_CONTEXT same-id / add-only artifact / immutable prior.
// ---------------------------------------------------------------------------

/** A bounded context artifact reference. */
export interface ArtifactRefLike {
  path: string;
  kind: string;
  exists: boolean;
}

/** Inputs to {@link retryWithContext}. */
export interface RetryWithContextInput {
  priorAttempt: {
    dispatchId: string;
    contextRefs: ArtifactRefLike[];
    childResult: ParsedChildResult;
  };
  missingArtifactRef: ArtifactRefLike;
  /** MUST equal `priorAttempt.dispatchId`; a mismatch is refused. */
  dispatchId: string;
}

/** Injected dependencies — none. */
export type RetryWithContextDeps = Record<string, never>;

/** Result of {@link retryWithContext}. */
export type RetryWithContextResult =
  | {
      ok: true;
      retryDispatch: { dispatchId: string; contextRefs: ArtifactRefLike[] };
      addedContext: string[];
    }
  | { ok: false; reason: string };

/**
 * Handle a NEEDS_CONTEXT child result naming ONE missing bounded artifact by
 * producing a retry dispatch with the SAME dispatch id that adds ONLY that
 * artifact to the bounded context.
 *
 * Fail-closed: only a NEEDS_CONTEXT prior result may retry, and only for the
 * SAME dispatch id (never silently retries a different dispatch). NEVER mutates
 * `priorAttempt` — the retry's context is a fresh array `[...prior, missing]`,
 * so the frozen prior record is deep-equal before and after.
 */
export function retryWithContext(
  input: RetryWithContextInput,
  _deps: RetryWithContextDeps,
): RetryWithContextResult {
  const { priorAttempt, missingArtifactRef, dispatchId } = input;

  if (priorAttempt.childResult.canonical.status !== "NEEDS_CONTEXT") {
    return {
      ok: false,
      reason: "Retry refused: only a NEEDS_CONTEXT prior result may be retried.",
    };
  }
  if (dispatchId !== priorAttempt.dispatchId) {
    return {
      ok: false,
      reason: "Retry refused: dispatchId does not match the prior attempt.",
    };
  }

  return {
    ok: true,
    retryDispatch: {
      dispatchId: priorAttempt.dispatchId,
      contextRefs: [...priorAttempt.contextRefs, missingArtifactRef],
    },
    addedContext: [missingArtifactRef.path],
  };
}
