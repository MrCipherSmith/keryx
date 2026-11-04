import { expect, test } from "bun:test";
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

const NOW = new Date("2026-11-04T00:04:00.000Z");

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
    configDigest: "config",
    baseline: request.baseline,
    providers: [{ name: "anthropic", models: ["same"] }, { name: "openrouter", models: ["same"] }],
    profiles,
    request,
    policy,
    now: () => NOW,
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
    now: () => NOW,
  });
  expect(snapshot.models).toHaveLength(1);
  expect(snapshot.models[0]).toMatchObject({ connected: false, availability: "unknown" });
});

test("snapshot digest is independent of provider catalogue order", () => {
  const providers = [{ name: "b", models: ["m"] }, { name: "a", models: ["m"] }];
  const profiles = Object.fromEntries(providers.map(({ name }) => [profileKey(name, "m"), profile(name, "m")]));
  const input = { configDigest: "config", baseline: request.baseline, profiles, request, policy, now: () => NOW };
  const left = buildCatalogRoutingSnapshot({ ...input, providers });
  const right = buildCatalogRoutingSnapshot({ ...input, providers: [...providers].reverse() });
  expect(left.snapshotDigest).toBe(right.snapshotDigest);
});

test("authenticated baseline is injected when its live provider row omits models", () => {
  const snapshot = buildCatalogRoutingSnapshot({
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
  const fresh = buildCatalogRoutingSnapshot({ ...input, now: () => NOW });
  expect(fresh.models.map((entry) => entry.availability)).toEqual(["available", "unavailable"]);

  const stale = buildCatalogRoutingSnapshot({ ...input, now: () => new Date("2026-11-04T00:05:00.001Z") });
  expect(stale.models).toEqual(fresh.models.map((entry) => ({ ...entry, availability: "unknown" })));
  expect(stale.models.every((entry) => entry.connected)).toBe(true);
});
