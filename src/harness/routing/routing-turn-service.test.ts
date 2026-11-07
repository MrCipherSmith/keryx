import { expect, test } from "bun:test";
import { normalizeRoutingConfig } from "./config";
import { ROUTING_CLASSIFIER_ADAPTER_REGISTRY } from "./classifier-production";
import type { ModelProfile } from "./model-profile";
import { profileKey } from "./model-profile";
import type { RoutingRequest } from "./routing-request";
import { routeTurn } from "./routing-turn-service";

const baseline = { providerId: "provider", modelId: "baseline" } as const;
const request: RoutingRequest = {
  requestId: "turn-1",
  category: "default",
  origin: "operator",
  baseline,
  requirements: { capabilities: ["tools"], inputTokensRequired: 100, outputTokensReserved: 50 },
};
const profile: ModelProfile = {
  ...baseline,
  strengthTier: { value: "standard", source: "operator" },
  priceInputPerMillion: { value: 2, source: "operator" },
  priceOutputPerMillion: { value: 8, source: "operator" },
  contextLength: { value: 100_000, source: "operator" },
  priority: { value: 1, source: "operator" },
  available: true,
  chatCapable: true,
  lastSeenAt: "2026-11-04T00:00:00.000Z",
  refreshedAt: "2026-11-04T00:00:00.000Z",
};

test("neutral turn service owns the frozen snapshot, shared budget, and runtime receipt", async () => {
  const config = normalizeRoutingConfig({ user: {
    schemaVersion: 2,
    categories: { default: { mode: "baseline" } },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const result = await routeTurn({
    task: "answer with tools",
    request,
    config,
    providers: [{ name: baseline.providerId, models: [baseline.modelId] }],
    profiles: { [profileKey(baseline.providerId, baseline.modelId)]: profile },
    snapshotMeta: {
      observedAt: "2026-11-04T00:01:00.000Z",
      policyRevision: "policy-v1",
      capabilityRevision: "capabilities-v1",
    },
    snapshotPolicy: {
      credentialsAvailable: () => true,
      policyAllowed: () => true,
      parentAllowed: () => true,
      capabilities: () => ["tools"],
      cooldown: () => false,
      observedLatencyMs: () => null,
      availability: () => "available",
    },
    classifier: {
      adapterInput: {
        sessionProvider: baseline.providerId,
        env: {},
        jevEnabled: false,
        externalAllowed: () => true,
      },
      estimatedCostUsd: () => 0,
    },
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready") return;
  expect(result.classification).toBeUndefined();
  expect(result.receipt.decision).toMatchObject({ status: "selected", selection: baseline });
  expect(result.snapshot.models[0]?.capabilities).toEqual(["tools"]);
  expect(result.budget.snapshot()).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
});
