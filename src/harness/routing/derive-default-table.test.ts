// Flow 327 (Routing A2), AC10 (rewritten 2026-09-25) — `deriveDefaultTable`.
// Pure — no fs/network.
import { expect, test } from "bun:test";
import { deriveDefaultTable, familyKey, parseModelVersion } from "./derive-default-table";
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
    chatCapable: true,
    lastSeenAt: "x",
    refreshedAt: "x",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// familyKey / parseModelVersion — the version-within-family parsing (item 2).
// ---------------------------------------------------------------------------

test("familyKey: strips version tokens, keeps size/vendor words, same family across versions", () => {
  expect(familyKey("claude-opus-5.5")).toBe(familyKey("claude-opus-4.7"));
  expect(familyKey("gpt-6")).toBe(familyKey("gpt-5"));
  expect(familyKey("gemini-3.8-flash")).toBe(familyKey("gemini-3.1-flash"));
  expect(familyKey("claude-opus-5.5")).not.toBe(familyKey("claude-sonnet-5"));
});

test("parseModelVersion: a single dotted-or-bare numeric token is the version", () => {
  expect(parseModelVersion("claude-opus-5.5")).toBe(5.5);
  expect(parseModelVersion("claude-opus-4.7")).toBe(4.7);
  expect(parseModelVersion("gpt-6")).toBe(6);
  expect(parseModelVersion("gemini-3.8-flash")).toBe(3.8);
});

test("parseModelVersion: conservative — no numeric token or more than one (ambiguous) yields undefined, never a guess", () => {
  expect(parseModelVersion("claude-sonnet")).toBeUndefined(); // no version at all
  expect(parseModelVersion("claude-opus-4-8")).toBeUndefined(); // two numeric tokens (hyphenated), ambiguous
});

// ---------------------------------------------------------------------------
// Zero / one model.
// ---------------------------------------------------------------------------

test("deriveDefaultTable: zero models -> empty table", () => {
  expect(deriveDefaultTable("prov", [], {}, "session-model")).toEqual({});
});

test("deriveDefaultTable: one available chat model -> that model for every category except default/coding", () => {
  const table = deriveDefaultTable("prov", ["only-model"], {}, "only-model");
  expect(table.default).toBeUndefined();
  expect(table.coding).toBeUndefined();
  for (const category of ["review", "subagents", "quick", "planning", "docs", "unattended"] as const) {
    expect(table[category]).toEqual({ kind: "model", providerId: "prov", modelId: "only-model" });
  }
});

test("deriveDefaultTable: a single NON-CHAT model derives nothing (item 3)", () => {
  expect(deriveDefaultTable("prov", ["text-embedding-3-small"], {}, "text-embedding-3-small")).toEqual({});
});

test("deriveDefaultTable: a single :free model derives nothing (item 3)", () => {
  expect(deriveDefaultTable("prov", ["vendor/model:free"], {}, "vendor/model:free")).toEqual({});
});

// ---------------------------------------------------------------------------
// The worked example (item 2): an Opus 5.5 session with opus-5.5, opus-4.7,
// sonnet-5 and haiku-4.5 available.
// ---------------------------------------------------------------------------

test("deriveDefaultTable: Opus 5.5 session — review=opus-5.5 (the session, nothing stronger), subagents=sonnet-5 (step down), quick=haiku-4.5 (smallest)", () => {
  const models = ["claude-opus-5.5", "claude-opus-4.7", "claude-sonnet-5", "claude-haiku-4.5"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]),
  );
  const table = deriveDefaultTable("anthropic", models, profiles, "claude-opus-5.5");
  expect(table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
  expect(table.planning).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
  expect(table.docs).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
  expect(table.unattended).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
  expect(table.quick).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-haiku-4.5" });
  expect(table.default).toBeUndefined();
  expect(table.coding).toBeUndefined();
});

test("deriveDefaultTable: within the same family, the newer version outranks the older one for review (BLOCKER regression — opus-4.7 must never beat the session's opus-5.5)", () => {
  const models = ["claude-opus-5.5", "claude-opus-4.7"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]),
  );
  // Both input orders — the blocker's exact reproduction shape.
  expect(deriveDefaultTable("anthropic", models, profiles, "claude-opus-5.5").review).toEqual({
    kind: "model",
    providerId: "anthropic",
    modelId: "claude-opus-5.5",
  });
  expect(deriveDefaultTable("anthropic", [...models].reverse(), profiles, "claude-opus-5.5").review).toEqual({
    kind: "model",
    providerId: "anthropic",
    modelId: "claude-opus-5.5",
  });
});

test("deriveDefaultTable: a genuinely newer version than the session ranks strongest for review/planning", () => {
  const models = ["claude-opus-5.5", "claude-opus-4.7"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]),
  );
  // Session is on the OLDER version — the newer one is available and stronger.
  const table = deriveDefaultTable("anthropic", models, profiles, "claude-opus-4.7");
  expect(table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
});

// ---------------------------------------------------------------------------
// Single-model provider / no middle step (item 2's required test list).
// ---------------------------------------------------------------------------

test("deriveDefaultTable: a single-model provider (session's own model) -> that model everywhere", () => {
  const table = deriveDefaultTable("prov", ["claude-sonnet-5"], {}, "claude-sonnet-5");
  for (const category of ["review", "planning", "subagents", "docs", "unattended", "quick"] as const) {
    expect(table[category]).toEqual({ kind: "model", providerId: "prov", modelId: "claude-sonnet-5" });
  }
});

