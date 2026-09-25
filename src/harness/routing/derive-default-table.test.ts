// Flow 327 (Routing A2), AC10 (rewritten 2026-09-25) — `deriveDefaultTable`.
// Flow 341 (AC4/AC5) — the real-task-cost override on top of it, at the
// bottom of this file. Pure — no fs/network.
import { expect, test } from "bun:test";
import { deriveDefaultTable, familyKey, parseModelVersion } from "./derive-default-table";
import { PRIORITY_UNKNOWN_PRICE, profileKey, type ModelProfile } from "./model-profile";
import { MIN_MEASURED_TASKS, type TaskCostLookup, type TaskCostStats } from "./task-cost";

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

test("familyKey: a hyphenated version (claude-opus-4-8) strips to the SAME family as its dotted spelling", () => {
  expect(familyKey("claude-opus-4-8")).toBe(familyKey("claude-opus-5.5"));
  expect(familyKey("claude-haiku-4-5")).toBe("claude-haiku");
});

test("familyKey: gpt-4o and gpt-4.1 land in the same family", () => {
  expect(familyKey("gpt-4o")).toBe(familyKey("gpt-4.1"));
  expect(familyKey("gpt-4o")).toBe("gpt");
});

test("parseModelVersion: a single dotted-or-bare numeric token is the version", () => {
  expect(parseModelVersion("claude-opus-5.5")).toBe(5.5);
  expect(parseModelVersion("claude-opus-4.7")).toBe(4.7);
  expect(parseModelVersion("gpt-6")).toBe(6);
  expect(parseModelVersion("gemini-3.8-flash")).toBe(3.8);
});

test("parseModelVersion: real hyphenated Anthropic ids (claude-opus-4-8, claude-haiku-4-5, claude-sonnet-5) parse as dotted versions", () => {
  expect(parseModelVersion("claude-opus-4-8")).toBe(4.8);
  expect(parseModelVersion("claude-haiku-4-5")).toBe(4.5);
  expect(parseModelVersion("claude-sonnet-5")).toBe(5);
});

test("parseModelVersion: conservative — no numeric token, more than one version group, a too-long run, or a date-like token all yield undefined, never a guess", () => {
  expect(parseModelVersion("claude-sonnet")).toBeUndefined(); // no version at all
  expect(parseModelVersion("claude-opus-4-8-2-1")).toBeUndefined(); // four adjacent short tokens — too long a run
  expect(parseModelVersion("claude-opus-4-8-20250514")).toBeUndefined(); // a short run followed immediately by a date — the whole run is invalid (mixed shape)
  expect(parseModelVersion("claude-opus-20250514")).toBeUndefined(); // date-like (8 digits), still refused
  expect(parseModelVersion("model-4-5-and-6-7")).toBeUndefined(); // two SEPARATE version groups — ambiguous
});

test("parseModelVersion: gpt-4o parses as version 4 (the trailing letter is a variant tag, never part of the number)", () => {
  expect(parseModelVersion("gpt-4o")).toBe(4);
  expect(parseModelVersion("gpt-4.1")).toBe(4.1);
  // Deliberate non-goal, documented and locked in: gpt-4.1 (a real dotted
  // minor version) outranks gpt-4o (the bare "4" the variant tag is stripped
  // to) within the SAME family — an older-looking bare number never beats a
  // genuinely newer dotted one.
  expect(parseModelVersion("gpt-4.1")).toBeGreaterThan(parseModelVersion("gpt-4o")!);
});

// ---------------------------------------------------------------------------
// Round 3 — parameter-size tokens (`7b`, `32b`, `70b`, `34b`, `8x7b`) were
// misread as versions by the old, unrestricted `LETTER_VARIANT_TOKEN`
// (`/^(\d{1,2})([a-z])$/`, any trailing lowercase letter). Fixed by
// restricting it to the letter `o` only and adding an explicit `SIZE_TOKEN`
// exclusion. Reviewer's exact ids.
// ---------------------------------------------------------------------------

test("familyKey: parameter-size tokens (7b/32b/70b/34b) are KEPT, not stripped as a version — same-model-family/different-size ids key to different families", () => {
  expect(familyKey("qwen2.5-coder-7b")).not.toBe(familyKey("qwen2.5-coder-32b"));
  expect(familyKey("llama-3.3-70b")).not.toBe(familyKey("llama-3.3-8b"));
  // The size token itself survives in the key.
  expect(familyKey("mistral-7b")).toBe("mistral-7b");
  expect(familyKey("llama-70b")).toBe("llama-70b");
  expect(familyKey("codellama-34b")).toBe("codellama-34b");
  expect(familyKey("mixtral-8x7b")).toBe("mixtral-8x7b");
});

