// Flow 327 (Routing A2) — model profiles: curated seed (AC4), generic
// pricing/context parsing (AC2), guessed tier reuse (AC5), never-fabricated
// unknown (AC6), auto-priority (AC7), diff-refresh keeping unavailable
// entries (AC9), catalogue growth for any provider (AC15), and operator
// corrections surviving a refresh (AC8/AC18). Hermetic: every store-touching
// test uses a fresh `mkdtemp` dir, never the real `~/.local/share/keryx`.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  availablePredicateFromProfiles,
  computeAutoPriority,
  curatedSeedProfiles,
  guessStrengthTier,
  isProfileComparable,
  loadModelProfiles,
  loadStoredModelProfiles,
  parseModelProfileFieldsFromBody,
  PRIORITY_UNKNOWN_PRICE,
  profileKey,
  refreshModelProfiles,
  setModelProfileField,
  type ModelProfile,
} from "./model-profile";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// AC4 — curated seed: exactly anthropic/openai/gemini.
// ---------------------------------------------------------------------------

test("curatedSeedProfiles: exactly the three curated providers, each field sourced 'curated'", () => {
  const seed = curatedSeedProfiles("2026-09-25T00:00:00.000Z");
  const providers = new Set(Object.values(seed).map((p) => p.providerId));
  expect(providers).toEqual(new Set(["anthropic", "openai", "gemini"]));
  const sonnet = seed[profileKey("anthropic", "claude-sonnet-5")];
  expect(sonnet).toBeDefined();
  expect(sonnet!.strengthTier).toEqual({ value: "standard", source: "curated" });
  expect(sonnet!.priceInputPerMillion).toEqual({ value: 3, source: "curated" });
  expect(sonnet!.available).toBe(true);
});

test("loadModelProfiles: curated seed shows up on the FIRST read, no write required (AC4 'seeds on first use')", async () => {
  const dir = await tempDir("keryx-model-profile-seed-");
  const profiles = loadModelProfiles(dir);
  expect(profiles[profileKey("anthropic", "claude-opus-4-8")]).toBeDefined();
  // Nothing was persisted by a bare read.
  expect(loadStoredModelProfiles(dir)).toEqual({});
});

test("loadModelProfiles: a stored entry (however it got there) always wins over the curated seed for the same id — never overwritten", async () => {
  const dir = await tempDir("keryx-model-profile-seed-override-");
  setModelProfileField("anthropic", "claude-sonnet-5", { field: "priority", value: 999 }, dir);
  const profiles = loadModelProfiles(dir);
  expect(profiles[profileKey("anthropic", "claude-sonnet-5")]!.priority).toEqual({ value: 999, source: "operator" });
});

// ---------------------------------------------------------------------------
// AC2 — generic pricing/context parsing off ANY gateway's `/models` body.
// ---------------------------------------------------------------------------

test("parseModelProfileFieldsFromBody: reads pricing.prompt/completion (USD/token, converted to per-million) and context_length, keyed by id", () => {
  const body = {
    data: [
      { id: "openrouter/model-a", pricing: { prompt: "0.000003", completion: "0.000015" }, context_length: 200000 },
      { id: "openrouter/model-b", pricing: { prompt: "0", completion: "0" }, context_length: 32768 },
    ],
  };
  const fields = parseModelProfileFieldsFromBody(body);
  expect(fields["openrouter/model-a"]).toEqual({ priceInputPerMillion: 3, priceOutputPerMillion: 15, contextLength: 200000 });
  expect(fields["openrouter/model-b"]).toEqual({ priceInputPerMillion: 0, priceOutputPerMillion: 0, contextLength: 32768 });
});

test("parseModelProfileFieldsFromBody: a gateway body with neither field produces no entries — falls through, never fabricated", () => {
  const body = { data: [{ id: "plain/model" }] };
  expect(parseModelProfileFieldsFromBody(body)).toEqual({});
});

test("parseModelProfileFieldsFromBody: malformed pricing/context is ignored per-field, not thrown", () => {
  const body = { data: [{ id: "m", pricing: { prompt: "not-a-number" }, context_length: "not-a-number" }] };
  expect(parseModelProfileFieldsFromBody(body)).toEqual({});
});

test("parseModelProfileFieldsFromBody: falls back to `name` when `id` is absent, matching fetchOpenAiCompatModelsDetailed's own id resolution", () => {
  const body = { data: [{ name: "named-model", context_length: 4096 }] };
  expect(parseModelProfileFieldsFromBody(body)).toEqual({ "named-model": { contextLength: 4096 } });
});

// ---------------------------------------------------------------------------
// AC5 — guessed tier reuses rankModelId/MODEL_RANK_HINTS.
// ---------------------------------------------------------------------------

