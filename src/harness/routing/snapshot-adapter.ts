import { routingV2Digest } from "./config-v2";
import type { ModelProfile } from "./model-profile";
import { profileKey } from "./model-profile";
import { modelRefKey, type ModelRef } from "./model-class";
import type { RoutingRequest } from "./routing-request";
import { createRoutingSnapshot, type RoutingModelFacts, type RoutingSnapshot } from "./snapshot";
import type { FlatPickerProvider } from "./table";

export interface RoutingSnapshotPolicy {
  credentialsAvailable(target: ModelRef): boolean;
  policyAllowed(target: ModelRef): boolean;
  parentAllowed(target: ModelRef): boolean;
  capabilities(target: ModelRef): RoutingModelFacts["capabilities"];
  cooldown(target: ModelRef): boolean;
  observedLatencyMs(target: ModelRef): number | null;
  /** A current authenticated session or bounded live probe may override catalogue age. */
  availability?(target: ModelRef): RoutingModelFacts["availability"] | undefined;
}

export interface BuildCatalogRoutingSnapshotOptions {
  readonly configDigest: string;
  /** One captured evaluation time for TTL checks and the frozen snapshot digest. */
  readonly observedAt: string;
  readonly catalogRevision?: string;
  readonly policyRevision: string;
  readonly capabilityRevision: string;
  readonly baseline: ModelRef;
  readonly providers: readonly FlatPickerProvider[];
  readonly profiles: Readonly<Record<string, ModelProfile>>;
  readonly request: RoutingRequest;
  readonly policy: RoutingSnapshotPolicy;
  readonly availabilityTtlMs?: number;
}

export const ROUTING_AVAILABILITY_TTL_MS = 5 * 60 * 1_000;

export function freshModelProfileAvailability(
  profile: ModelProfile | undefined,
  observedAt: string,
  ttlMs = ROUTING_AVAILABILITY_TTL_MS,
): RoutingModelFacts["availability"] {
  if (profile === undefined) return "unknown";
  const nowMs = Date.parse(observedAt);
  const profileObservedAt = Date.parse(profile.available ? profile.lastSeenAt : profile.refreshedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(profileObservedAt) || profileObservedAt > nowMs || nowMs - profileObservedAt > ttlMs) {
    return "unknown";
  }
  return profile.available ? "available" : "unavailable";
}

export function catalogRoutingRevision(
  providers: readonly FlatPickerProvider[],
  profiles: Readonly<Record<string, ModelProfile>>,
): string {
  return routingV2Digest({
    providers: providers.map((provider) => ({ ...provider, models: provider.models === undefined ? undefined : [...provider.models].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    profiles,
  });
}

function numericValue(field: ModelProfile["contextLength"]): number | null {
  return field.value === "unknown" ? null : field.value;
}

export function estimateModelCostUsd(
  profile: ModelProfile | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (profile === undefined) return null;
  const input = numericValue(profile.priceInputPerMillion);
  const output = numericValue(profile.priceOutputPerMillion);
  if (input === null || output === null) return null;
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

function estimatedCost(profile: ModelProfile | undefined, request: RoutingRequest): number | null {
  return estimateModelCostUsd(profile, request.requirements.inputTokensRequired, request.requirements.outputTokensReserved);
}


function observedAvailability(
  provider: FlatPickerProvider,
  profile: ModelProfile | undefined,
  nowMs: number,
  ttlMs: number,
): RoutingModelFacts["availability"] {
  if (provider.offline === true || !Number.isFinite(nowMs)) return "unknown";
  return freshModelProfileAvailability(profile, new Date(nowMs).toISOString(), ttlMs);
}

/**
 * Adapts the live provider picker catalogue to the pure v2 resolver snapshot.
 * Facts the catalogue cannot establish are supplied by the caller's policy
 * boundary. An offline catalogue row remains unknown even when its stored
 * profile was previously available.
 */
export function buildCatalogRoutingSnapshot(options: BuildCatalogRoutingSnapshotOptions): RoutingSnapshot {
  const ttlMs = options.availabilityTtlMs ?? ROUTING_AVAILABILITY_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("availabilityTtlMs must be a positive number");
  const nowMs = Date.parse(options.observedAt);
  if (!Number.isFinite(nowMs)) throw new Error("snapshot observedAt is invalid");
  const models: RoutingModelFacts[] = [];
  const seen = new Set<string>();
  for (const provider of options.providers) {
    if (provider.authFailed === true || provider.listUnavailable !== undefined) continue;
    for (const modelId of provider.models ?? []) {
      const target = { providerId: provider.name, modelId };
      const key = modelRefKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      const profile = options.profiles[profileKey(provider.name, modelId)];
      models.push({
        target,
        connected: provider.offline !== true,
        credentialsAvailable: options.policy.credentialsAvailable(target),
        policyAllowed: options.policy.policyAllowed(target),
        parentAllowed: options.policy.parentAllowed(target),
        availability: options.policy.availability?.(target) ?? observedAvailability(provider, profile, nowMs, ttlMs),
        capabilities: options.policy.capabilities(target),
        contextLength: profile === undefined ? null : numericValue(profile.contextLength),
        cooldown: options.policy.cooldown(target),
        estimatedCostUsd: estimatedCost(profile, options.request),
        observedLatencyMs: options.policy.observedLatencyMs(target),
      });
    }
  }
  const baselineKey = modelRefKey(options.baseline);
  if (!seen.has(baselineKey)) {
    const provider = options.providers.find((entry) => entry.name === options.baseline.providerId);
    if (provider !== undefined && provider.offline !== true && provider.authFailed !== true && provider.listUnavailable === undefined) {
      const profile = options.profiles[profileKey(options.baseline.providerId, options.baseline.modelId)];
      models.push({
        target: options.baseline,
        connected: true,
        credentialsAvailable: options.policy.credentialsAvailable(options.baseline),
        policyAllowed: options.policy.policyAllowed(options.baseline),
        parentAllowed: options.policy.parentAllowed(options.baseline),
        availability: options.policy.availability?.(options.baseline) ?? "available",
        capabilities: options.policy.capabilities(options.baseline),
        contextLength: profile === undefined ? null : numericValue(profile.contextLength),
        cooldown: options.policy.cooldown(options.baseline),
        estimatedCostUsd: estimatedCost(profile, options.request),
        observedLatencyMs: options.policy.observedLatencyMs(options.baseline),
      });
    }
  }
  return createRoutingSnapshot({
    configDigest: options.configDigest,
    observedAt: options.observedAt,
    catalogRevision: options.catalogRevision ?? catalogRoutingRevision(options.providers, options.profiles),
    policyRevision: options.policyRevision,
    capabilityRevision: options.capabilityRevision,
    authFailedProviderIds: [...new Set(options.providers.filter((provider) => provider.authFailed === true).map((provider) => provider.name))],
    baseline: options.baseline,
    models,
  });
}
