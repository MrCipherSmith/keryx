import { modelRefKey, type ModelRef } from "./model-class";
import { routingDigest } from "./config";
import { ROUTING_CAPABILITIES, type RoutingCapability } from "./routing-request";

export type RoutingTargetAvailability = "available" | "unavailable" | "unknown";

export interface RoutingModelFacts {
  readonly target: ModelRef;
  readonly connected: boolean;
  readonly credentialsAvailable: boolean;
  readonly policyAllowed: boolean;
  readonly parentAllowed: boolean;
  readonly availability: RoutingTargetAvailability;
  readonly capabilities: readonly RoutingCapability[];
  readonly contextLength: number | null;
  readonly cooldown: boolean;
  readonly estimatedCostUsd: number | null;
  readonly observedLatencyMs: number | null;
}

export interface RoutingSnapshotBody {
  readonly configDigest: string;
  readonly observedAt: string;
  readonly catalogRevision: string;
  readonly policyRevision: string;
  readonly capabilityRevision: string;
  readonly authFailedProviderIds: readonly string[];
  readonly baseline: ModelRef;
  readonly models: readonly RoutingModelFacts[];
}
export interface RoutingSnapshot extends RoutingSnapshotBody {
  readonly snapshotDigest: string;
}

function assertSnapshotBody(body: RoutingSnapshotBody): void {
  if (body.configDigest.length === 0 || body.catalogRevision.length === 0 || body.policyRevision.length === 0 || body.capabilityRevision.length === 0) {
    throw new Error("routing snapshot revisions must be non-empty");
  }
  const observedAt = Date.parse(body.observedAt);
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== body.observedAt) {
    throw new Error("routing snapshot observedAt must be a canonical ISO timestamp");
  }
  if (body.baseline.providerId.length === 0 || body.baseline.modelId.length === 0) throw new Error("routing snapshot baseline is invalid");
  if (body.authFailedProviderIds.some((providerId) => providerId.length === 0)) throw new Error("routing snapshot auth failure provider ids must be non-empty");
  if (new Set(body.authFailedProviderIds).size !== body.authFailedProviderIds.length) throw new Error("routing snapshot auth failure provider ids must be unique");
  const modelKeys = body.models.map((model) => modelRefKey(model.target));
  if (new Set(modelKeys).size !== modelKeys.length) throw new Error("routing snapshot model facts must be unique");
  for (const facts of body.models) {
    if (facts.target.providerId.length === 0 || facts.target.modelId.length === 0) throw new Error("routing snapshot model target is invalid");
    if (typeof facts.connected !== "boolean" || typeof facts.credentialsAvailable !== "boolean"
      || typeof facts.policyAllowed !== "boolean" || typeof facts.parentAllowed !== "boolean" || typeof facts.cooldown !== "boolean") {
      throw new Error("routing snapshot model flags must be boolean");
    }
    if (!(facts.availability === "available" || facts.availability === "unavailable" || facts.availability === "unknown")) {
      throw new Error("routing snapshot model availability is invalid");
    }
    if (!Array.isArray(facts.capabilities)
      || facts.capabilities.some((capability) => !ROUTING_CAPABILITIES.includes(capability))
      || new Set(facts.capabilities).size !== facts.capabilities.length) {
      throw new Error("routing snapshot model capabilities are invalid");
    }
    if (facts.contextLength !== null && (!Number.isSafeInteger(facts.contextLength) || facts.contextLength < 0)) {
      throw new Error("routing snapshot model context length is invalid");
    }
    if (facts.estimatedCostUsd !== null && (!Number.isFinite(facts.estimatedCostUsd) || facts.estimatedCostUsd < 0)) {
      throw new Error("routing snapshot model estimated cost is invalid");
    }
    if (facts.observedLatencyMs !== null && (!Number.isFinite(facts.observedLatencyMs) || facts.observedLatencyMs < 0)) {
      throw new Error("routing snapshot model latency is invalid");
    }
  }
}

function copyModelRef(target: ModelRef): ModelRef {
  return Object.freeze({ providerId: target.providerId, modelId: target.modelId });
}

function copyModelFacts(facts: RoutingModelFacts): RoutingModelFacts {
  return Object.freeze({
    target: copyModelRef(facts.target), connected: facts.connected, credentialsAvailable: facts.credentialsAvailable,
    policyAllowed: facts.policyAllowed, parentAllowed: facts.parentAllowed, availability: facts.availability,
    capabilities: Object.freeze([...facts.capabilities].sort()), contextLength: facts.contextLength,
    cooldown: facts.cooldown, estimatedCostUsd: facts.estimatedCostUsd, observedLatencyMs: facts.observedLatencyMs,
  });
}

function canonicalSnapshotBody(body: RoutingSnapshotBody): unknown {
  return {
    configDigest: body.configDigest,
    observedAt: body.observedAt,
    catalogRevision: body.catalogRevision,
    policyRevision: body.policyRevision,
    capabilityRevision: body.capabilityRevision,
    authFailedProviderIds: [...body.authFailedProviderIds].sort(),
    baseline: body.baseline,
    models: [...body.models]
      .sort((left, right) => modelRefKey(left.target).localeCompare(modelRefKey(right.target)))
      .map((facts) => ({ ...facts, capabilities: [...facts.capabilities].sort() })),
  };
}

export function routingSnapshotDigest(body: RoutingSnapshotBody): string {
  return routingDigest(canonicalSnapshotBody(body));
}

export function createRoutingSnapshot(body: RoutingSnapshotBody): RoutingSnapshot {
  assertSnapshotBody(body);
  const frozenBody: RoutingSnapshotBody = Object.freeze({
    configDigest: body.configDigest,
    observedAt: body.observedAt,
    catalogRevision: body.catalogRevision,
    policyRevision: body.policyRevision,
    capabilityRevision: body.capabilityRevision,
    authFailedProviderIds: Object.freeze([...body.authFailedProviderIds].sort()),
    baseline: copyModelRef(body.baseline),
    models: Object.freeze(body.models.map(copyModelFacts)),
  });
  return Object.freeze({ ...frozenBody, snapshotDigest: routingSnapshotDigest(frozenBody) });
}

export function isVerifiedRoutingSnapshot(snapshot: RoutingSnapshot): boolean {
  try { assertSnapshotBody(snapshot); } catch { return false; }
  const topLevelKeys = new Set(["configDigest", "snapshotDigest", "observedAt", "catalogRevision", "policyRevision", "capabilityRevision", "authFailedProviderIds", "baseline", "models"]);
  const factKeys = new Set(["target", "connected", "credentialsAvailable", "policyAllowed", "parentAllowed", "availability", "capabilities", "contextLength", "cooldown", "estimatedCostUsd", "observedLatencyMs"]);
  const modelRefKeys = new Set(["providerId", "modelId"]);
  return Object.keys(snapshot).every((key) => topLevelKeys.has(key))
    && Object.keys(snapshot.baseline).every((key) => modelRefKeys.has(key))
    && snapshot.models.every((facts) => Object.keys(facts).every((key) => factKeys.has(key)) && Object.keys(facts.target).every((key) => modelRefKeys.has(key)))
    && Object.isFrozen(snapshot)
    && Object.isFrozen(snapshot.authFailedProviderIds) && Object.isFrozen(snapshot.baseline) && Object.isFrozen(snapshot.models)
    && snapshot.models.every((facts) => Object.isFrozen(facts) && Object.isFrozen(facts.target) && Object.isFrozen(facts.capabilities))
    && routingSnapshotDigest(snapshot) === snapshot.snapshotDigest;
}
