import { expect, test } from "bun:test";
import { normalizeRoutingV2Config, validateRoutingV2ConfigLayer, type RoutingV2ConfigLayer } from "./config-v2";
import type { RoutingDecision, RoutingReason } from "./decision";
import type { ModelRef } from "./model-class";
import { resolveRoutingDecision } from "./resolver";
import type { RoutingRequest } from "./routing-request";
import { createRoutingSnapshot, type RoutingModelFacts } from "./snapshot";

const ref = (providerId: string, modelId: string): ModelRef => ({ providerId, modelId });
const baseline = ref("alpha", "standard-a");
function selectionOf(decision: RoutingDecision): ModelRef {
  if (decision.status !== "selected") throw new Error(`expected selected decision, received ${decision.status}`);
  return decision.selection;
}

function facts(target: ModelRef, patch: Partial<RoutingModelFacts> = {}): RoutingModelFacts {
  return {
    target,
    connected: true,
    credentialsAvailable: true,
    policyAllowed: true,
    parentAllowed: true,
    availability: "available",
    capabilities: ["tools", "vision", "structured-output"],
    contextLength: 100_000,
    cooldown: false,
    estimatedCostUsd: 1,
    observedLatencyMs: 100,
    ...patch,
  };
}

function request(patch: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    requestId: "r1",
    category: "review",
    origin: "review",
    baseline,
    requirements: { capabilities: [], inputTokensRequired: 1_000, outputTokensReserved: 1_000 },
    ...patch,
  };
}

function setup(layer: RoutingV2ConfigLayer, models: readonly RoutingModelFacts[], req = request(), authFailedProviderIds: readonly string[] = []) {
  const config = normalizeRoutingV2Config({ user: layer });
  const snapshot = createRoutingSnapshot({
    configDigest: config.configDigest,
    observedAt: "2026-11-04T00:00:00.000Z",
    catalogRevision: "catalog-v1",
    policyRevision: "policy-v1",
    capabilityRevision: "capabilities-v1",
    authFailedProviderIds,
    baseline: req.baseline,
    models,
  });
  return { config, snapshot, req };
}

const expertLayer = (candidates: readonly ModelRef[], fallbackClasses: readonly ("light" | "standard" | "expert" | "frontier")[] = []): RoutingV2ConfigLayer => ({
  schemaVersion: 2,
  classes: {
    expert: {
      candidates: candidates.map((target, index) => ({ target, enabled: true, priority: candidates.length - index })),
      selection: "priority",
      fallbackClasses,
    },
  },
  categories: { review: { mode: "class", modelClass: "expert" } },
});

test("absolute class selection does not change with the baseline provider", () => {
  const expert = ref("alpha", "expert-a");
  const layer = expertLayer([expert]);
  for (const current of [baseline, ref("beta", "standard-b")]) {
    const req = request({ baseline: current });
    const { config, snapshot } = setup(layer, [facts(current), facts(expert)], req);
    expect(selectionOf(resolveRoutingDecision(req, snapshot, config))).toEqual(expert);
  }
});

test("user override beats project configuration and an agent recommendation", () => {
  const chosen = ref("beta", "pinned");
  const config = normalizeRoutingV2Config({
    user: { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "light" } } },
    project: { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "expert" } } },
  });
  const req = request({ userOverride: { mode: "model", target: chosen }, recommendation: { modelClass: "light", source: "agent" } });
  const snapshot = createRoutingSnapshot({ configDigest: config.configDigest, observedAt: "2026-11-04T00:00:00.000Z", catalogRevision: "catalog-v1", policyRevision: "p1", capabilityRevision: "c1", authFailedProviderIds: [], baseline, models: [facts(baseline), facts(chosen)] });
  const decision = resolveRoutingDecision(req, snapshot, config);
  expect(decision.assignmentSource).toBe("user-override");
  expect(selectionOf(decision)).toEqual(chosen);
});

test("session-only scope follows a provider switch without rewriting pools", () => {
  const alpha = ref("alpha", "expert");
  const beta = ref("beta", "expert");
  const layer: RoutingV2ConfigLayer = {
    ...expertLayer([alpha, beta]),
    providers: { scope: "session-only", allowlist: [], preferSessionProvider: false },
  };
  const req = request({ baseline: beta });
  const { config, snapshot } = setup(layer, [facts(alpha), facts(beta)], req);
  expect(selectionOf(resolveRoutingDecision(req, snapshot, config))).toEqual(beta);
});

