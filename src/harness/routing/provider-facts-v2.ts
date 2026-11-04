import type { ProviderDescription } from "../provider/types";
import { routingV2Digest } from "./config-v2";
import { modelRefKey, type ModelRef } from "./model-class";
import type { RoutingCapability } from "./routing-request";

export interface ProviderRoutingFacts {
  readonly capabilityRevision: string;
  capabilities(target: ModelRef): readonly RoutingCapability[];
}

/** Freeze only capabilities explicitly reported by the provider runtime. */
export function inspectProviderRoutingFacts(
  targets: readonly ModelRef[],
  describe: (target: ModelRef) => ProviderDescription | undefined,
): ProviderRoutingFacts {
  const capabilities = new Map<string, readonly RoutingCapability[]>();
  const revisionRows: unknown[] = [];
  for (const target of [...targets].sort((left, right) => modelRefKey(left).localeCompare(modelRefKey(right)))) {
    const key = modelRefKey(target);
    if (capabilities.has(key)) continue;
    let description: ProviderDescription | undefined;
    try {
      description = describe(target);
    } catch {
      description = undefined;
    }
    const routed: RoutingCapability[] = [];
    if (description?.capabilities.toolCalls === true) routed.push("tools");
    if (description?.capabilities.vision === true) routed.push("vision");
    if (description?.capabilities.structuredOutput === true) routed.push("structured-output");
    capabilities.set(key, Object.freeze(routed));
    revisionRows.push({ target, descriptor: description?.descriptor ?? null, capabilities: description?.capabilities ?? null });
  }
  return Object.freeze({
    capabilityRevision: routingV2Digest(revisionRows),
    capabilities(target: ModelRef) {
      return capabilities.get(modelRefKey(target)) ?? [];
    },
  });
}

/** Stable revision over the actual allow/deny facts supplied to a snapshot. */
export function routingPolicyRevision(targets: readonly ModelRef[], facts: (target: ModelRef) => unknown): string {
  return routingV2Digest([...targets]
    .sort((left, right) => modelRefKey(left).localeCompare(modelRefKey(right)))
    .map((target) => ({ target, facts: facts(target) })));
}
