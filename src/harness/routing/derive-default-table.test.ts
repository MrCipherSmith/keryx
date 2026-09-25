// Flow 327 (Routing A2), AC10 — `deriveDefaultTable`. Pure — no fs/network.
import { expect, test } from "bun:test";
import { deriveDefaultTable } from "./derive-default-table";
import { PRIORITY_UNKNOWN_PRICE, profileKey, type ModelProfile } from "./model-profile";

function profile(providerId: string, modelId: string, overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    providerId,
    modelId,
    strengthTier: { value: "standard", source: "guessed" },
    priceInputPerMillion: { value: "unknown", source: "unknown" },
    priceOutputPerMillion: { value: "unknown", source: "unknown" },
    contextLength: { value: "unknown", source: "unknown" },
    priority: { value: PRIORITY_UNKNOWN_PRICE, source: "auto" },
    available: true,
    lastSeenAt: "x",
    refreshedAt: "x",
    ...overrides,
  };
}

test("deriveDefaultTable: zero models -> empty table", () => {
  expect(deriveDefaultTable("prov", [], {})).toEqual({});
});

test("deriveDefaultTable: one model -> that model for every category except default (PRD §6.3's literal 'every category')", () => {
  const table = deriveDefaultTable("prov", ["only-model"], {});
  expect(table.default).toBeUndefined();
  for (const category of ["review", "subagents", "quick", "coding", "planning", "docs", "unattended"] as const) {
    expect(table[category]).toEqual({ kind: "model", providerId: "prov", modelId: "only-model" });
  }
});

test("deriveDefaultTable: several models — lightest/cheapest for quick/subagents/docs/unattended, strongest for planning/review", () => {
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "light-model")]: profile("prov", "light-model", {
      strengthTier: { value: "light", source: "reported" },
      priceInputPerMillion: { value: 1, source: "reported" },
    }),
    [profileKey("prov", "deep-model")]: profile("prov", "deep-model", {
      strengthTier: { value: "deep", source: "reported" },
      priceInputPerMillion: { value: 20, source: "reported" },
    }),
    [profileKey("prov", "standard-model")]: profile("prov", "standard-model", {
      strengthTier: { value: "standard", source: "reported" },
      priceInputPerMillion: { value: 5, source: "reported" },
    }),
  };
  const table = deriveDefaultTable("prov", ["light-model", "deep-model", "standard-model"], profiles);
  for (const category of ["quick", "subagents", "docs", "unattended"] as const) {
    expect(table[category]).toEqual({ kind: "model", providerId: "prov", modelId: "light-model" });
  }
  for (const category of ["planning", "review"] as const) {
    expect(table[category]).toEqual({ kind: "model", providerId: "prov", modelId: "deep-model" });
  }
  expect(table.default).toBeUndefined();
  expect(table.coding).toBeUndefined();
});

test("deriveDefaultTable: tier tie broken by price, then by priority.value", () => {
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "a")]: profile("prov", "a", {
      strengthTier: { value: "light", source: "reported" },
      priceInputPerMillion: { value: 2, source: "reported" },
      priority: { value: 1, source: "auto" },
    }),
    [profileKey("prov", "b")]: profile("prov", "b", {
      strengthTier: { value: "light", source: "reported" },
      priceInputPerMillion: { value: 1, source: "reported" },
      priority: { value: 1, source: "auto" },
    }),
  };
  const table = deriveDefaultTable("prov", ["a", "b"], profiles);
  // "b" is cheaper -> lightest-tier tie broken toward "b" for quick.
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "b" });
});

test("deriveDefaultTable: a model with unknown price and an unranked name is excluded from comparison", () => {
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "known")]: profile("prov", "known", {
      strengthTier: { value: "light", source: "reported" },
      priceInputPerMillion: { value: 1, source: "reported" },
    }),
    [profileKey("prov", "codename-nothing")]: profile("prov", "codename-nothing"), // unranked, unknown price
  };
  const table = deriveDefaultTable("prov", ["known", "codename-nothing"], profiles);
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "known" });
});

test("deriveDefaultTable: no comparable candidate at all -> category left unset (falls through to default)", () => {
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "codename-a")]: profile("prov", "codename-a"),
    [profileKey("prov", "codename-b")]: profile("prov", "codename-b"),
  };
  const table = deriveDefaultTable("prov", ["codename-a", "codename-b"], profiles);
  expect(table.quick).toBeUndefined();
  expect(table.planning).toBeUndefined();
});

test("deriveDefaultTable: a model absent from `profiles` entirely does not crash and is excluded", () => {
  const table = deriveDefaultTable("prov", ["no-profile-a", "no-profile-b"], {});
  expect(table.quick).toBeUndefined();
});
