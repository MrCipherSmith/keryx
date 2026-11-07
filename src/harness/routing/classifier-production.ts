import { hasCredential, type ProviderFactory } from "../provider/single-turn";
import type { NormalizedRoutingConfig } from "./config";
import {
  DEFAULT_JEV_ROUTING_TARGET,
  jevRoutingClassifierAdapter,
  mainModelRoutingClassifierAdapter,
} from "./classifier-adapters";
import type { RoutingClassifierAdapter } from "./classifier-chain";
import type { ModelRef } from "./model-class";
import { resolveJevClassifierCredential } from "../decision/jev-classifier";

export const ROUTING_CLASSIFIER_ADAPTER_REGISTRY: ReadonlySet<string> = new Set(["jev", "model"]);

export interface BuildRoutingClassifierAdaptersInput {
  readonly config: NormalizedRoutingConfig;
  readonly sessionProvider: string;
  readonly fallbackModel?: ModelRef;
  readonly env: Record<string, string | undefined>;
  readonly jevEnabled: boolean;
  readonly jevAllowed?: boolean;
  readonly externalAllowed: (providerId: string, modelId: string) => boolean;
  readonly classifierAllowed?: (providerId: string, modelId: string) => boolean;
  readonly fetch?: typeof fetch;
  readonly providerFactory?: ProviderFactory;
  readonly userConfigDir?: string;
  readonly timeoutMs?: number;
}

function providerAllowed(config: NormalizedRoutingConfig, sessionProvider: string, providerId: string): boolean {
  if (config.providers.scope === "all-connected") return true;
  if (config.providers.scope === "session-only") return providerId === sessionProvider;
  return config.providers.allowlist.includes(providerId);
}

function unavailableAdapter(id: string): RoutingClassifierAdapter<string> {
  return {
    id,
    async classify() {
      throw new Error("classifier adapter is unavailable or denied");
    },
  };
}

/** Build the configured classifier chain without widening provider or caller policy. */
export function buildRoutingClassifierAdapters(
  input: BuildRoutingClassifierAdaptersInput,
): RoutingClassifierAdapter<string>[] {
  return input.config.classifier.chain.map((entry) => {
    if (entry.adapterId === "jev") {
      const target = entry.target ?? DEFAULT_JEV_ROUTING_TARGET;
      const denied = target.providerId !== DEFAULT_JEV_ROUTING_TARGET.providerId
        || input.jevEnabled !== true
        || input.jevAllowed === false
        || target.providerId !== DEFAULT_JEV_ROUTING_TARGET.providerId
        || !providerAllowed(input.config, input.sessionProvider, target.providerId)
        || !input.externalAllowed(target.providerId, target.modelId)
        || !(input.classifierAllowed?.(target.providerId, target.modelId) ?? true)
        || resolveJevClassifierCredential(input.env, input.userConfigDir).key === undefined;
      if (denied) return unavailableAdapter(entry.adapterId);
      return jevRoutingClassifierAdapter(entry.adapterId, {
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        env: input.env,
        ...(input.userConfigDir === undefined ? {} : { dir: input.userConfigDir }),
        model: target.modelId,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
    }

    if (entry.adapterId !== "model") return unavailableAdapter(entry.adapterId);
    const target = entry.target;
    const denied = target === undefined
      || !providerAllowed(input.config, input.sessionProvider, target.providerId)
      || !input.externalAllowed(target.providerId, target.modelId)
      || !(input.classifierAllowed?.(target.providerId, target.modelId) ?? true)
      || (input.providerFactory === undefined && !hasCredential(target.providerId, input.env, input.userConfigDir));
    if (target === undefined || denied) return unavailableAdapter(entry.adapterId);
    return mainModelRoutingClassifierAdapter(entry.adapterId, {
      providerId: target.providerId,
      modelId: target.modelId,
      env: input.env,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.providerFactory === undefined ? {} : { providerFactory: input.providerFactory }),
    });
  });
}