test("guessStrengthTier: rank < 0 -> light, 0 -> standard, > 0 -> deep, no hint -> standard, source always 'guessed'", () => {
  expect(guessStrengthTier("deepseek-chat-mini")).toEqual({ value: "light", source: "guessed" });
  expect(guessStrengthTier("some-sonnet-variant")).toEqual({ value: "standard", source: "guessed" });
  expect(guessStrengthTier("giant-opus-model")).toEqual({ value: "deep", source: "guessed" });
  expect(guessStrengthTier("codename-with-no-size-word")).toEqual({ value: "standard", source: "guessed" });
});

// ---------------------------------------------------------------------------
// AC6 — unknown price/context is never 0 or fabricated.
// ---------------------------------------------------------------------------

test("refreshModelProfiles: a brand-new model with no reported pricing gets price/context 'unknown', never 0", async () => {
  const dir = await tempDir("keryx-model-profile-unknown-");
  await refreshModelProfiles("deepseek", ["deepseek-chat"], {}, { dir, now: () => 1000 });
  const stored = loadStoredModelProfiles(dir);
  const profile = stored[profileKey("deepseek", "deepseek-chat")]!;
  expect(profile.priceInputPerMillion).toEqual({ value: "unknown", source: "unknown" });
  expect(profile.priceOutputPerMillion).toEqual({ value: "unknown", source: "unknown" });
  expect(profile.contextLength).toEqual({ value: "unknown", source: "unknown" });
});

// ---------------------------------------------------------------------------
// AC7 — auto-priority.
// ---------------------------------------------------------------------------

test("computeAutoPriority: -price when known, a fixed sentinel below every known price when unknown", () => {
  expect(computeAutoPriority({ value: 3, source: "reported" })).toBe(-3);
  expect(computeAutoPriority({ value: "unknown", source: "unknown" })).toBe(PRIORITY_UNKNOWN_PRICE);
  expect(PRIORITY_UNKNOWN_PRICE).toBeLessThan(-1_000_000 + 1);
});

test("refreshModelProfiles: two profiles with known, different prices auto-rank cheaper-first by priority.value", async () => {
  const dir = await tempDir("keryx-model-profile-priority-");
  await refreshModelProfiles(
    "openrouter",
    ["cheap-model", "pricey-model"],
    { "cheap-model": { priceInputPerMillion: 1 }, "pricey-model": { priceInputPerMillion: 10 } },
    { dir, now: () => 1000 },
  );
  const stored = loadStoredModelProfiles(dir);
  const cheap = stored[profileKey("openrouter", "cheap-model")]!;
  const pricey = stored[profileKey("openrouter", "pricey-model")]!;
  expect(cheap.priority.value).toBeGreaterThan(pricey.priority.value);
});

test("refreshModelProfiles: an operator-set priority survives a refresh that changes that model's price", async () => {
  const dir = await tempDir("keryx-model-profile-priority-survives-");
  await refreshModelProfiles("openrouter", ["m"], { m: { priceInputPerMillion: 5 } }, { dir, now: () => 1000 });
  setModelProfileField("openrouter", "m", { field: "priority", value: 42 }, dir, () => 2000);
  await refreshModelProfiles("openrouter", ["m"], { m: { priceInputPerMillion: 500 } }, { dir, now: () => 3000 });
  const stored = loadStoredModelProfiles(dir);
  expect(stored[profileKey("openrouter", "m")]!.priority).toEqual({ value: 42, source: "operator" });
  // The price itself DID update (non-operator field refreshes freely).
  expect(stored[profileKey("openrouter", "m")]!.priceInputPerMillion).toEqual({ value: 500, source: "reported" });
});

// ---------------------------------------------------------------------------
// AC9 — diff-not-replace refresh: added / updated / kept-but-unavailable.
// ---------------------------------------------------------------------------

test("refreshModelProfiles: a shrunk-then-grown live list — vanished ids marked unavailable and KEPT, reappearing ids marked available again", async () => {
  const dir = await tempDir("keryx-model-profile-diff-");
  const first = await refreshModelProfiles("prov", ["a", "b", "c"], {}, { dir, now: () => 1000 });
  expect(first).toEqual({ added: 3, changed: 0, unavailable: 0 });

  const second = await refreshModelProfiles("prov", ["a"], {}, { dir, now: () => 2000 });
  expect(second.unavailable).toBe(2);
  let stored = loadStoredModelProfiles(dir);
  expect(stored[profileKey("prov", "b")]!.available).toBe(false);
  expect(stored[profileKey("prov", "c")]!.available).toBe(false);
  // Kept, not deleted.
  expect(stored[profileKey("prov", "b")]).toBeDefined();

  const third = await refreshModelProfiles("prov", ["a", "b"], {}, { dir, now: () => 3000 });
  expect(third.added).toBe(0); // "b" was seen before — not a brand-new id.
  stored = loadStoredModelProfiles(dir);
  expect(stored[profileKey("prov", "b")]!.available).toBe(true);
  expect(stored[profileKey("prov", "c")]!.available).toBe(false); // still gone
});