test("hard gates reject unavailable, unauthorized, incapable, and over-budget models", () => {
  const expert = ref("alpha", "expert");
  const layer: RoutingV2ConfigLayer = {
    ...expertLayer([expert]),
    execution: { maxAttempts: 3, selectionTimeoutMs: 3_000, maxEstimatedCostUsd: 2, unknownCost: "deny" },
  };
  const cases: Array<[Partial<RoutingModelFacts>, RoutingReason]> = [
    [{ credentialsAvailable: false }, "credentials-missing"],
    [{ availability: "unknown" }, "candidate-unverified"],
    [{ capabilities: [] }, "capability-missing"],
    [{ contextLength: 1_500 }, "context-insufficient"],
    [{ estimatedCostUsd: 3 }, "budget-exceeded"],
    [{ estimatedCostUsd: null }, "cost-unknown"],
    [{ estimatedCostUsd: Number.NaN }, "cost-unknown"],
  ];
  for (const [patch, reason] of cases) {
    const req = request({ requirements: { capabilities: ["tools"], inputTokensRequired: 1_000, outputTokensReserved: 1_000 } });
    const { config, snapshot } = setup(layer, [facts(expert, patch)], req);
    const decision = resolveRoutingDecision(req, snapshot, config);
    expect(decision.status).toBe("blocked");
    expect(decision.exclusions.at(-1)?.reason).toBe(reason);
  }
});

test("same-class fallback and tie breaking are deterministic", () => {
  const offline = ref("zeta", "offline");
  const a = ref("alpha", "a");
  const b = ref("beta", "b");
  const layer: RoutingV2ConfigLayer = {
    schemaVersion: 2,
    classes: { expert: { candidates: [offline, b, a].map((target, index) => ({ target, enabled: true, priority: index === 0 ? 100 : 10 })), selection: "priority", fallbackClasses: [] } },
    categories: { review: { mode: "class", modelClass: "expert" } },
  };
  const models = [facts(offline, { availability: "unavailable" }), facts(a), facts(b)];
  const { config, snapshot, req } = setup(layer, models);
  const first = resolveRoutingDecision(req, snapshot, config);
  const reordered = createRoutingSnapshot({ ...snapshot, models: [...models].reverse() });
  const second = resolveRoutingDecision(req, reordered, config);
  expect(selectionOf(first)).toEqual(a);
  expect(selectionOf(second)).toEqual(a);
  expect(first.exclusions).toContainEqual({ target: offline, modelClass: "expert", reason: "model-unavailable" });
  expect(first.fallbackReason).toBe("candidate-fallback");
});

test("class floor blocks a configured downgrade", () => {
  const light = ref("alpha", "light");
  const layer: RoutingV2ConfigLayer = {
    ...expertLayer([], ["light"]),
    classes: {
      expert: { candidates: [], selection: "priority", fallbackClasses: ["light"] },
      light: { candidates: [{ target: light, enabled: true, priority: 1 }], selection: "priority", fallbackClasses: [] },
    },
  };
  const req = request({ requirements: { capabilities: [], inputTokensRequired: 1, outputTokensReserved: 1, minimumClass: "expert" } });
  const { config, snapshot } = setup(layer, [facts(light)], req);
  const decision = resolveRoutingDecision(req, snapshot, config);
  expect(decision.status).toBe("blocked");
  expect(decision.exclusions).toContainEqual({ modelClass: "light", reason: "class-below-minimum" });
});

test("cross-class fallback records whether it escalated or downgraded", () => {
  const light = ref("alpha", "light");
  const layer: RoutingV2ConfigLayer = {
    schemaVersion: 2,
    classes: {
      expert: { candidates: [], selection: "priority", fallbackClasses: ["light"] },
      light: { candidates: [{ target: light, enabled: true, priority: 1 }], selection: "priority", fallbackClasses: [] },
    },
    categories: { review: { mode: "class", modelClass: "expert" } },
  };
  const configured = setup(layer, [facts(light)]);
  const decision = resolveRoutingDecision(configured.req, configured.snapshot, configured.config);
  expect(selectionOf(decision)).toEqual(light);
  expect(decision.fallbackReason).toBe("class-downgraded");
});

test("model pin remains strict unless it names a fallback class", () => {
  const gone = ref("alpha", "gone");
  const backup = ref("beta", "expert");
  const base = expertLayer([backup]);
  const strict = setup({ ...base, categories: { review: { mode: "model", target: gone } } }, [facts(gone, { availability: "unavailable" }), facts(backup)]);
  const fallback = setup({ ...base, categories: { review: { mode: "model", target: gone, fallbackClass: "expert" } } }, [facts(gone, { availability: "unavailable" }), facts(backup)]);
  expect(resolveRoutingDecision(strict.req, strict.snapshot, strict.config).status).toBe("blocked");
  const fallbackDecision = resolveRoutingDecision(fallback.req, fallback.snapshot, fallback.config);
  expect(selectionOf(fallbackDecision)).toEqual(backup);
  expect(fallbackDecision.fallbackReason).toBe("pin-fallback");
});

