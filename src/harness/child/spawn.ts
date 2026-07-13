// Child spawn + disposition->evidence mapping (flow 015, W12 / CA-02).
//
// `spawnChild` composes the fail-closed `inheritBudget` + `inheritPolicy` guards
// from `./isolation`: EITHER denial refuses to spawn at all (no partial
// extension/session-entry is produced). Only when BOTH are granted does it build
// the child's `ChildContractExtension` (via `./contract`'s
// `buildChildDispatchExtension`, `canonicalContract: "subagent-dispatch"`), plus
// a `SessionEntryPayload`/`AppendOptions` pair the PARENT appends into its OWN
// `AppendOnlySession` — there is no separate child store; isolation is via
// `attemptId`/`branchId` linkage — and a `derived` child `Provenance`.
//
// `childResultToEvidence` maps any canonical child disposition
// (`DONE`/`DONE_WITH_CONCERNS`/`NEEDS_CONTEXT`/`BLOCKED`/`FAILED`) into a parent
// `EvidenceRecord`; the disposition survives onto `artifact.kind`
// (`child-result:${status}`) and, for the `NEEDS_CONTEXT` case, the missing
// bounded artifact is named on `artifact.path`.
//
// D-02: neither function accepts a `FlowService`/`ManagedFlowPort`/fs handle.
// Structurally nothing here can reach a flow.json write — the PARENT owns status
// and completion, advancing the flow from the evidence the child returned. Pure
// aside from the injected `deps.idSeq`/`deps.clock`; optional fields are set via
// conditional spread to respect `exactOptionalPropertyTypes`.
import type {
  EvidenceArtifactRef,
  EvidenceCausalIds,
  EvidenceProvenance,
  EvidenceRecord,
} from "../evidence/types";
import type { PolicyProfile } from "../policy/types";
import type { AppendOptions } from "../session/session";
import type { ArtifactRef, Provenance, SessionEntryPayload } from "../session/types";
import { buildChildDispatchExtension } from "./contract";
import type { CanonicalSubagentResult, ChildContractExtension } from "./contract";
import { childProvenance, inheritBudget, inheritPolicy } from "./isolation";
import type { BudgetReservation, ParentRemainingBudget } from "./isolation";

/** A parent's request to spawn one bounded child attempt. */
export interface SpawnChildRequest {
  attempt: { attemptId: string; number: number };
  branchId: string;
  budgetRequest: BudgetReservation;
  policyRequest: PolicyProfile;
  durableResultArtifact: ChildContractExtension["durableResultArtifact"];
}

/** Everything {@link spawnChild} needs from the parent to derive a bounded child. */
export interface SpawnChildInput {
  parentRunId: string;
  parentSessionId: string;
  parentProvenance: Provenance;
  contextManifestHash: string;
  canonicalContractVersion: string;
  parentRemainingBudget: ParentRemainingBudget;
  parentPolicy: PolicyProfile;
  parentLeafEntryId?: string;
  childRequest: SpawnChildRequest;
}

/** Injected non-determinism for the spawn/evidence path: id source + fixed clock. */
export interface SpawnChildDeps {
  idSeq: () => string;
  clock: () => string;
}

/**
 * Result of {@link spawnChild}: on success the schema-valid child extension, the
 * `dispatchEntryPayload`/`appendOptions` the PARENT appends into its own session,
 * and the derived child provenance; on any fail-closed denial just a reason (no
 * partial extension is ever produced).
 */
export type ChildSpawnResult =
  | {
      ok: true;
      extension: ChildContractExtension;
      dispatchEntryPayload: SessionEntryPayload;
      appendOptions: AppendOptions;
      provenance: Provenance;
    }
  | { ok: false; reason: string };

/**
 * Spawn a bounded child. Fail-closed: budget and policy inheritance are both
 * enforced before anything is built, and EITHER denial refuses to spawn — no
 * partial extension, session entry, or provenance escapes. Deterministic: only
 * `deps.idSeq` (via {@link childProvenance}) is consulted; the same input twice
 * yields deep-equal output.
 */
