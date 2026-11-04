import type { ModelRef } from "./model-class";
import type { RoutingCapability } from "./routing-request";

export type RoutingAvailabilityV2 = "available" | "unavailable" | "unknown";

export interface RoutingModelFacts {
  readonly target: ModelRef;
  readonly connected: boolean;
  readonly credentialsAvailable: boolean;
  readonly policyAllowed: boolean;
  readonly parentAllowed: boolean;
  readonly availability: RoutingAvailabilityV2;
  readonly capabilities: readonly RoutingCapability[];
  readonly contextLength: number | null;
  readonly cooldown: boolean;
  readonly estimatedCostUsd: number | null;
  readonly observedLatencyMs: number | null;
}

export interface RoutingSnapshot {
  readonly configDigest: string;
  readonly snapshotDigest: string;
  readonly baseline: ModelRef;
  readonly models: readonly RoutingModelFacts[];
}