test("normalization replaces classes atomically and rejects duplicate or self fallbacks", () => {
  const one = ref("alpha", "one");
  const two = ref("beta", "two");
  const config = normalizeRoutingV2Config({
    user: { schemaVersion: 2, classes: { expert: { candidates: [{ target: one, enabled: true, priority: 1 }], selection: "cost", fallbackClasses: [] } } },
    project: { schemaVersion: 2, classes: { expert: { candidates: [{ target: two, enabled: true, priority: 2 }], selection: "latency", fallbackClasses: [] } } },
  });
  expect(config.classes.expert.candidates).toEqual([{ target: two, enabled: true, priority: 2 }]);
  expect(config.classes.expert.selection).toBe("latency");
  expect(() => normalizeRoutingV2Config({ user: { schemaVersion: 2, classes: { expert: { candidates: [], selection: "priority", fallbackClasses: ["expert"] } } } })).toThrow();
  expect(() => normalizeRoutingV2Config({ user: { schemaVersion: 2, classes: { expert: { candidates: [{ target: one, enabled: true, priority: 1 }, { target: one, enabled: true, priority: 2 }], selection: "priority", fallbackClasses: [] } } } })).toThrow();
  const cyclicLayer: RoutingV2ConfigLayer = { schemaVersion: 2, classes: {
      expert: { candidates: [], selection: "priority", fallbackClasses: ["standard"] },
      standard: { candidates: [], selection: "priority", fallbackClasses: ["expert"] },
    } };
  expect(validateRoutingV2ConfigLayer(cyclicLayer).ok).toBeFalse();
  expect(() => normalizeRoutingV2Config({ user: cyclicLayer })).toThrow(/cycle/);
  const classifierLayer: RoutingV2ConfigLayer = {
    schemaVersion: 2,
    classifier: { chain: [{ adapterId: "jev" }], timeoutMs: 1_000, minConfidence: 0.7, onFailure: { mode: "baseline" } },
  };
  expect(validateRoutingV2ConfigLayer(classifierLayer).ok).toBeFalse();
  expect(validateRoutingV2ConfigLayer(classifierLayer, { classifierAdapters: new Set(["jev"]) }).ok).toBeTrue();
  expect(() => normalizeRoutingV2Config({ user: classifierLayer })).toThrow(/registry/);
  expect(() => normalizeRoutingV2Config({ user: classifierLayer }, { classifierAdapters: new Set(["model"]) })).toThrow(/unregistered/);
  expect(normalizeRoutingV2Config({ user: classifierLayer }, { classifierAdapters: new Set(["jev"]) }).classifier.chain).toHaveLength(1);
  const untargetedModel = { ...classifierLayer, classifier: { ...classifierLayer.classifier!, chain: [{ adapterId: "model" }] } };
  expect(() => normalizeRoutingV2Config({ user: untargetedModel }, { classifierAdapters: new Set(["model"]) })).toThrow(/explicit target/);
});

test("auto waits for classification and applies fallback only after explicit failure", () => {
  const expert = ref("alpha", "expert");
  const layer: RoutingV2ConfigLayer = {
    ...expertLayer([expert]),
    categories: { review: { mode: "auto" } },
    classifier: { chain: [], timeoutMs: 1_000, minConfidence: 0.7, onFailure: { mode: "class", modelClass: "expert" } },
  };
  const pending = setup(layer, [facts(expert)]);
  expect(resolveRoutingDecision(pending.req, pending.snapshot, pending.config).status).toBe("needs-classification");
  const failedRequest = request({ classification: { status: "failed", receiptId: "classifier-1" } });
  const failed = setup(layer, [facts(expert)], failedRequest);
  const decision = resolveRoutingDecision(failedRequest, failed.snapshot, failed.config);
  expect(selectionOf(decision)).toEqual(expert);
  expect(decision.recommendationSource).toBe("classifier-fallback");
  expect(decision.classifierReceiptId).toBe("classifier-1");
  expect(decision.fallbackReason).toBe("classifier-fallback");

  const overrideAuto = request({ userOverride: { mode: "auto" }, recommendation: { modelClass: "expert", source: "agent" } });
  const override = setup(layer, [facts(expert)], overrideAuto);
  const overrideDecision = resolveRoutingDecision(overrideAuto, override.snapshot, override.config);
  expect(selectionOf(overrideDecision)).toEqual(expert);
  expect(overrideDecision.assignmentSource).toBe("user-override");
  expect(overrideDecision.recommendationSource).toBe("agent");

  const explicit = setup(expertLayer([expert]), [facts(expert)], request({ classification: { status: "failed", receiptId: "preserved" } }));
  expect(resolveRoutingDecision(explicit.req, explicit.snapshot, explicit.config).classifierReceiptId).toBe("preserved");
  const classifiedExplicit = setup(expertLayer([expert]), [facts(expert)], request({ recommendation: { modelClass: "light", source: "classifier", receiptId: "classified-preserved" } }));
  expect(resolveRoutingDecision(classifiedExplicit.req, classifiedExplicit.snapshot, classifiedExplicit.config).classifierReceiptId).toBe("classified-preserved");
});

