// Release 0 harness configuration type (flow 009, W7 / S1, R0-01).
//
// `HarnessConfig` mirrors the frozen `harness-config.schema.json` shape. The
// capability floor is governed by `enabled`: when false the harness performs a
// deterministic no-load (see `startRun`). `defaultProvider` / `defaultModel`
// are optional startup fallbacks a run input may omit.

/** Bounded execution limits, mirroring `harness-config.schema.json#/properties/limits`. */
export interface HarnessLimits {
  maxRunSeconds: number;
  maxConcurrentChildren: number;
  maxToolOutputBytes: number;
  maxRetries: number;
  maxModelOutputTokens?: number;
  totalBudgetTokens?: number;
}

/** Optional network policy, mirroring `harness-config.schema.json#/properties/network`. */
export interface HarnessNetworkPolicy {
  enabled: boolean;
  allowedHosts: string[];
}

export interface HarnessConfig {
  schemaVersion: number;
  enabled: boolean;
  defaultRole: string;
  /** Optional startup fallback provider (per harness-config schema). */
  defaultProvider?: string;
  /** Optional startup fallback model (per harness-config schema). */
  defaultModel?: string;
  policyProfile: string;
  persistSessions?: boolean;
  rolesRoot?: string;
  policiesRoot?: string;
  dataRoot?: string;
  limits: HarnessLimits;
  network?: HarnessNetworkPolicy;
}
