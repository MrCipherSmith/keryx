import { expect, test } from "bun:test";
import { normalizeRoutingV2Config } from "./config-v2";
import { RoutingBudgetLedger } from "./routing-budget";
import { runRoutingClassification } from "./routing-classifier-service";
import type { RoutingRequest } from "./routing-request";
import { ROUTING_CLASSIFIER_ADAPTER_REGISTRY } from "./classifier-production-v2";

const request: RoutingRequest = {
  requestId: "request",
  category: "default",
  origin: "operator",
  baseline: { providerId: "provider", modelId: "baseline" },
  requirements: { capabilities: [], inputTokensRequired: 10, outputTokensReserved: 10 },
};

test("canonical classifier service builds a bound recommendation once", async () => {
  const config = normalizeRoutingV2Config({ user: {
    schemaVersion: 2,
    classifier: { chain: [{ adapterId: "model", target: { providerId: "provider", modelId: "classifier" } }], timeoutMs: 3_000, minConfidence: 0.7, onFailure: { mode: "baseline" } },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const result = await runRoutingClassification({
    task: "implement it",
    request,
    config,
    adapters: [{ id: "model", classify: async () => ({ category: "coding", modelClass: "expert", confidence: 0.9, reasonCode: "coding", requiredCapabilities: ["tools"] }) }],
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    estimatedCostUsd: () => 0.1,
  });
  expect(result.status).toBe("ready");
  if (result.status !== "ready" || result.classification.status !== "classified") return;
  expect(result.request.category).toBe("coding");
  expect(result.request.recommendation).toEqual({ modelClass: "expert", source: "classifier", receiptId: result.classification.receiptId });
  expect(result.request.requirements.capabilities).toEqual(["tools"]);
});
