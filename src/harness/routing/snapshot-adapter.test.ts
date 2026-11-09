import { expect, test } from "bun:test";
import { catalogToFlatPickerProviders } from "../provider-catalog";
import { normalizeRoutingConfig } from "./config";
import { resolveRoutingDecision } from "./resolver";
import type { ModelProfile } from "./model-profile";
import { profileKey } from "./model-profile";
import type { RoutingRequest } from "./routing-request";
import { buildCatalogRoutingSnapshot, type RoutingSnapshotPolicy } from "./snapshot-adapter";

const request: RoutingRequest = {
  requestId: "preview-1",
  category: "review",
  origin: "operator",
  baseline: { providerId: "anthropic", modelId: "session" },
  requirements: { capabilities: [], inputTokensRequired: 2_000, outputTokensReserved: 1_000 },
};

const policy: RoutingSnapshotPolicy = {
  credentialsAvailable: () => true,
  policyAllowed: () => true,
  parentAllowed: () => true,
  capabilities: () => [],
  cooldown: () => false,
  observedLatencyMs: () => null,
};

const SNAPSHOT_META = {
  observedAt: "2026-11-04T00:04:00.000Z",
  catalogRevision: "catalog-v1",
  policyRevision: "policy-v1",
  capabilityRevision: "capabilities-v1",
} as const;

function profile(providerId: string, modelId: string, available = true): ModelProfile {
  return {
    providerId,
    modelId,
    strengthTier: { value: "standard", source: "operator" },
    priceInputPerMillion: { value: 2, source: "operator" },
    priceOutputPerMillion: { value: 8, source: "operator" },
    contextLength: { value: 100_000, source: "operator" },
    priority: { value: 1, source: "operator" },
    available,
    chatCapable: true,
    lastSeenAt: "2026-11-04T00:00:00.000Z",
    refreshedAt: "2026-11-04T00:00:00.000Z",
  };
}

test("catalog snapshot keeps providers distinct and derives request cost from profile prices", () => {
  const profiles = Object.fromEntries([
    ["anthropic", "same"],
    ["openrouter", "same"],
  ].map(([providerId, modelId]) => [profileKey(providerId!, modelId!), profile(providerId!, modelId!)]));
  const snapshot = buildCatalogRoutingSnapshot({
    ...SNAPSHOT_META,
    configDigest: "config",
    baseline: request.baseline,
    providers: [{ name: "anthropic", models: ["same"] }, { name: "openrouter", models: ["same"] }],
    profiles,
    request,
    policy,
  });
  expect(snapshot.models.map((entry) => entry.target)).toEqual([
    { providerId: "anthropic", modelId: "same" },
    { providerId: "openrouter", modelId: "same" },
    request.baseline,
  ]);
  expect(snapshot.models[0]!.estimatedCostUsd).toBeCloseTo(0.012);
  expect(snapshot.snapshotDigest).toHaveLength(64);
});

test("offline rows remain unknown and status-only providers never invent models", () => {
  const stored = profile("offline", "old");
  const snapshot = buildCatalogRoutingSnapshot({
    ...SNAPSHOT_META,
    configDigest: "config",
    baseline: request.baseline,
    providers: [
      { name: "offline", models: ["old"], offline: true },
      { name: "broken", authFailed: true },
      { name: "missing", listUnavailable: "timed out" },
    ],
    profiles: { [profileKey("offline", "old")]: stored },
    request,
    policy,
  });
  expect(snapshot.models).toHaveLength(1);
  expect(snapshot.models[0]).toMatchObject({ connected: true, availability: "unknown" });
  expect(snapshot.authFailedProviderIds).toEqual(["broken"]);
});

test("snapshot digest is independent of provider catalogue order", () => {
  const providers = [{ name: "b", models: ["m"] }, { name: "a", models: ["m"] }];
  const profiles = Object.fromEntries(providers.map(({ name }) => [profileKey(name, "m"), profile(name, "m")]));
  const input = { ...SNAPSHOT_META, configDigest: "config", baseline: request.baseline, profiles, request, policy };
  const left = buildCatalogRoutingSnapshot({ ...input, providers });
  const right = buildCatalogRoutingSnapshot({ ...input, providers: [...providers].reverse() });
  expect(left.snapshotDigest).toBe(right.snapshotDigest);
  const changedPolicy = buildCatalogRoutingSnapshot({ ...input, providers, policyRevision: "policy-v2" });
  const changedTime = buildCatalogRoutingSnapshot({ ...input, providers, observedAt: "2026-11-04T00:04:01.000Z" });
  expect(changedPolicy.snapshotDigest).not.toBe(left.snapshotDigest);
  expect(changedTime.snapshotDigest).not.toBe(left.snapshotDigest);
  expect(Object.isFrozen(left)).toBeTrue();
  expect(Object.isFrozen(left.models)).toBeTrue();
});

