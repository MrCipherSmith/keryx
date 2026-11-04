import type { Control } from "../remote-control/protocol";
import { routingV2Digest, type NormalizedRoutingV2Config } from "../harness/routing/config-v2";
import { modelRefKey, sameModelRef, type ModelRef } from "../harness/routing/model-class";
import type { RoutingDecision } from "../harness/routing/decision";
import type { RoutingRequest } from "../harness/routing/routing-request";
import type { RoutingModelFacts, RoutingSnapshot } from "../harness/routing/snapshot";
import { resolveRoutingForRuntime } from "../harness/routing/routing-runtime";
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
}

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
    const policyAllowed = options.allowed?.(target.providerId, target.modelId) !== false;
    const available = candidate.available && candidate.reason === "none"
      && candidate.reasoningEfforts.includes(options.sessionConfig.reasoningEffort);
    const choice = { candidate, binding, target, parentAllowed };
    choices.push(choice);
    models.push({
      target,
      connected: true,
      credentialsAvailable: true,
      policyAllowed,
      parentAllowed,
      availability: available ? "available" : "unavailable",
      capabilities: [],
      contextLength: null,
      cooldown: false,
      estimatedCostUsd: null,
      observedLatencyMs: null,
    });
  }

  const baseline = choices.find((choice) => choice.candidate.candidateId === options.sessionConfig.baselineCandidateId);
  if (baseline === undefined) throw new Error("native routing baseline has no frozen model binding");
  const snapshotBody = {
    configDigest: options.routingConfig.configDigest,
    baseline: baseline.target,
    models: [...models].sort((left, right) => modelRefKey(left.target).localeCompare(modelRefKey(right.target))),
  };
  return {
    choices,
    baseline,
    snapshot: { ...snapshotBody, snapshotDigest: routingV2Digest(snapshotBody) },
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

/** Resolve with the shared pure resolver, then translate through the same frozen tuple. */
export function resolveNativeRoutingV2(options: ResolveNativeRoutingV2Options): NativeRoutingV2Resolution {
  const frozen = buildNativeRoutingV2Snapshot(options);
  const request: RoutingRequest = { ...options.request, baseline: frozen.baseline.target };
  const receipt = resolveRoutingForRuntime({ request, snapshot: frozen.snapshot, config: options.routingConfig });
  const decision = receipt.decision;
  if (decision.status !== "selected") return { receiptId: receipt.receiptId, decision };
  const choice = frozen.choices.find((candidate) => candidate.parentAllowed && sameModelRef(candidate.target, decision.selection));
  if (choice === undefined) throw new Error("native routing decision escaped frozen availability");
  return { receiptId: receipt.receiptId, decision, candidateId: choice.candidate.candidateId };
}