test("refreshModelProfiles: a refresh for one provider never touches another provider's stored entries", async () => {
  const dir = await tempDir("keryx-model-profile-cross-provider-");
  await refreshModelProfiles("provA", ["x"], {}, { dir, now: () => 1000 });
  await refreshModelProfiles("provB", ["y"], {}, { dir, now: () => 1000 });
  await refreshModelProfiles("provA", [], {}, { dir, now: () => 2000 }); // provA's "x" vanishes
  const stored = loadStoredModelProfiles(dir);
  expect(stored[profileKey("provA", "x")]!.available).toBe(false);
  expect(stored[profileKey("provB", "y")]!.available).toBe(true);
});

// ---------------------------------------------------------------------------
// AC15 — catalogue growth: ANY connected provider adds to the SAME store.
// ---------------------------------------------------------------------------

test("connecting a non-seeded provider adds its profiles to the SAME catalogue the curated seed lives in, each field keeping its own source", async () => {
  const dir = await tempDir("keryx-model-profile-growth-");
  await refreshModelProfiles("zai", ["glm-mini"], { "glm-mini": { priceInputPerMillion: 0.5 } }, { dir, now: () => 1000 });
  const effective = loadModelProfiles(dir);
  expect(effective[profileKey("anthropic", "claude-sonnet-5")]!.strengthTier.source).toBe("curated");
  const glm = effective[profileKey("zai", "glm-mini")]!;
  expect(glm.priceInputPerMillion).toEqual({ value: 0.5, source: "reported" });
  expect(glm.strengthTier.source).toBe("guessed"); // no curated entry for zai
});

// ---------------------------------------------------------------------------
// AC8/AC18 — operator corrections.
// ---------------------------------------------------------------------------

test("setModelProfileField: an operator correction is stored with source 'operator' and other fields keep their prior value", async () => {
  const dir = await tempDir("keryx-model-profile-operator-");
  await refreshModelProfiles("prov", ["m"], { m: { priceInputPerMillion: 2, contextLength: 8000 } }, { dir, now: () => 1000 });
  const updated = setModelProfileField("prov", "m", { field: "tier", value: "deep" }, dir, () => 2000);
  expect(updated.strengthTier).toEqual({ value: "deep", source: "operator" });
  expect(updated.contextLength).toEqual({ value: 8000, source: "reported" }); // untouched
});

test("setModelProfileField on an id with no prior profile materializes a full profile, not a sparse row", async () => {
  const dir = await tempDir("keryx-model-profile-operator-fresh-");
  const profile: ModelProfile = setModelProfileField("brandnew", "model-x", { field: "priceInputPerMillion", value: 7 }, dir, () => 1000);
  expect(profile.priceInputPerMillion).toEqual({ value: 7, source: "operator" });
  expect(profile.available).toBe(true);
  expect(profile.strengthTier.value).toBeDefined();
});

// ---------------------------------------------------------------------------
// Availability predicate + comparability helper used by `derive-default-table.ts`.
// ---------------------------------------------------------------------------

test("availablePredicateFromProfiles: true for an unavailable-marked profile is false, true when no profile exists at all", () => {
  const profiles: Record<string, ModelProfile> = {
    [profileKey("p", "m")]: {
      providerId: "p",
      modelId: "m",
      strengthTier: { value: "standard", source: "guessed" },
      priceInputPerMillion: { value: "unknown", source: "unknown" },
      priceOutputPerMillion: { value: "unknown", source: "unknown" },
      contextLength: { value: "unknown", source: "unknown" },
      priority: { value: PRIORITY_UNKNOWN_PRICE, source: "auto" },
      available: false,
      lastSeenAt: "x",
      refreshedAt: "x",
    },
  };
  const available = availablePredicateFromProfiles(profiles);
  expect(available("p", "m")).toBe(false);
  expect(available("p", "no-such-model")).toBe(true);
});

test("isProfileComparable: excluded only when price is unknown AND the name is unranked", () => {
  const unrankedUnknown: ModelProfile = {
    providerId: "p",
    modelId: "codename-with-no-size-word",
    strengthTier: { value: "standard", source: "guessed" },
    priceInputPerMillion: { value: "unknown", source: "unknown" },
    priceOutputPerMillion: { value: "unknown", source: "unknown" },
    contextLength: { value: "unknown", source: "unknown" },
    priority: { value: PRIORITY_UNKNOWN_PRICE, source: "auto" },
    available: true,
    lastSeenAt: "x",
    refreshedAt: "x",
  };
  expect(isProfileComparable("codename-with-no-size-word", unrankedUnknown)).toBe(false);
  const rankedUnknownPrice: ModelProfile = { ...unrankedUnknown, modelId: "some-mini-model" };
  expect(isProfileComparable("some-mini-model", rankedUnknownPrice)).toBe(true);
  expect(isProfileComparable("anything", undefined)).toBe(false);
});
