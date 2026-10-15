import { expect, test } from "bun:test";
import { isDeniedModel } from "./model-denylist";
import { buildTierMap, pinHintsFor, rankDiscoveredModels, rankModelId, TIER_RANK_HINTS } from "./model-tier";
import { connectedPredicateFrom } from "../harness/routing/table";
import { rankHintsWithOperatorTiers, type ModelProfile } from "../harness/routing/model-profile";

const CODEX = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-astra",
  "gpt-6-luna",
  "gpt-5.3-codex",
];

test("isDeniedModel matches every GPT-6 Astra spelling and nothing else", () => {
  for (const id of ["gpt-6-astra", "gpt-6.1-astra", "GPT-6-ASTRA", "openai-codex/gpt-6-astra"]) {
    expect(isDeniedModel(id)).toBe(true);
  }
  for (const id of ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.3-codex", "astra-lite", ""]) {
    expect(isDeniedModel(id)).toBe(false);
  }
  expect(isDeniedModel(undefined)).toBe(false);
});

test("Astra is never a ranking candidate, whatever the hints say", () => {
  const hints = [...TIER_RANK_HINTS, ...pinHintsFor([{ modelId: "gpt-6-astra", tier: "deep" }])];
  const ranking = rankDiscoveredModels({ providerId: "openai-codex", modelId: "gpt-6-luna" }, [{ name: "openai-codex", models: CODEX }], hints);
  expect(ranking.candidates).not.toContain("gpt-6-astra");
  expect(ranking.candidates).not.toContain("gpt-6.1-astra");
  expect(ranking.ranked.map((r) => r.modelId)).not.toContain("gpt-6-astra");

  for (const sessionModel of ["gpt-6-luna", "gpt-6.1-sol"]) {
    const map = buildTierMap({ providerId: "openai-codex", modelId: sessionModel }, [{ name: "openai-codex", models: CODEX }], hints);
    for (const tier of ["light", "standard", "deep"]) expect(isDeniedModel(map[tier]?.modelId)).toBe(false);
  }
});

test("a routing assignment naming Astra is never 'connected', even when the provider lists no models", () => {
  const listed = connectedPredicateFrom([{ name: "openai-codex", models: CODEX }]);
  const bare = connectedPredicateFrom([{ name: "openai-codex" }]);
  expect(listed("openai-codex", "gpt-6-astra")).toBe(false);
  expect(bare("openai-codex", "gpt-6-astra")).toBe(false);
  expect(bare("openai-codex", "gpt-6-luna")).toBe(true);
});

test("built-in pins rank sol deep and luna light, scoped to the gpt-6 family", () => {
  expect(rankModelId("gpt-6.1-sol", TIER_RANK_HINTS)).toBe(1);
  expect(rankModelId("gpt-6-luna", TIER_RANK_HINTS)).toBe(-1);
  expect(rankModelId("gpt-5.6-luna", TIER_RANK_HINTS)).toBeUndefined();
  expect(rankModelId("acme-sol", TIER_RANK_HINTS)).toBeUndefined();
});

test("sol session: light resolves to luna, deep and standard to sol; luna session: deep resolves to sol", () => {
  const catalog = [{ name: "openai-codex", models: CODEX }];
  const onSol = buildTierMap({ providerId: "openai-codex", modelId: "gpt-6.1-sol" }, catalog);
  expect(onSol.light?.modelId).toBe("gpt-6-luna");
  expect(onSol.standard?.modelId).toBe("gpt-6.1-sol");
  expect(onSol.deep?.modelId).toBe("gpt-6.1-sol");

  const onLuna = buildTierMap({ providerId: "openai-codex", modelId: "gpt-6-luna" }, catalog);
  expect(onLuna.light?.modelId).toBe("gpt-6-luna");
  expect(onLuna.deep?.modelId).toBe("gpt-6.1-sol");
});

function profile(modelId: string, tier: "light" | "standard" | "deep", source: "operator" | "guessed"): ModelProfile {
  return {
    providerId: "openai-codex",
    modelId,
    strengthTier: { value: tier, source },
    priceInputPerMillion: { value: "unknown", source: "unknown" },
    priceOutputPerMillion: { value: "unknown", source: "unknown" },
    contextLength: { value: "unknown", source: "unknown" },
    priority: { value: 0, source: "auto" },
    available: true,
    chatCapable: true,
    lastSeenAt: "2026-10-10T00:00:00.000Z",
    refreshedAt: "2026-10-10T00:00:00.000Z",
  };
}

test("an operator-set tier outranks the built-in pin; guessed profiles add nothing", () => {
  const hints = rankHintsWithOperatorTiers("openai-codex", {
    "openai-codex/gpt-6-luna": profile("gpt-6-luna", "deep", "operator"),
    "openai-codex/gpt-6.1-sol": profile("gpt-6.1-sol", "light", "guessed"),
    "other/x": { ...profile("x", "deep", "operator"), providerId: "other" },
  });
  expect(rankModelId("gpt-6-luna", hints)).toBe(1);
  expect(rankModelId("gpt-6.1-sol", hints)).toBe(1);
  expect(rankModelId("x", hints)).toBeUndefined();
  expect(rankHintsWithOperatorTiers("openai-codex", {})).toBe(TIER_RANK_HINTS);
});
