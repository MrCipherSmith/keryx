import { routingV2Digest } from "./config-v2";
import type { ModelProfile } from "./model-profile";
import { profileKey } from "./model-profile";
import { modelRefKey, type ModelRef } from "./model-class";
import type { RoutingRequest } from "./routing-request";
import type { RoutingModelFacts, RoutingSnapshot } from "./snapshot";
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
  readonly baseline: ModelRef;
  readonly providers: readonly FlatPickerProvider[];
  readonly profiles: Readonly<Record<string, ModelProfile>>;
  readonly request: RoutingRequest;
  readonly policy: RoutingSnapshotPolicy;
  readonly now?: () => Date;
  readonly availabilityTtlMs?: number;
}

export const ROUTING_AVAILABILITY_TTL_MS = 5 * 60 * 1_000;

function numericValue(field: ModelProfile["contextLength"]): number | null {
  return field.value === "unknown" ? null : field.value;
}

function estimatedCost(profile: ModelProfile | undefined, request: RoutingRequest): number | null {
  if (profile === undefined) return null;
  const input = numericValue(profile.priceInputPerMillion);
  const output = numericValue(profile.priceOutputPerMillion);
  if (input === null || output === null) return null;
  return (request.requirements.inputTokensRequired * input + request.requirements.outputTokensReserved * output) / 1_000_000;
}

function snapshotDigest(configDigest: string, baseline: ModelRef, models: readonly RoutingModelFacts[]): string {
  return routingV2Digest({
    configDigest,
    baseline,
    models: [...models].sort((left, right) => modelRefKey(left.target).localeCompare(modelRefKey(right.target))),
  });
}

function observedAvailability(
  provider: FlatPickerProvider,
  profile: ModelProfile | undefined,
  nowMs: number,
  ttlMs: number,
): RoutingModelFacts["availability"] {
  if (provider.offline === true || profile === undefined) return "unknown";
  const observedAt = Date.parse(profile.available ? profile.lastSeenAt : profile.refreshedAt);
  if (!Number.isFinite(observedAt) || observedAt > nowMs || nowMs - observedAt > ttlMs) return "unknown";
  return profile.available ? "available" : "unavailable";
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
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(nowMs)) throw new Error("snapshot clock returned an invalid date");
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
  return {
    configDigest: options.configDigest,
    snapshotDigest: snapshotDigest(options.configDigest, options.baseline, models),
    baseline: options.baseline,
    models,
  };
}