test("authenticated baseline is injected when its live provider row omits models", () => {
  const snapshot = buildCatalogRoutingSnapshot({
    ...SNAPSHOT_META,
    configDigest: "config",
    baseline: request.baseline,
    providers: [{ name: "anthropic" }],
    profiles: {},
    request,
    policy,
  });

  expect(snapshot.models).toEqual([{
    target: request.baseline,
    connected: true,
    credentialsAvailable: true,
    policyAllowed: true,
    parentAllowed: true,
    availability: "available",
    capabilities: [],
    contextLength: null,
    cooldown: false,
    estimatedCostUsd: null,
    observedLatencyMs: null,
  }]);
});

test("availability expires after five minutes without changing connection identity", () => {
  const available = profile("alpha", "fresh");
  const unavailable = { ...profile("alpha", "gone", false), refreshedAt: "2026-11-04T00:00:00.000Z" };
  const input = {
    ...SNAPSHOT_META,
    configDigest: "config",
    baseline: request.baseline,
    providers: [{ name: "alpha", models: ["fresh", "gone"] }],
    profiles: {
      [profileKey("alpha", "fresh")]: available,
      [profileKey("alpha", "gone")]: unavailable,
    },
    request,
    policy,
  };
  const fresh = buildCatalogRoutingSnapshot(input);
  expect(fresh.models.map((entry) => entry.availability)).toEqual(["available", "unavailable"]);

  const stale = buildCatalogRoutingSnapshot({ ...input, observedAt: "2026-11-04T00:05:00.001Z" });
  expect(stale.models).toEqual(fresh.models.map((entry) => ({ ...entry, availability: "unknown" })));
  expect(stale.models.every((entry) => entry.connected)).toBe(true);
});

test("fresh live listings establish availability independently of profile refresh", () => {
  const observedAt = "2026-11-04T00:10:00.000Z";
  const listedAt = "2026-11-04T00:09:00.000Z";
  const input = {
    ...SNAPSHOT_META,
    observedAt,
    configDigest: "config",
    baseline: request.baseline,
    profiles: {
      [profileKey("alpha", "stale")]: profile("alpha", "stale"),
      [profileKey("alpha", "removed")]: { ...profile("alpha", "removed", false), refreshedAt: observedAt },
    },
    request,
    policy,
  };
  const models = ["stale", "no-profile", "removed"];
  const provider = { name: "alpha", models, observedAt: listedAt };
  const availability = (entry: typeof provider & { offline?: boolean }) =>
    buildCatalogRoutingSnapshot({ ...input, providers: [entry] }).models.map((model) => model.availability);
  expect(availability(provider)).toEqual(["available", "available", "unavailable"]);
  expect(availability({ ...provider, offline: true })).toEqual(["unknown", "unknown", "unknown"]);
  expect(availability({ ...provider, observedAt: "2026-11-04T00:04:00.000Z" }))
    .toEqual(["unknown", "unknown", "unavailable"]);
});

for (const models of [["session", "other"], ["other"]]) {
  test(`offline catalog retains baseline connection: ${models.join(",")}`, () => {
    const config = normalizeRoutingConfig({ user: { schemaVersion: 2, categories: { review: { mode: "baseline" } } } });
    const providers = catalogToFlatPickerProviders({
      fetchedAt: SNAPSHOT_META.observedAt,
      providers: { anthropic: { name: "anthropic", status: "not-supported", models: [], fallbackModels: models, fetchedAt: SNAPSHOT_META.observedAt } },
    });
    const snapshot = buildCatalogRoutingSnapshot({
      ...SNAPSHOT_META,
      configDigest: config.configDigest, baseline: request.baseline, request, policy,
      providers,
      profiles: {},
    });
    expect(snapshot.models.find((entry) => entry.target.modelId === "session"))
      .toMatchObject({ connected: true, availability: "unknown", credentialsAvailable: true });
    expect(snapshot.models.find((entry) => entry.target.modelId === "other"))
      .toMatchObject({ connected: true, availability: "unknown" });
    expect(resolveRoutingDecision(request, snapshot, config)).toMatchObject({ status: "selected", selection: request.baseline });
    const alternate = { ...request, userOverride: { mode: "model" as const, target: { providerId: "anthropic", modelId: "other" } } };
    expect(resolveRoutingDecision(alternate, snapshot, config)).toMatchObject({ status: "blocked", reason: "candidate-unverified" });
  });
}

test("offline baseline retains credential and auth-failure gates", () => {
  const config = normalizeRoutingConfig({ user: { schemaVersion: 2, categories: { review: { mode: "baseline" } } } });
  for (const authFailed of [false, true]) {
    const snapshot = buildCatalogRoutingSnapshot({
      ...SNAPSHOT_META,
      configDigest: config.configDigest, baseline: request.baseline, request,
      providers: [{ name: "anthropic", models: ["session"], offline: true, authFailed }],
      profiles: {}, policy: { ...policy, credentialsAvailable: () => false },
    });
    expect(resolveRoutingDecision(request, snapshot, config)).toMatchObject({
      status: "blocked", reason: authFailed ? "auth-failed" : "credentials-missing",
    });
  }
});
