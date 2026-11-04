import { expect, test } from "bun:test";
import { RoutingFailureRegistry } from "./routing-failure-registry";
import { createRoutingSnapshot } from "./snapshot";

const target = { providerId: "provider", modelId: "model" };
function snapshot(catalogRevision: string) {
  return createRoutingSnapshot({
    configDigest: "config",
    observedAt: "2026-11-04T00:00:00.000Z",
    catalogRevision,
    policyRevision: "policy",
    capabilityRevision: "capability",
    authFailedProviderIds: [],
    baseline: target,
    models: [{ target, connected: true, credentialsAvailable: true, policyAllowed: true, parentAllowed: true, availability: "available", capabilities: [], contextLength: 10, cooldown: false, estimatedCostUsd: 0.1, observedLatencyMs: 1 }],
  });
}

test("model-not-found remains excluded only for the observed catalog revision", () => {
  const registry = new RoutingFailureRegistry();
  registry.recordModelNotFound(target, "catalog-a");
  expect(registry.apply(snapshot("catalog-a"), new Date("2026-11-04T00:00:01.000Z")).models[0]?.availability).toBe("unavailable");
  expect(registry.apply(snapshot("catalog-b"), new Date("2026-11-04T00:00:01.000Z")).models[0]?.availability).toBe("available");
});

test("rate-limit cooldown honors retry-after and expires", () => {
  const registry = new RoutingFailureRegistry();
  registry.recordRateLimit(target, "catalog", 5_000, new Date("2026-11-04T00:00:00.000Z"));
  expect(registry.apply(snapshot("catalog"), new Date("2026-11-04T00:00:04.000Z")).models[0]?.cooldown).toBe(true);
  expect(registry.apply(snapshot("catalog"), new Date("2026-11-04T00:00:06.000Z")).models[0]?.cooldown).toBe(false);
});

test("authentication failures persist until explicitly cleared", () => {
  const registry = new RoutingFailureRegistry();
  registry.recordAuthFailure("provider");
  expect(registry.apply(snapshot("catalog"), new Date("2026-11-04T00:00:01.000Z")).authFailedProviderIds).toEqual(["provider"]);
  registry.clearAuthFailure("provider");
  expect(registry.apply(snapshot("catalog"), new Date("2026-11-04T00:00:02.000Z")).authFailedProviderIds).toEqual([]);
});
