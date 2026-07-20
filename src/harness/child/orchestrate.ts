// Subagent orchestration facade (flow 091, multi-agent engine integration).
//
// Phases 1-3 delivered the subagent primitives as individually-tested seams:
// `resolveChildModel` (via `spawnChild`), the depth/count caps, the
// `RemainingBudgetLedger`, `childRunModel`, and `quarantineChildSummary`. This
// module is the ONE place that composes them into a single fail-closed call so a
// caller does not hand-wire the allowlist, caps, tiers, ledger, spawn, run-model
// mapping, and quarantine itself.
//
// It adds NO new behavior and does not broaden any primitive's contract — it only
// fixes the composition order and propagates denials. Pure and deterministic:
// provider detection, the ledger, and `deps.idSeq`/`deps.clock` are all injected;
// nothing here reads a clock/RNG, the network, `process.env`, or the filesystem,
// and it never writes flow state (D-02 preserved — the parent owns completion).
import { childRunModel, spawnChild } from "./spawn";
import type { SpawnChildDeps, SpawnChildInput, SpawnChildRequest } from "./spawn";
import type { RemainingBudgetLedger } from "./ledger";
import type { ChildModelRequest, ModelSelection, ParentModelContext } from "./model";
import { quarantineChildSummary } from "./quarantine";
import type { QuarantineResult } from "./quarantine";
import type { ChildContractExtension } from "./contract";
import type { PolicyProfile } from "../policy/types";
import type { Provenance } from "../session/types";

/** Conservative fail-closed defaults applied when `SubagentConfig` omits a cap. */
export const DEFAULT_MAX_TREE_DEPTH = 3;
export const DEFAULT_MAX_CHILDREN = 16;

/**
 * Subagent policy/config the facade maps onto `spawnChild`'s cap/model inputs.
 * Kept OUT of the frozen `HarnessConfig` schema; a caller passes it via
 * {@link SubagentContext}. Omitted caps fall back to the conservative constants
 * above (fail-closed: bounded fan-out even with no config).
 */
export interface SubagentConfig {
  maxTreeDepth?: number;
  maxChildren?: number;
  /** Deterministic tier -> selection map for `{kind:"tier"}` model requests. */
  tiers?: Record<string, ModelSelection>;
  /** Parsed `KERYX_SUBAGENT_MODEL` override (undefined when unset / `inherit`). */
  envOverride?: ModelSelection;
}

/** A minimal provider-detection view: the credentialed providers a child may use. */
export interface DetectedProviderLike {
  name: string;
}

/**
 * Everything the facade needs from the parent, injected (never read ambiently).
 * `ledger` is the single run-scoped budget/count authority shared across every
 * `spawnSubagent` call. `detected` is the parent's provider-detection result —
 * only detected (credentialed) providers become admissible (AC2).
 */
export interface SubagentContext {
  parentRunId: string;
  parentSessionId: string;
  parentProvenance: Provenance;
  contextManifestHash: string;
  canonicalContractVersion: string;
  parentModel: ParentModelContext;
  parentPolicy: PolicyProfile;
  ledger: RemainingBudgetLedger;
  detected: readonly DetectedProviderLike[];
  config?: SubagentConfig;
  parentLeafEntryId?: string;
}

/** One subagent dispatch request (the per-child variable inputs). */
export interface SpawnSubagentRequest {
  attempt: SpawnChildRequest["attempt"];
  branchId: string;
  budgetRequest: SpawnChildRequest["budgetRequest"];
  policyRequest: PolicyProfile;
  durableResultArtifact: SpawnChildRequest["durableResultArtifact"];
  modelRequest?: ChildModelRequest;
}

/** Result of {@link spawnSubagent}: the assembled child or a fail-closed denial. */
export type SpawnSubagentResult =
  | {
      ok: true;
      extension: ChildContractExtension;
      /** The `{provider,model}` to feed a child `runOffline`; undefined only if no selection resolved. */
      runModel: { provider: string; model: string } | undefined;
      provenance: Provenance;
      reservation: { reservationId: string; maxRuntimeMs: number; maxToolCalls?: number };
    }
  | { ok: false; reason: string };

/** The credentialed provider allowlist derived from a detection result (AC2). Pure. */
export function allowedProvidersFromDetected(
  detected: readonly DetectedProviderLike[],
): ReadonlySet<string> {
  return new Set(detected.map((d) => d.name));
}

/**
 * Assemble one bounded subagent: derive the allowlist from detection, build the
 * `spawnChild` input from `config` (caps/tiers/env override) against the ledger's
 * running remaining + child count, run the fail-closed guard chain
 * (caps -> budget -> policy -> model), and on success admit the reservation to the
 * shared ledger and map the resolved selection to a child run model. Any denial
 * returns `{ok:false}` and leaves the ledger UNCHANGED (spawnChild is pure; the
 * ledger is only mutated after a granted spawn). Deterministic.
 */
export function spawnSubagent(
  request: SpawnSubagentRequest,
  ctx: SubagentContext,
  deps: SpawnChildDeps,
): SpawnSubagentResult {
  const config = ctx.config ?? {};
  const allowedProviders = allowedProvidersFromDetected(ctx.detected);

  const spawnInput: SpawnChildInput = {
    parentRunId: ctx.parentRunId,
    parentSessionId: ctx.parentSessionId,
    parentProvenance: ctx.parentProvenance,
    contextManifestHash: ctx.contextManifestHash,
    canonicalContractVersion: ctx.canonicalContractVersion,
    parentRemainingBudget: ctx.ledger.remaining,
    parentPolicy: ctx.parentPolicy,
    parentModel: ctx.parentModel,
    allowedProviders,
    caps: {
      maxTreeDepth: config.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH,
      maxChildren: config.maxChildren ?? DEFAULT_MAX_CHILDREN,
      currentChildCount: ctx.ledger.childCount,
    },
    childRequest: {
      attempt: request.attempt,
      branchId: request.branchId,
      budgetRequest: request.budgetRequest,
      policyRequest: request.policyRequest,
      durableResultArtifact: request.durableResultArtifact,
      ...(request.modelRequest !== undefined ? { modelRequest: request.modelRequest } : {}),
    },
    ...(config.tiers !== undefined ? { modelTiers: config.tiers } : {}),
    ...(config.envOverride !== undefined ? { modelEnvOverride: config.envOverride } : {}),
    ...(ctx.parentLeafEntryId !== undefined ? { parentLeafEntryId: ctx.parentLeafEntryId } : {}),
  };

  const spawned = spawnChild(spawnInput, deps);
  if (!spawned.ok) {
    return { ok: false, reason: spawned.reason };
  }

  // Commit the reservation to the single run-scoped authority AFTER a granted
  // spawn. Uses the same fail-closed subset check; a mismatch (should not happen
  // since spawnChild already granted against `ledger.remaining`) is surfaced, not
  // silently ignored.
  const admitted = ctx.ledger.admit(request.budgetRequest);
  if (!admitted.ok) {
    return { ok: false, reason: `ledger admission denied: ${admitted.reason}` };
  }

  return {
    ok: true,
    extension: spawned.extension,
    runModel: childRunModel(spawned.extension),
    provenance: spawned.provenance,
    reservation: admitted.reservation,
  };
}

/**
 * Quarantine seam for a child's returned summary (AC5). Run this BEFORE the
 * orchestrator folds a child summary into evidence or plans a next dispatch from
 * it, so instruction-shaped free-text is flagged (marker prepended, text
 * preserved) and can never silently become orchestrator instructions. Pure.
 */
export function foldChildSummary(summary: string): QuarantineResult {
  return quarantineChildSummary(summary);
}