test("parseModelVersion: a bare size-only id never yields a version from the size token (7b/32b/70b/1.5b/8x7b are not version numbers)", () => {
  expect(parseModelVersion("mistral-7b")).toBeUndefined();
  expect(parseModelVersion("llama-70b")).toBeUndefined();
  expect(parseModelVersion("codellama-34b")).toBeUndefined();
  expect(parseModelVersion("mixtral-8x7b")).toBeUndefined();
});

test("deriveDefaultTable: qwen2.5-coder-7b and qwen2.5-coder-32b are never version-compared — different families, so the tie is undecided (session-first / priority / id fallback), never a wrong 7-beats-32 'version' pick", () => {
  const models = ["qwen2.5-coder-7b", "qwen2.5-coder-32b"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("prov", modelId), profile("prov", modelId, { priceInputPerMillion: { value: 1, source: "reported" } })]),
  );
  // Session on the 7B: since the two ids are different families (never
  // version-compared), the session model wins the strength tie exactly as
  // documented for any two undecided-strength candidates.
  const table = deriveDefaultTable("prov", models, profiles, "qwen2.5-coder-7b");
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "qwen2.5-coder-7b" });
});

test("deriveDefaultTable: llama-3.3-70b vs llama-3.3-8b — the size token, not a bogus version compare, keeps them distinct families", () => {
  const models = ["llama-3.3-70b", "llama-3.3-8b"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("prov", modelId), profile("prov", modelId, { priceInputPerMillion: { value: 1, source: "reported" } })]),
  );
  expect(familyKey("llama-3.3-70b")).not.toBe(familyKey("llama-3.3-8b"));
  const table = deriveDefaultTable("prov", models, profiles, "llama-3.3-8b");
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "llama-3.3-8b" });
});

test("familyKey/parseModelVersion: gpt-4o (the ONE real letter-variant id) is unaffected by restricting LETTER_VARIANT_TOKEN to 'o' — still a version-4 variant, same family as gpt-4.1", () => {
  expect(familyKey("gpt-4o")).toBe(familyKey("gpt-4.1"));
  expect(parseModelVersion("gpt-4o")).toBe(4);
});

test("familyKey/parseModelVersion: the reviewer's full re-run table (claude-*, gpt-*, o3, gemini-*, deepseek-v4-*, grok-4.7, MiniMax-M2) never throws and keeps its pre-fix family/version shape", () => {
  const ids = [
    "claude-opus-5.5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "claude-3-7-sonnet-latest",
    "gpt-6",
    "gpt-5.6",
    "gpt-4o",
    "gpt-4.1",
    "gpt-4o-audio-preview",
    "o3",
    "gemini-3.8-flash",
    "gemini-3.1-flash",
    "gemini-2.5-pro",
    "deepseek-v4-flash",
    "deepseek-v4",
    "grok-4.7",
    "minimax-m2",
  ];
  for (const id of ids) {
    expect(() => familyKey(id)).not.toThrow();
    expect(() => parseModelVersion(id)).not.toThrow();
  }
  // Spot checks that pre-existing behaviour did not regress.
  expect(parseModelVersion("gpt-6")).toBe(6);
  expect(parseModelVersion("grok-4.7")).toBe(4.7);
  expect(parseModelVersion("gemini-3.8-flash")).toBe(3.8);
  expect(parseModelVersion("deepseek-v4-flash")).toBeUndefined(); // "v4" is letter-then-digit, never a recognised version shape
  expect(parseModelVersion("o3")).toBeUndefined(); // letter-then-digit, not digit-then-'o'
  expect(parseModelVersion("minimax-m2")).toBeUndefined(); // "m2" is letter-then-digit, not a size or version token
  expect(familyKey("claude-opus-5.5")).toBe(familyKey("claude-opus-4-8"));
  expect(familyKey("gpt-4o-audio-preview")).not.toBe(familyKey("gpt-4o")); // "audio" keeps it a distinct family, not merged with the plain chat model
});

// ---------------------------------------------------------------------------
// Round 3 (optional, item 1) — a trailing `-latest`/`-preview` alias word is
// stripped from `familyKey` ONLY, never from the id itself.
// ---------------------------------------------------------------------------

