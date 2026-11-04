import { normalizeRoutingV2Config, type NormalizedRoutingV2Config } from "./config-v2";
import { ROUTING_CLASSIFIER_ADAPTER_REGISTRY } from "./classifier-production-v2";
import { readActiveRoutingV2Layers } from "./migration-v2";

/**
 * Read one activation snapshot. Absence or an explicit rollback selects legacy.
 * An inconsistent active snapshot throws so callers cannot silently bypass it.
 */
export function loadActiveRoutingV2(cwd: string, configDir?: string): NormalizedRoutingV2Config | undefined {
  const normalization = {
    classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY,
  };
  const layers = readActiveRoutingV2Layers(cwd, configDir, normalization);
  return layers === undefined ? undefined : normalizeRoutingV2Config(layers, normalization);
}