test("confirmed provider authentication failure wins over missing candidate facts", () => {
  const expert = ref("broken", "expert");
  const configured = setup(expertLayer([expert]), [], request(), ["broken"]);
  const decision = resolveRoutingDecision(configured.req, configured.snapshot, configured.config);
  expect(decision.status).toBe("blocked");
  expect(decision.exclusions).toContainEqual({ target: expert, modelClass: "expert", reason: "auth-failed" });
});

test("validation rejects schema drift at every nested boundary", () => {
  const invalid = [
    { schemaVersion: 2, unknown: true },
    { schemaVersion: 2, categories: { review: { mode: "auto", extra: true } } },
    { schemaVersion: 2, classes: { expert: { candidates: [{ target: baseline, enabled: 1, priority: 1 }], selection: "priority", fallbackClasses: [] } } },
    { schemaVersion: 2, providers: { scope: "allowlist", allowlist: [], preferSessionProvider: true } },
    { schemaVersion: 2, classifier: { chain: [], timeoutMs: 0, minConfidence: 2, onFailure: { mode: "auto" } } },
    { schemaVersion: 2, execution: { maxAttempts: 11, selectionTimeoutMs: 0, maxEstimatedCostUsd: Number.NaN, unknownCost: "maybe" } },
  ];
  for (const value of invalid) expect(validateRoutingV2ConfigLayer(value).ok).toBeFalse();
});

test("normalization takes immutable copies and decisions include request semantics", () => {
  const expert = ref("alpha", "expert");
  const candidates = [{ target: expert, enabled: true, priority: 1 }];
  const layer: RoutingV2ConfigLayer = {
    schemaVersion: 2,
    classes: { expert: { candidates, selection: "priority", fallbackClasses: [] } },
    categories: { review: { mode: "class", modelClass: "expert" } },
  };
  const configured = setup(layer, [facts(expert)]);
  candidates[0]!.priority = 99;
  expect(configured.config.classes.expert.candidates[0]!.priority).toBe(1);
  expect(Object.isFrozen(configured.config.classes.expert.candidates)).toBeTrue();
  const mutableFacts = { ...facts(expert) };
  const frozenSnapshot = setup(layer, [mutableFacts]).snapshot;
  mutableFacts.policyAllowed = false;
  expect(frozenSnapshot.models[0]!.policyAllowed).toBeTrue();
  expect(Object.isFrozen(frozenSnapshot.models[0]!.capabilities)).toBeTrue();
  const tools = request({ parentDecisionId: "parent-1", requirements: { capabilities: ["tools"], inputTokensRequired: 1, outputTokensReserved: 1 } });
  const vision = request({ requirements: { capabilities: ["vision"], inputTokensRequired: 1, outputTokensReserved: 1 } });
  const toolsSetup = setup(layer, [facts(expert)], tools);
  const visionSetup = setup(layer, [facts(expert)], vision);
  const toolsDecision = resolveRoutingDecision(tools, toolsSetup.snapshot, toolsSetup.config);
  expect(toolsDecision.parentDecisionId).toBe("parent-1");
  expect(toolsDecision.decisionId).not.toBe(resolveRoutingDecision(vision, visionSetup.snapshot, visionSetup.config).decisionId);
});

test("invalid or duplicate snapshot facts fail closed", () => {
  const expert = ref("alpha", "expert");
  const configured = setup(expertLayer([expert]), [facts(expert)], request({ requirements: { capabilities: [], inputTokensRequired: 0, outputTokensReserved: 0 } }));
  expect(() => createRoutingSnapshot({ ...configured.snapshot, models: [facts(expert, { contextLength: Number.NaN })] })).toThrow();
  const duplicate = { ...configured.snapshot, models: [facts(expert), facts(expert)] };
  const decision = resolveRoutingDecision(configured.req, duplicate, configured.config);
  expect(decision.status).toBe("blocked");
  if (decision.status === "blocked") expect(decision.reason).toBe("config-invalid");
  const tampered = Object.freeze({ ...configured.snapshot, policyRevision: "policy-v2" });
  const tamperedDecision = resolveRoutingDecision(configured.req, tampered, configured.config);
  expect(tamperedDecision.status).toBe("blocked");
  if (tamperedDecision.status === "blocked") expect(tamperedDecision.reason).toBe("config-invalid");
});