test("familyKey: a trailing -latest/-preview alias word joins the base family, but the id itself is untouched", () => {
  expect(familyKey("claude-3-7-sonnet-latest")).toBe(familyKey("claude-sonnet-5"));
  expect(familyKey("claude-3-7-sonnet-latest")).toBe("claude-sonnet");
  expect(familyKey("gpt-4o-audio-preview")).toBe("gpt-audio");
});

test("deriveDefaultTable: claude-3-7-sonnet-latest and claude-sonnet-5 are version-compared as the SAME family (latest stripped only from the key) — the newer version wins even though the older one has the higher priority", () => {
  const models = ["claude-3-7-sonnet-latest", "claude-sonnet-5"];
  const profiles: Record<string, ModelProfile> = {
    [profileKey("anthropic", "claude-3-7-sonnet-latest")]: profile("anthropic", "claude-3-7-sonnet-latest", { priority: { value: 100, source: "operator" } }),
    [profileKey("anthropic", "claude-sonnet-5")]: profile("anthropic", "claude-sonnet-5", { priority: { value: 1, source: "auto" } }),
  };
  // Session is neither candidate, so "session model first" cannot decide
  // this tie either — isolating the family-merge/version-compare behaviour
  // from every other tie-break. Without the `-latest` word being stripped
  // from the family key, these would read as two different, unrelated
  // families, and the tie-break would fall straight to `priority.value` —
  // picking the OLDER `-latest` id purely because it was given the higher
  // priority. With the merge, the version comparison decides FIRST (as
  // `compareStrengthById` always tries before any tie-break), so the newer
  // `claude-sonnet-5` wins regardless of priority.
  const table = deriveDefaultTable("anthropic", models, profiles, "session-not-among-candidates");
  // The assignment also carries the exact, untouched id — never a
  // stripped/rewritten one.
  expect(table.quick).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
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

// ---------------------------------------------------------------------------
// Round 2 — real hyphenated Anthropic ids and gpt-4o/gpt-4.1 at the
// deriveDefaultTable level (item 1), not just the parseModelVersion unit.
// ---------------------------------------------------------------------------

test("deriveDefaultTable: claude-opus-5-1 vs claude-opus-4-8 (hyphenated ids), unknown prices, neither being the session model — 5-1 wins for planning/review", () => {
  const models = ["claude-opus-5-1", "claude-opus-4-8"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]), // unknown price, ranked via the "opus" size word alone
  );
  const table = deriveDefaultTable("anthropic", models, profiles, "claude-sonnet-5");
  expect(table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5-1" });
  expect(table.planning).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5-1" });
});

test("deriveDefaultTable: claude-haiku-4-5 (newer, hyphenated) beats an older hyphenated haiku for quick", () => {
  const models = ["claude-haiku-4-5", "claude-haiku-3-1"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]),
  );
  const table = deriveDefaultTable("anthropic", models, profiles, "claude-opus-5-1");
  expect(table.quick).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-haiku-4-5" });
});

test("deriveDefaultTable: a date-like id segment is never mistaken for a version — no crash, just an undecided tie", () => {
  const models = ["claude-opus-20250514", "claude-opus-20240601"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]),
  );
  // Both stamps refuse to parse as a version, so neither outranks the other —
  // this must resolve deterministically (session-first / priority / id
  // fallback), never throw or NaN.
  const table = deriveDefaultTable("anthropic", models, profiles, "claude-opus-20250514");
  expect(table.quick).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-20250514" }); // session model wins the tie
});

test("deriveDefaultTable: gpt-4.1 outranks gpt-4o for review — the deliberate non-goal is a real (if approximate) comparison, not an opaque refusal", () => {
  const models = ["gpt-4o", "gpt-4.1"];
  const profiles: Record<string, ModelProfile> = {
    [profileKey("openai", "gpt-4o")]: profile("openai", "gpt-4o", { priceInputPerMillion: { value: 1, source: "reported" } }),
    [profileKey("openai", "gpt-4.1")]: profile("openai", "gpt-4.1", { priceInputPerMillion: { value: 1, source: "reported" } }),
  };
  const table = deriveDefaultTable("openai", models, profiles, "gpt-3.5");
  expect(table.review).toEqual({ kind: "model", providerId: "openai", modelId: "gpt-4.1" });
});

