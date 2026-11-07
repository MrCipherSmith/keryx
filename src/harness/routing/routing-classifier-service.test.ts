import { expect, mock, test } from "bun:test";
import { normalizeRoutingConfig } from "./config";
import { RoutingBudgetLedger } from "./routing-budget";
import { runProductionRoutingClassification, runRoutingClassification } from "./routing-classifier-service";
import type { RoutingRequest } from "./routing-request";
import { ROUTING_CLASSIFIER_ADAPTER_REGISTRY } from "./classifier-production";

const request: RoutingRequest = {
  requestId: "request",
  category: "default",
  origin: "operator",
  baseline: { providerId: "provider", modelId: "baseline" },
  requirements: { capabilities: [], inputTokensRequired: 10, outputTokensReserved: 10 },
};

test("canonical classifier service builds a bound recommendation once", async () => {
  const config = normalizeRoutingConfig({ user: {
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

test.each([0.9, 1])("positive caller allowance %s caps the classifier deadline", async (timeoutMs) => {
  const config = normalizeRoutingConfig({ user: {
    schemaVersion: 2,
    classifier: { chain: [{ adapterId: "model", target: { providerId: "provider", modelId: "classifier" } }], timeoutMs: 3_000, minConfidence: 0.7, onFailure: { mode: "baseline" } },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const result = await runRoutingClassification({
    task: "implement it",
    request,
    config,
    adapters: [{ id: "model", classify: async () => await new Promise<never>(() => {}) }],
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    estimatedCostUsd: () => 0,
    timeoutMs,
  });
  expect(result.status).toBe("ready");
  expect(result.classification).toMatchObject({
    status: "fallback",
    trace: [{ adapterId: "model", outcome: "timeout" }],
  });
});


test.each([0, -1])("exhausted caller allowance %s uses fallback without classifier work", async (timeoutMs) => {
  const config = normalizeRoutingConfig({ user: {
    schemaVersion: 2,
    classifier: { chain: [{ adapterId: "model", target: { providerId: "provider", modelId: "classifier" } }], timeoutMs: 3_000, minConfidence: 0.7, onFailure: { mode: "class", modelClass: "expert" } },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const classify = mock(async () => { throw new Error("expired classifier must not run"); });
  const estimatedCostUsd = mock(() => 0.1);
  const externalAllowed = mock(() => true);
  const providerFactory = mock(() => { throw new Error("expired classifier must not construct a provider"); });
  const input = {
    task: "implement it",
    request,
    config,
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    estimatedCostUsd,
    timeoutMs,
  };
  const direct = await runRoutingClassification({ ...input, adapters: [{ id: "model", classify }] });
  const production = await runProductionRoutingClassification({
    ...input,
    adapterInput: { sessionProvider: "provider", env: {}, jevEnabled: false, externalAllowed, providerFactory },
  });
  expect(direct).toEqual(production);
  expect(direct).toMatchObject({
    status: "ready",
    classification: { status: "fallback", assignment: { mode: "class", modelClass: "expert" }, trace: [] },
    request: { classification: { status: "failed" } },
  });
  expect(classify).not.toHaveBeenCalled();
  expect(estimatedCostUsd).not.toHaveBeenCalled();
  expect(externalAllowed).not.toHaveBeenCalled();
  expect(providerFactory).not.toHaveBeenCalled();
});

test("exhausted caller allowance preserves cancellation without constructing adapters", async () => {
  const config = normalizeRoutingConfig({ user: { schemaVersion: 2 } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const externalAllowed = mock(() => true);
  const result = await runProductionRoutingClassification({
    task: "cancelled",
    request,
    config,
    timeoutMs: 0,
    signal: AbortSignal.abort(),
    budget: new RoutingBudgetLedger({ unknownCost: "allow" }),
    estimatedCostUsd: () => 0,
    adapterInput: { sessionProvider: "provider", env: {}, jevEnabled: false, externalAllowed },
  });
  expect(result.status).toBe("cancelled");
  expect(externalAllowed).not.toHaveBeenCalled();
});
