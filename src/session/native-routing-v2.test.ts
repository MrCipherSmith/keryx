import { expect, test } from "bun:test";
import { normalizeRoutingV2Config, type RoutingV2ConfigLayer } from "../harness/routing/config-v2";
import type { Control } from "../remote-control/protocol";
import { buildNativeRoutingV2Snapshot, resolveNativeRoutingV2 } from "./native-routing-v2";
import type { NativeModelBinding } from "./model-identity";

const digest = "a".repeat(64);

function candidate(candidateId: string, providerId: string, modelId: string, reasoningEfforts: Control["RoutingCandidate"]["reasoningEfforts"] = ["none"]): Control["RoutingCandidate"] {
  return { candidateId, providerId, modelId, reasoningEfforts, available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" };
}

function sessionConfig(candidateIds: readonly string[]): Control["SessionConfig"] {
  return { configVersion: 1, baselineCandidateId: candidateIds[0]!, reasoningEffort: "none", policyDigest: digest, capabilityDigest: digest,
    routing: { enabled: true, profileId: "local", candidateIds: [...candidateIds], fallbackCandidateId: candidateIds[0]! } };
}

function availability(candidates: readonly Control["RoutingCandidate"][]): Control["RoutingAvailability"] {
  return { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [...candidates] };
}

function binding(candidate: Control["RoutingCandidate"], actualProviderId = candidate.providerId, actualModelId = candidate.modelId): NativeModelBinding {
  return { providerId: candidate.providerId, modelId: candidate.modelId, actualProviderId, actualModelId };
}

function routingConfig(layer: RoutingV2ConfigLayer) {
  return normalizeRoutingV2Config({ project: layer });
}

test("native v2 never widens selection beyond the frozen candidate ids", () => {
  const baseline = candidate("baseline-id", "wire-a", "wire-standard");
  const deep = candidate("deep-id", "wire-a", "wire-deep");
  const outside = candidate("outside-id", "wire-b", "wire-frontier");
  const bindings = [binding(baseline, "anthropic", "standard"), binding(deep, "anthropic", "deep"), binding(outside, "other", "frontier")];
  const config = routingConfig({ schemaVersion: 2,
    categories: { coding: { mode: "class", modelClass: "expert" } },
    classes: { expert: { selection: "priority", fallbackClasses: [], candidates: [
      { target: { providerId: "other", modelId: "frontier" }, enabled: true, priority: 100 },
      { target: { providerId: "anthropic", modelId: "deep" }, enabled: true, priority: 10 },
    ] } } });
  const resolved = resolveNativeRoutingV2({ sessionConfig: sessionConfig([baseline.candidateId, deep.candidateId]), availability: availability([baseline, deep, outside]), bindings,
    routingConfig: config, request: { requestId: "request", category: "coding", origin: "native-session", requirements: { capabilities: [], inputTokensRequired: 0, outputTokensReserved: 0 } } });
  expect(resolved.decision.status).toBe("selected");
  expect(resolved.candidateId).toBe(deep.candidateId);
  expect(resolved.decision.exclusions).toContainEqual({ target: { providerId: "other", modelId: "frontier" }, modelClass: "expert", reason: "policy-denied" });
});

test("native v2 maps duplicate model ids by provider through the frozen binding tuple", () => {
  const baseline = candidate("baseline-id", "wire-a", "shared");
  const second = candidate("second-id", "wire-b", "shared");
  const config = routingConfig({ schemaVersion: 2,
    categories: { coding: { mode: "model", target: { providerId: "provider-b", modelId: "shared" } } } });
  const resolved = resolveNativeRoutingV2({ sessionConfig: sessionConfig([baseline.candidateId, second.candidateId]), availability: availability([baseline, second]),
    bindings: [binding(baseline, "provider-a", "shared"), binding(second, "provider-b", "shared")], routingConfig: config,
    request: { requestId: "request", category: "coding", origin: "native-session", requirements: { capabilities: [], inputTokensRequired: 0, outputTokensReserved: 0 } } });
  expect(resolved.candidateId).toBe(second.candidateId);
});

test("native v2 snapshot digest is independent of advertised candidate order", () => {
  const baseline = candidate("baseline-id", "wire-a", "standard");
  const second = candidate("second-id", "wire-b", "deep");
  const config = routingConfig({ schemaVersion: 2 });
  const options = { sessionConfig: sessionConfig([baseline.candidateId, second.candidateId]), bindings: [binding(baseline), binding(second)], routingConfig: config };
  const left = buildNativeRoutingV2Snapshot({ ...options, availability: availability([baseline, second]) });
  const right = buildNativeRoutingV2Snapshot({ ...options, availability: availability([second, baseline]) });
  expect(left.snapshot.snapshotDigest).toBe(right.snapshot.snapshotDigest);
});

test("native v2 excludes a candidate that does not allow the pinned reasoning effort", () => {
  const baseline = candidate("baseline-id", "wire-a", "standard");
  const deep = candidate("deep-id", "wire-a", "deep", ["high"]);
  const config = routingConfig({ schemaVersion: 2,
    categories: { coding: { mode: "class", modelClass: "expert" } },
    classes: {
      expert: { selection: "priority", fallbackClasses: ["standard"], candidates: [{ target: { providerId: "wire-a", modelId: "deep" }, enabled: true, priority: 10 }] },
      standard: { selection: "priority", fallbackClasses: [], candidates: [{ target: { providerId: "wire-a", modelId: "standard" }, enabled: true, priority: 10 }] },
    } });
  const resolved = resolveNativeRoutingV2({ sessionConfig: sessionConfig([baseline.candidateId, deep.candidateId]), availability: availability([baseline, deep]), bindings: [binding(baseline), binding(deep)], routingConfig: config,
    request: { requestId: "request", category: "coding", origin: "native-session", requirements: { capabilities: [], inputTokensRequired: 0, outputTokensReserved: 0 } } });
  expect(resolved.candidateId).toBe(baseline.candidateId);
  expect(resolved.decision.exclusions).toContainEqual({ target: { providerId: "wire-a", modelId: "deep" }, modelClass: "expert", reason: "model-unavailable" });
});