// ---------------------------------------------------------------------------
// The alphabetical `localeCompare` fallback (`compareForSelection`'s last
// resort) must never be what decides between two versions of the SAME
// family — version parsing, when available, always wins first. Documented
// here as a deliberate contrast with the next test, where alphabetical order
// IS the (only remaining) tie-break because no version is parseable at all.
// ---------------------------------------------------------------------------

test("deriveDefaultTable: with a parseable version, alphabetical order is NEVER consulted — 'aaa-opus-99' still beats 'aaa-opus-9', which a naive string sort (prefix rule: '9' < '99') would get backwards", () => {
  const models = ["aaa-opus-9", "aaa-opus-99"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("prov", modelId), profile("prov", modelId, { priceInputPerMillion: { value: 1, source: "reported" } })]),
  );
  const table = deriveDefaultTable("prov", models, profiles, "aaa-opus-9");
  // Numerically 99 > 9, so "aaa-opus-99" must win — even though
  // "aaa-opus-9".localeCompare("aaa-opus-99") sorts "aaa-opus-9" FIRST (a
  // shorter string that is a prefix of the longer one sorts first), which
  // would make the WRONG (older) model win if the fallback ever ran here.
  expect(table.review).toEqual({ kind: "model", providerId: "prov", modelId: "aaa-opus-99" });
});

