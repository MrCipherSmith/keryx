import { canonicalDigest, type Control } from "../remote-control/protocol";
import type { NormalizedRoutingV2Config } from "../harness/routing/config-v2";
import { modelRefKey, sameModelRef, type ModelRef } from "../harness/routing/model-class";
import type { RoutingDecision } from "../harness/routing/decision";
import type { RoutingRequest, RoutingRequirements } from "../harness/routing/routing-request";
import { createRoutingSnapshot, type RoutingModelFacts, type RoutingSnapshot } from "../harness/routing/snapshot";
import { resolveRoutingDecision } from "../harness/routing/resolver";
import type { NativeModelBinding } from "./model-identity";

export interface NativeRoutingV2Choice {
  readonly candidate: Control["RoutingCandidate"];
  readonly binding: NativeModelBinding;
  readonly target: ModelRef;
  readonly parentAllowed: boolean;
}

export interface NativeRoutingV2Snapshot {
  readonly choices: readonly NativeRoutingV2Choice[];
  readonly baseline: NativeRoutingV2Choice;
  readonly snapshot: RoutingSnapshot;
}

export interface BuildNativeRoutingV2SnapshotOptions {
  readonly sessionConfig: Control["SessionConfig"];
  readonly availability: Control["RoutingAvailability"];
  readonly bindings: readonly NativeModelBinding[];
  readonly routingConfig: NormalizedRoutingV2Config;
  readonly allowed?: (providerId: string, modelId: string) => boolean;
  readonly requirements?: RoutingRequirements;
  readonly observedAt?: string;
  readonly authFailedProviderIds?: readonly string[];
  /** Locally observed provider/profile facts; absence remains explicitly unknown. */
  readonly modelFacts?: NativeRoutingV2FactsProvider;
}

export type NativeRoutingV2FactsProvider = (
    target: ModelRef,
    candidate: Control["RoutingCandidate"],
    requirements: RoutingRequirements | undefined,
  ) => Partial<Pick<RoutingModelFacts, "connected" | "credentialsAvailable" | "capabilities" | "contextLength" | "cooldown" | "estimatedCostUsd" | "observedLatencyMs">>;

function bindingKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

/**
 * Builds the native resolver snapshot from one frozen protocol availability and
 * one frozen binding list. Actual provider/model identities are facts only;
 * candidate IDs remain the protocol authority used for execution.
 */
export function buildNativeRoutingV2Snapshot(options: BuildNativeRoutingV2SnapshotOptions): NativeRoutingV2Snapshot {
  const bindings = new Map(options.bindings.map((binding) => [bindingKey(binding.providerId, binding.modelId), binding]));
  const pinned = new Set([options.sessionConfig.baselineCandidateId, ...options.sessionConfig.routing.candidateIds]);
  const seenTargets = new Map<string, string>();
  const choices: NativeRoutingV2Choice[] = [];
  const models: RoutingModelFacts[] = [];

  for (const candidate of options.availability.candidates) {
    const binding = bindings.get(bindingKey(candidate.providerId, candidate.modelId));
    if (binding === undefined) continue;
    const target = { providerId: binding.actualProviderId, modelId: binding.actualModelId };
    const targetKey = modelRefKey(target);
    const prior = seenTargets.get(targetKey);
    if (prior !== undefined && prior !== candidate.candidateId) {
      throw new Error(`native routing identity conflict for ${target.providerId}/${target.modelId}`);
    }
    seenTargets.set(targetKey, candidate.candidateId);

    const parentAllowed = pinned.has(candidate.candidateId);
    const policyAllowed = candidate.reason !== "local-policy" && candidate.reason !== "consent-required"
      && options.allowed?.(target.providerId, target.modelId) !== false;
    const available = candidate.available && candidate.reason === "none"
      && candidate.reasoningEfforts.includes(options.sessionConfig.reasoningEffort);
    const observed = options.modelFacts?.(target, candidate, options.requirements);
    const choice = { candidate, binding, target, parentAllowed };
    choices.push(choice);
    models.push({
      target,
      connected: observed?.connected ?? candidate.reason !== "not-connected",
      // The protocol distinguishes a disconnected provider from policy,
      // budget, and reasoning-effort unavailability. Do not misreport those
      // latter states as missing credentials merely because they are not
      // executable in this frozen availability.
      credentialsAvailable: observed?.credentialsAvailable ?? candidate.reason !== "not-connected",
      policyAllowed,
      parentAllowed,
      availability: available ? "available" : "unavailable",
      capabilities: observed?.capabilities ?? [],
      contextLength: observed?.contextLength ?? null,
      cooldown: observed?.cooldown ?? false,
      estimatedCostUsd: observed?.estimatedCostUsd ?? null,
      observedLatencyMs: observed?.observedLatencyMs ?? null,
    });
  }

  const baseline = choices.find((choice) => choice.candidate.candidateId === options.sessionConfig.baselineCandidateId);
  if (baseline === undefined) throw new Error("native routing baseline has no frozen model binding");
  const snapshot = createRoutingSnapshot({
    configDigest: options.routingConfig.configDigest,
    observedAt: options.observedAt ?? new Date().toISOString(),
    catalogRevision: canonicalDigest(options.availability),
    policyRevision: options.availability.policyDigest,
    capabilityRevision: options.availability.capabilityDigest,
    authFailedProviderIds: options.authFailedProviderIds ?? [],
    baseline: baseline.target,
    models: [...models].sort((left, right) => modelRefKey(left.target).localeCompare(modelRefKey(right.target))),
  });
  return {
    choices,
    baseline,
    snapshot,
  };
}

export interface ResolveNativeRoutingV2Options extends BuildNativeRoutingV2SnapshotOptions {
  readonly request: Omit<RoutingRequest, "baseline">;
}

export interface NativeRoutingV2Resolution {
  readonly receiptId: string;
  readonly decision: RoutingDecision;
  readonly candidateId?: string;
}

export interface PreparedNativeRoutingV2 {
  readonly frozen: NativeRoutingV2Snapshot;
  readonly request: RoutingRequest;
}

/** Build one immutable native request/snapshot pair without journaling or provider I/O. */
export function prepareNativeRoutingV2(options: ResolveNativeRoutingV2Options): PreparedNativeRoutingV2 {
  const frozen = buildNativeRoutingV2Snapshot({ ...options, requirements: options.request.requirements });
  const request: RoutingRequest = { ...options.request, baseline: frozen.baseline.target };
  return { frozen, request };
}

/** Translate a decision through the exact frozen tuple that produced its snapshot. */
export function nativeRoutingV2Resolution(frozen: NativeRoutingV2Snapshot, decision: RoutingDecision): NativeRoutingV2Resolution {
  if (decision.status !== "selected") return { receiptId: decision.decisionId, decision };
  const choice = frozen.choices.find((candidate) => candidate.parentAllowed && sameModelRef(candidate.target, decision.selection));
  if (choice === undefined) throw new Error("native routing decision escaped frozen availability");
  return { receiptId: decision.decisionId, decision, candidateId: choice.candidate.candidateId };
}

/** Pure preview/test convenience; real dispatches journal at their authorized call site. */
export function resolveNativeRoutingV2(options: ResolveNativeRoutingV2Options): NativeRoutingV2Resolution {
  const prepared = prepareNativeRoutingV2(options);
  const decision = resolveRoutingDecision(prepared.request, prepared.frozen.snapshot, options.routingConfig);
  return nativeRoutingV2Resolution(prepared.frozen, decision);
}
