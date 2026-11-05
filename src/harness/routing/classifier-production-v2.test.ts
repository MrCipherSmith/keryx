import { expect, test } from "bun:test";
import { normalizeRoutingV2Config } from "./config-v2";
import { DEFAULT_JEV_ROUTING_TARGET } from "./classifier-adapters-v2";
import { buildRoutingClassifierAdapters, ROUTING_CLASSIFIER_ADAPTER_REGISTRY } from "./classifier-production-v2";

test("production classifier registry exposes only implemented adapter ids", () => {
  expect([...ROUTING_CLASSIFIER_ADAPTER_REGISTRY]).toEqual(["jev", "model"]);
});

test("production classifier builder checks the actual default JEV target", () => {
  const checked: Array<{ providerId: string; modelId: string }> = [];
  const config = normalizeRoutingV2Config({ user: {
    schemaVersion: 2,
    classifier: {
      chain: [{ adapterId: "jev" }],
      timeoutMs: 3_000,
      minConfidence: 0.7,
      onFailure: { mode: "baseline" },
    },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const [adapter] = buildRoutingClassifierAdapters({
    config,
    sessionProvider: "ollama",
    fallbackModel: { providerId: "ollama", modelId: "session" },
    env: {},
    jevEnabled: true,
    externalAllowed(providerId, modelId) {
      checked.push({ providerId, modelId });
      return false;
    },
  });

  expect(checked).toEqual([DEFAULT_JEV_ROUTING_TARGET]);
  expect(adapter?.id).toBe("jev");
});

test("production classifier builder keeps provider scope and caller policy fail-closed", async () => {
  const config = normalizeRoutingV2Config({ user: {
    schemaVersion: 2,
    providers: { scope: "session-only", allowlist: [], preferSessionProvider: false },
    classifier: {
      chain: [{ adapterId: "model", target: { providerId: "anthropic", modelId: "classifier" } }],
      timeoutMs: 3_000,
      minConfidence: 0.7,
      onFailure: { mode: "baseline" },
    },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const [adapter] = buildRoutingClassifierAdapters({
    config,
    sessionProvider: "ollama",
    env: { ANTHROPIC_API_KEY: "test-only" },
    jevEnabled: true,
    externalAllowed: () => true,
  });

  await expect(adapter!.classify("task", { signal: new AbortController().signal })).rejects.toThrow("unavailable or denied");
});

test("production JEV adapter pins the service provider and forwards the configured model", async () => {
  const bodies: unknown[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as unknown);
    return new Response(JSON.stringify({ answers: {
      category: { type: "choice", choice: "review" },
      modelClass: { type: "choice", choice: "expert" },
      confidence: { type: "noul", noul: 0.9 },
      tools: { type: "noul", noul: 0 },
      vision: { type: "noul", noul: 0 },
      structuredOutput: { type: "noul", noul: 0 },
    }, usage: {} }), { status: 200 });
  }) as typeof fetch;
  const config = normalizeRoutingV2Config({ user: {
    schemaVersion: 2,
    classifier: {
      chain: [{ adapterId: "jev", target: { providerId: "openrouter", modelId: "jev-custom" } }],
      timeoutMs: 3_000,
      minConfidence: 0.7,
      onFailure: { mode: "baseline" },
    },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const [adapter] = buildRoutingClassifierAdapters({
    config,
    sessionProvider: "openrouter",
    env: { OPENROUTER_API_KEY: "test-only" },
    jevEnabled: true,
    externalAllowed: () => true,
    fetch: fetchFn,
  });

  await adapter!.classify("review it", { signal: new AbortController().signal });
  expect(bodies).toEqual([expect.objectContaining({ model: "jev-custom" })]);

  const deniedConfig = normalizeRoutingV2Config({ user: {
    schemaVersion: 2,
    classifier: {
      chain: [{ adapterId: "jev", target: { providerId: "anthropic", modelId: "jev-custom" } }],
      timeoutMs: 3_000,
      minConfidence: 0.7,
      onFailure: { mode: "baseline" },
    },
  } }, { classifierAdapters: ROUTING_CLASSIFIER_ADAPTER_REGISTRY });
  const [denied] = buildRoutingClassifierAdapters({
    config: deniedConfig,
    sessionProvider: "anthropic",
    env: { OPENROUTER_API_KEY: "test-only", ANTHROPIC_API_KEY: "test-only" },
    jevEnabled: true,
    externalAllowed: () => true,
  });
  await expect(denied!.classify("review it", { signal: new AbortController().signal })).rejects.toThrow("unavailable or denied");
});