test("deriveDefaultTable: when versions are genuinely unknown (no parseable version on either side), the id-string fallback IS alphabetical — documented, not a version decision", () => {
  // Different, unranked, unrelated families — never merged by familyKey — so
  // no version comparison ever applies and the ONLY thing left to decide the
  // tie is `compareForSelection`'s final `a.modelId.localeCompare(b.modelId)`.
  const models = ["zzz-vendor-model", "aaa-vendor-model"];
  const profiles: Record<string, ModelProfile> = Object.fromEntries(
    models.map((modelId) => [profileKey("prov", modelId), profile("prov", modelId, { priceInputPerMillion: { value: 1, source: "reported" } })]),
  );
  const table = deriveDefaultTable("prov", models, profiles, "session-not-among-candidates");
  // "aaa-vendor-model" sorts first alphabetically and wins the tie — this
  // documents the fallback's existence, not a claim that it is a good
  // ranking signal.
  expect(table.quick).toEqual({ kind: "model", providerId: "prov", modelId: "aaa-vendor-model" });
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

// ---------------------------------------------------------------------------
// Flow 341 (AC4/AC5) — the cost override on the step-down categories. Same
// worked example as above: an Opus 5.5 session, opus-5.5/opus-4.7/sonnet-5/
// haiku-4.5 available. Structurally, subagents/docs/unattended step down to
// sonnet-5; review/planning stay on opus-5.5 (nothing stronger). Every test
// here supplies a `TaskCostLookup` built from a plain map, never touching disk.
// ---------------------------------------------------------------------------

const OPUS_SONNET_HAIKU_MODELS = ["claude-opus-5.5", "claude-opus-4.7", "claude-sonnet-5", "claude-haiku-4.5"];

function opusSonnetHaikuProfiles(): Record<string, ModelProfile> {
  return Object.fromEntries(OPUS_SONNET_HAIKU_MODELS.map((modelId) => [profileKey("anthropic", modelId), profile("anthropic", modelId)]));
}

function lookupFrom(entries: Readonly<Record<string, TaskCostStats>>): TaskCostLookup {
  return (providerId, modelId, category) => entries[`${providerId}::${modelId}::${category}`];
}

function stats(overrides: Partial<Omit<TaskCostStats, "medianCostUsd">> & { medianCostUsd?: number } = {}): TaskCostStats {
  const { medianCostUsd, ...rest } = overrides;
  return {
    providerId: "anthropic",
    modelId: "x",
    category: "subagents",
    n: MIN_MEASURED_TASKS,
    medianTokens: 1000,
    successRate: 1,
    ...rest,
    ...(medianCostUsd !== undefined ? { medianCostUsd } : {}),
  };
}

test("deriveDefaultTable: no taskCostLookup supplied — byte-identical to before flow 341 (subagents still steps down to sonnet)", () => {
  const table = deriveDefaultTable("anthropic", OPUS_SONNET_HAIKU_MODELS, opusSonnetHaikuProfiles(), "claude-opus-5.5");
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
});

test("deriveDefaultTable: below the evidence bar (n < 20 on either side) — the step-down pick stands even though the lighter model's measured cost is HIGHER", () => {
  const lookup = lookupFrom({
    "anthropic::claude-sonnet-5::subagents": stats({ modelId: "claude-sonnet-5", n: MIN_MEASURED_TASKS - 1, medianCostUsd: 0.5 }), // lighter, but under-measured
    "anthropic::claude-opus-5.5::subagents": stats({ modelId: "claude-opus-5.5", n: MIN_MEASURED_TASKS, medianCostUsd: 0.1 }), // stronger, cheaper — irrelevant, evidence bar not met
  });
  const table = deriveDefaultTable("anthropic", OPUS_SONNET_HAIKU_MODELS, opusSonnetHaikuProfiles(), "claude-opus-5.5", lookup);
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
});

test("deriveDefaultTable: at/above the bar, and the lighter model actually IS cheaper per task — the step-down pick stands", () => {
  const lookup = lookupFrom({
    "anthropic::claude-sonnet-5::subagents": stats({ modelId: "claude-sonnet-5", n: 25, medianCostUsd: 0.02 }),
    "anthropic::claude-opus-5.5::subagents": stats({ modelId: "claude-opus-5.5", n: 30, medianCostUsd: 0.09 }),
  });
  const table = deriveDefaultTable("anthropic", OPUS_SONNET_HAIKU_MODELS, opusSonnetHaikuProfiles(), "claude-opus-5.5", lookup);
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
});

test("deriveDefaultTable: at/above the bar, and the lighter model's median cost per task is NOT lower — it loses to the stronger candidate (the operator's exact scenario: a lighter model burning more tokens ends up costing the same or more)", () => {
  // Stats supplied for ALL THREE step-down categories — the override is
  // evaluated PER CATEGORY (each has its own measured evidence), so proving
  // it fires for more than one category means supplying more than one.
  const lookup = lookupFrom({
    "anthropic::claude-sonnet-5::subagents": stats({ modelId: "claude-sonnet-5", category: "subagents", n: 40, medianCostUsd: 0.12 }), // "lighter" but not cheaper
    "anthropic::claude-opus-5.5::subagents": stats({ modelId: "claude-opus-5.5", category: "subagents", n: 40, medianCostUsd: 0.1 }),
    "anthropic::claude-sonnet-5::docs": stats({ modelId: "claude-sonnet-5", category: "docs", n: 40, medianCostUsd: 0.12 }),
    "anthropic::claude-opus-5.5::docs": stats({ modelId: "claude-opus-5.5", category: "docs", n: 40, medianCostUsd: 0.1 }),
  });
  const table = deriveDefaultTable("anthropic", OPUS_SONNET_HAIKU_MODELS, opusSonnetHaikuProfiles(), "claude-opus-5.5", lookup);
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
  expect(table.docs).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
  // unattended has NO stats supplied — below the evidence bar (nothing
  // recorded at all), so it keeps the structural step-down pick. This is the
  // per-category independence itself: the override never leaks across
  // categories that were not individually measured.
  expect(table.unattended).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
  // review/planning were never candidates for this override — unaffected.
  expect(table.review).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
});

test("deriveDefaultTable: equal median cost — NOT strictly lower, so the lighter pick still loses (the AC's exact wording: 'is NOT lower')", () => {
  const lookup = lookupFrom({
    "anthropic::claude-sonnet-5::subagents": stats({ modelId: "claude-sonnet-5", n: 20, medianCostUsd: 0.1 }),
    "anthropic::claude-opus-5.5::subagents": stats({ modelId: "claude-opus-5.5", n: 20, medianCostUsd: 0.1 }),
  });
  const table = deriveDefaultTable("anthropic", OPUS_SONNET_HAIKU_MODELS, opusSonnetHaikuProfiles(), "claude-opus-5.5", lookup);
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-opus-5.5" });
});

test("deriveDefaultTable: cost unknown on either side — the override never fires, even with plenty of n", () => {
  const lookup = lookupFrom({
    "anthropic::claude-sonnet-5::subagents": stats({ modelId: "claude-sonnet-5", n: 100 }), // no medianCostUsd key at all — cost unknown
    "anthropic::claude-opus-5.5::subagents": stats({ modelId: "claude-opus-5.5", n: 100, medianCostUsd: 0.1 }),
  });
  const table = deriveDefaultTable("anthropic", OPUS_SONNET_HAIKU_MODELS, opusSonnetHaikuProfiles(), "claude-opus-5.5", lookup);
  expect(table.subagents).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-sonnet-5" });
});