test("deriveDefaultTable: a provider with no middle step (opus + haiku, no sonnet) — subagents/docs/unattended fall back to the session model, never the smallest class", () => {
  const models = ["claude-opus-5.5", "claude-haiku-4.5"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]),
  );
  const table = deriveDefaultTable("anthropic", models, profiles, "claude-opus-5.5");
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
  expect(table.docs).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
  expect(table.unattended).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
  // quick still takes the smallest class present, unaffected by "no middle step".
  expect(table.quick).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-haiku-4.5" });
});

// ---------------------------------------------------------------------------
// BLOCKER — the comparator never returns NaN. Two unknown-(everything)
// same-tier candidates, in BOTH input orders.
// ---------------------------------------------------------------------------

test("deriveDefaultTable: two unranked, same-tier candidates with nothing to distinguish them never throws/NaNs, in either input order", () => {
  const models = ["codename-alpha", "codename-beta"];
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "codename-alpha")]: profile("prov", "codename-alpha", {
      strengthTier: { value: "standard", source: "reported" },
      priceInputPerMillion: { value: 1, source: "reported" }, // known price -> comparable despite the unranked name
    }),
    [profileKey("prov", "codename-beta")]: profile("prov", "codename-beta", {
      strengthTier: { value: "standard", source: "reported" },
      priceInputPerMillion: { value: 1, source: "reported" },
    }),
  };
  const forward = deriveDefaultTable("prov", models, profiles, "codename-alpha");
  const reversed = deriveDefaultTable("prov", [...models].reverse(), profiles, "codename-alpha");
  // Deterministic regardless of input order — never a bare array-order
  // fallback (the exact shape of the original NaN bug).
  expect(forward).toEqual(reversed);
  for (const category of ["review", "planning", "subagents", "docs", "unattended", "quick"] as const) {
    const assignment = forward[category];
    expect(assignment).toBeDefined();
    expect(assignment!.kind).toBe("model");
  }
});

// ---------------------------------------------------------------------------
// Comparability / non-chat exclusion from the candidate set.
// ---------------------------------------------------------------------------

test("deriveDefaultTable: a model with unknown price and an unranked name is excluded from comparison", () => {
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "known")]: profile("prov", "known", {
      strengthTier: { value: "light", source: "reported" },
      priceInputPerMillion: { value: 1, source: "reported" },
    }),
    [profileKey("prov", "codename-nothing")]: profile("prov", "codename-nothing"), // unranked, unknown price
  };
  const table = deriveDefaultTable("prov", ["known", "codename-nothing"], profiles, "known");
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "known" });
});

test("deriveDefaultTable: non-chat and :free models never derive, even when they would otherwise be the strongest/only comparable candidate", () => {
  const models = ["claude-sonnet-5", "text-embedding-3-small", "vendor/model:free"];
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "claude-sonnet-5")]: profile("prov", "claude-sonnet-5"),
    [profileKey("prov", "text-embedding-3-small")]: profile("prov", "text-embedding-3-small", { chatCapable: false }),
    [profileKey("prov", "vendor/model:free")]: profile("prov", "vendor/model:free"),
  };
  const table = deriveDefaultTable("prov", models, profiles, "claude-sonnet-5");
  for (const category of ["review", "planning", "subagents", "docs", "unattended", "quick"] as const) {
    expect(table[category]).toEqual({ kind: "model", providerId: "prov", modelId: "claude-sonnet-5" });
  }
});

test("deriveDefaultTable: no comparable candidate at all -> empty table (falls through to default)", () => {
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "codename-a")]: profile("prov", "codename-a"),
    [profileKey("prov", "codename-b")]: profile("prov", "codename-b"),
  };
  const table = deriveDefaultTable("prov", ["codename-a", "codename-b"], profiles, "codename-a");
  expect(table.quick).toBeUndefined();
  expect(table.planning).toBeUndefined();
});

test("deriveDefaultTable: a model absent from `profiles` entirely does not crash and is excluded", () => {
  const table = deriveDefaultTable("prov", ["no-profile-a", "no-profile-b"], {}, "no-profile-a");
  expect(table.quick).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Tie-break: session model first, then priority.value.
// ---------------------------------------------------------------------------

test("deriveDefaultTable: tie-break prefers the session model over an equally-ranked sibling", () => {
  const models = ["vendor-a", "vendor-b"]; // different families, same (unranked -> standard) size class
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "vendor-a")]: profile("prov", "vendor-a", { priceInputPerMillion: { value: 1, source: "reported" } }),
    [profileKey("prov", "vendor-b")]: profile("prov", "vendor-b", { priceInputPerMillion: { value: 1, source: "reported" } }),
  };
  const table = deriveDefaultTable("prov", models, profiles, "vendor-b");
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "vendor-b" });
});

test("deriveDefaultTable: tie-break falls to priority.value when neither candidate is the session model", () => {
  // "claude-opus-flagship" carries the "opus" size word (sizeRank 1) — a
  // genuinely different, larger class than the two unranked vendor ids
  // (sizeRank 0), so it never enters the smallest-class ("quick") bucket and
  // cannot win that tie-break via "session model first".
  const models = ["vendor-a", "vendor-b", "claude-opus-flagship"];
  const profiles: Record<string, ModelProfile> = {
    [profileKey("prov", "vendor-a")]: profile("prov", "vendor-a", {
      priceInputPerMillion: { value: 1, source: "reported" },
      priority: { value: 1, source: "auto" },
    }),
    [profileKey("prov", "vendor-b")]: profile("prov", "vendor-b", {
      priceInputPerMillion: { value: 1, source: "reported" },
      priority: { value: 2, source: "auto" },
    }),
    [profileKey("prov", "claude-opus-flagship")]: profile("prov", "claude-opus-flagship", {
      priceInputPerMillion: { value: 1, source: "reported" },
    }),
  };
  const table = deriveDefaultTable("prov", models, profiles, "claude-opus-flagship");
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "vendor-b" }); // higher priority.value wins
});