export function spawnChild(input: SpawnChildInput, deps: SpawnChildDeps): ChildSpawnResult {
  const budget = inheritBudget(input.parentRemainingBudget, input.childRequest.budgetRequest);
  if (!budget.ok) {
    return { ok: false, reason: `budget inheritance denied: ${budget.reason}` };
  }

  const policy = inheritPolicy(input.parentPolicy, input.childRequest.policyRequest);
  if (!policy.ok) {
    return { ok: false, reason: `policy inheritance denied: ${policy.reason}` };
  }

  const extension = buildChildDispatchExtension({
    canonicalContract: "subagent-dispatch",
    canonicalContractVersion: input.canonicalContractVersion,
    parentRunId: input.parentRunId,
    sessionId: input.parentSessionId,
    attempt: { attemptId: input.childRequest.attempt.attemptId, number: input.childRequest.attempt.number },
    branchId: input.childRequest.branchId,
    contextManifestHash: input.contextManifestHash,
    policyFingerprint: policy.policy.fingerprint,
    budgetReservation: budget.reservation,
    durableResultArtifact: input.childRequest.durableResultArtifact,
  });

  const dispatchArtifactRef: ArtifactRef = {
    artifactId: extension.durableResultArtifact.artifactId,
    kind: "child-dispatch",
    hash: extension.durableResultArtifact.hash,
    ...(extension.durableResultArtifact.path !== undefined
      ? { path: extension.durableResultArtifact.path }
      : {}),
  };
  const dispatchEntryPayload: SessionEntryPayload = {
    type: "branch_metadata",
    artifactRef: dispatchArtifactRef,
  };

  const appendOptions: AppendOptions = {
    attemptId: extension.attempt.attemptId,
    branchId: extension.branchId,
    ...(input.parentLeafEntryId !== undefined ? { parentEntryId: input.parentLeafEntryId } : {}),
  };

  const provenance = childProvenance(input.parentProvenance, { idSeq: deps.idSeq });

  return { ok: true, extension, dispatchEntryPayload, appendOptions, provenance };
}

/** Input to {@link childResultToEvidence}: a canonical child result + its extension. */
export interface ChildResultToEvidenceInput {
  canonical: CanonicalSubagentResult;
  extension: ChildContractExtension;
  missingArtifact?: string;
}

/**
 * Map a canonical child result (any disposition) into a parent
 * {@link EvidenceRecord}. The child's causal linkage
 * (`parentRunId`/`sessionId`/`attemptId`/`branchId`) is carried onto the record,
 * the disposition survives onto `artifact.kind` (`child-result:${status}`), and
 * — when `missingArtifact` is supplied (the `NEEDS_CONTEXT` case) — the missing
 * bounded artifact is named on `artifact.path`. The record's provenance is
 * `derived`/`child-agent-result`. Pure aside from `deps.idSeq()`/`deps.clock()`.
 */
export function childResultToEvidence(
  input: ChildResultToEvidenceInput,
  deps: SpawnChildDeps,
): EvidenceRecord {
  const { canonical, extension, missingArtifact } = input;

  const causal: EvidenceCausalIds = {
    runId: extension.parentRunId,
    sessionId: extension.sessionId,
    correlationId: deps.idSeq(),
    attemptId: extension.attempt.attemptId,
    branchId: extension.branchId,
  };

  const artifact: EvidenceArtifactRef = {
    artifactId: extension.durableResultArtifact.artifactId,
    kind: `child-result:${canonical.status}`,
    hash: extension.durableResultArtifact.hash,
    ...(missingArtifact !== undefined ? { path: missingArtifact } : {}),
  };

  const provenance: EvidenceProvenance = {
    provenanceId: deps.idSeq(),
    trustLevel: "derived",
    sourceKind: "child-agent-result",
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
