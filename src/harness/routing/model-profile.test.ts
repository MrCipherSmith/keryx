// Flow 327 (Routing A2) — model profiles: curated seed (AC4), generic
// pricing/context parsing (AC2), guessed tier reuse (AC5), never-fabricated
// unknown (AC6), auto-priority (AC7), diff-refresh keeping unavailable
// entries (AC9), catalogue growth for any provider (AC15), and operator
// corrections surviving a refresh (AC8/AC18). Hermetic: every store-touching
// test uses a fresh `mkdtemp` dir, never the real `~/.local/share/keryx`.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  availablePredicateFromProfiles,
  computeAutoPriority,
  curatedSeedProfiles,
  guessStrengthTier,
  isFreeVariantModelId,
  isModelDerivable,
  isNonChatModelId,
  isProfileComparable,
  loadModelProfiles,
  loadStoredModelProfiles,
  modelProfilesFilePath,
  parseModelProfileFieldsFromBody,
  PRIORITY_UNKNOWN_PRICE,
  profileKey,
  refreshModelProfiles,
  resolveChatCapable,
  setModelProfileField,
  type ModelProfile,
} from "./model-profile";
import { saveShellConfig, shellConfigPath } from "../../lib/shell-config";

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
  await setModelProfileField("anthropic", "claude-sonnet-5", { field: "priority", value: 999 }, dir);
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
  await setModelProfileField("openrouter", "m", { field: "priority", value: 42 }, dir, () => 2000);
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
  const updated = await setModelProfileField("prov", "m", { field: "tier", value: "deep" }, dir, () => 2000);
  expect(updated.strengthTier).toEqual({ value: "deep", source: "operator" });
  expect(updated.contextLength).toEqual({ value: 8000, source: "reported" }); // untouched
});

test("setModelProfileField on an id with no prior profile materializes a full profile, not a sparse row", async () => {
  const dir = await tempDir("keryx-model-profile-operator-fresh-");
  const profile: ModelProfile = await setModelProfileField("brandnew", "model-x", { field: "priceInputPerMillion", value: 7 }, dir, () => 1000);
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
      chatCapable: true,
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
    chatCapable: true,
    lastSeenAt: "x",
    refreshedAt: "x",
  };
  expect(isProfileComparable("codename-with-no-size-word", unrankedUnknown)).toBe(false);
  const rankedUnknownPrice: ModelProfile = { ...unrankedUnknown, modelId: "some-mini-model" };
  expect(isProfileComparable("some-mini-model", rankedUnknownPrice)).toBe(true);
  expect(isProfileComparable("anything", undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// Item 3 — non-chat / `:free` detection, never auto-derived (review of PR
// #718, operator decision 2026-09-25).
// ---------------------------------------------------------------------------

test("isNonChatModelId: id-pattern detection of embedding/image/tts/whisper/audio/moderation/rerank", () => {
  expect(isNonChatModelId("text-embedding-3-small")).toBe(true);
  expect(isNonChatModelId("dall-e-3")).toBe(true);
  expect(isNonChatModelId("tts-1")).toBe(true);
  expect(isNonChatModelId("whisper-1")).toBe(true);
  expect(isNonChatModelId("gpt-4o-audio-preview")).toBe(true); // conservative: excluded on `audio` alone, even though this id is a real chat model
  expect(isNonChatModelId("omni-moderation-latest")).toBe(true);
  expect(isNonChatModelId("cohere-rerank-3")).toBe(true);
  expect(isNonChatModelId("claude-sonnet-5")).toBe(false);
  expect(isNonChatModelId("gpt-6")).toBe(false);
});

// ---------------------------------------------------------------------------
// Round 2 item 3 — image-GENERATION id patterns (imagen/flux/
// stable-diffusion/sdxl/midjourney), boundary-safe.
// ---------------------------------------------------------------------------

test("isNonChatModelId: image-generation patterns (imagen/flux/stable-diffusion/sdxl/midjourney)", () => {
  expect(isNonChatModelId("imagen-3")).toBe(true);
  expect(isNonChatModelId("imagen-4-ultra")).toBe(true);
  expect(isNonChatModelId("black-forest-labs/flux-schnell")).toBe(true);
  expect(isNonChatModelId("flux-1-pro")).toBe(true);
  expect(isNonChatModelId("stabilityai/stable-diffusion-xl-base-1.0")).toBe(true);
  expect(isNonChatModelId("stabilityai/sdxl-turbo")).toBe(true);
  expect(isNonChatModelId("midjourney-v6")).toBe(true);
});

test("isNonChatModelId: the new patterns are boundary-safe — never a false positive on an unrelated chat id that merely contains the substring", () => {
  // "imagen" must not fire on the pre-existing "image" alternative reaching
  // past its own word, and vice versa — the regex requires the FULL word.
  expect(isNonChatModelId("claude-sonnet-5")).toBe(false);
  expect(isNonChatModelId("some-fluxcapacitor-model")).toBe(false); // "flux" is a substring, not a whole word
  expect(isNonChatModelId("sdxlite-chat-model")).toBe(false); // "sdxl" is a substring, not a whole word
  expect(isNonChatModelId("imagenette-classifier")).toBe(false); // "imagen" is a substring, not a whole word
});

test("isFreeVariantModelId: OpenRouter's :free suffix only", () => {
  expect(isFreeVariantModelId("meta-llama/llama-3-70b:free")).toBe(true);
  expect(isFreeVariantModelId("meta-llama/llama-3-70b")).toBe(false);
  expect(isFreeVariantModelId("some-model:freedom")).toBe(false);
});

test("resolveChatCapable: id pattern wins false, metadata can only sharpen true->false, never override an id false back to true", () => {
  expect(resolveChatCapable("claude-sonnet-5")).toBe(true);
  expect(resolveChatCapable("claude-sonnet-5", true)).toBe(true);
  expect(resolveChatCapable("claude-sonnet-5", false)).toBe(false);
  expect(resolveChatCapable("text-embedding-3-small", true)).toBe(false); // id pattern still wins
  expect(resolveChatCapable("some-vendor-codename")).toBe(true); // no signal either way -> default true
});

test("parseModelProfileFieldsFromBody: OpenRouter architecture.output_modalities/modality classify chatCapable", () => {
  const body = {
    data: [
      { id: "vendor/chat-model", architecture: { output_modalities: ["text"] } },
      { id: "vendor/embed-model", architecture: { output_modalities: ["embedding"] } },
      { id: "vendor/legacy-model", architecture: { modality: "text->text" } },
      { id: "vendor/image-model", architecture: { modality: "text+image->image" } },
      { id: "vendor/no-architecture" },
    ],
  };
  const fields = parseModelProfileFieldsFromBody(body);
  expect(fields["vendor/chat-model"]?.chatCapable).toBe(true);
  expect(fields["vendor/embed-model"]?.chatCapable).toBe(false);
  expect(fields["vendor/legacy-model"]?.chatCapable).toBe(true);
  expect(fields["vendor/image-model"]?.chatCapable).toBe(false);
  expect(fields["vendor/no-architecture"]).toBeUndefined();
});

test("refreshModelProfiles: a non-chat/free live id is stored chatCapable false / true(free) but excluded from derivation via isModelDerivable", async () => {
  const dir = await tempDir("keryx-model-profile-nonchat-");
  await refreshModelProfiles("openrouter", ["text-embedding-3-small", "vendor/model:free", "claude-sonnet-5"], {}, { dir, now: () => 1000 });
  const stored = loadStoredModelProfiles(dir);
  const embedding = stored[profileKey("openrouter", "text-embedding-3-small")]!;
  const free = stored[profileKey("openrouter", "vendor/model:free")]!;
  const chat = stored[profileKey("openrouter", "claude-sonnet-5")]!;
  expect(embedding.chatCapable).toBe(false);
  expect(isModelDerivable(embedding)).toBe(false);
  expect(free.chatCapable).toBe(true); // :free is still a real chat model...
  expect(isModelDerivable(free)).toBe(false); // ...just never auto-derived
  expect(chat.chatCapable).toBe(true);
  expect(isModelDerivable(chat)).toBe(true);
});

// ---------------------------------------------------------------------------
// Item 6 — OpenRouter's "-1" price sentinel (not-available) is never
// fabricated into a negative per-million price.
// ---------------------------------------------------------------------------

test("parseModelProfileFieldsFromBody: OpenRouter's -1 price sentinel is dropped, never stored as a negative price", () => {
  const body = { data: [{ id: "vendor/priceless-model", pricing: { prompt: "-1", completion: "-1" }, context_length: 8000 }] };
  const fields = parseModelProfileFieldsFromBody(body);
  expect(fields["vendor/priceless-model"]).toEqual({ contextLength: 8000 });
});

test("refreshModelProfiles: OpenRouter's -1 price sentinel stores 'unknown', never -1", async () => {
  const dir = await tempDir("keryx-model-profile-negative-price-");
  await refreshModelProfiles("openrouter", ["priceless"], { priceless: {} }, { dir, now: () => 1000 });
  const stored = loadStoredModelProfiles(dir)[profileKey("openrouter", "priceless")]!;
  expect(stored.priceInputPerMillion).toEqual({ value: "unknown", source: "unknown" });
});

// ---------------------------------------------------------------------------
// Item 4 — storage moved out of `auth.json` into its own file, locked,
// migrated (review of PR #718: 500+ profiles inside the credentials file
// and an unlocked read-modify-write race).
// ---------------------------------------------------------------------------

test("model profiles persist to model-profiles.json, mode 0600, NOT inside auth.json", async () => {
  const dir = await tempDir("keryx-model-profile-own-file-");
  await refreshModelProfiles("prov", ["m"], { m: { priceInputPerMillion: 2 } }, { dir, now: () => 1000 });
  const filePath = modelProfilesFilePath(dir);
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  expect(raw[profileKey("prov", "m")]).toBeDefined();
  const mode = (await stat(filePath)).mode & 0o777;
  expect(mode).toBe(0o600);
  // auth.json either does not exist yet or, if it does (nothing else in this
  // test wrote it), never carries `modelProfiles`.
  const authPath = shellConfigPath(dir);
  const authStat = await stat(authPath).catch(() => undefined);
  if (authStat !== undefined) {
    const authRaw = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
    expect("modelProfiles" in authRaw).toBe(false);
  }
});

test("migration: an existing auth.json.modelProfiles is moved into model-profiles.json and removed from auth.json, preserving every other key byte-for-byte apart from that field", async () => {
  const dir = await tempDir("keryx-model-profile-migrate-");
  await mkdir(dir, { recursive: true });
  const legacyProfile: ModelProfile = {
    providerId: "legacy",
    modelId: "old-model",
    strengthTier: { value: "standard", source: "guessed" },
    priceInputPerMillion: { value: 2, source: "reported" },
    priceOutputPerMillion: { value: 10, source: "reported" },
    contextLength: { value: 32000, source: "reported" },
    priority: { value: -2, source: "auto" },
    available: true,
    chatCapable: true,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    refreshedAt: "2026-01-01T00:00:00.000Z",
  };
  const authJsonBefore = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKeys: { DEEPSEEK_API_KEY: "shh" },
    oauthGrants: { grok: { method: "device-code", access: "tok", obtainedAt: "2026-01-01T00:00:00.000Z" } },
    modelProfiles: { [profileKey("legacy", "old-model")]: legacyProfile },
  };
  await writeFile(shellConfigPath(dir), `${JSON.stringify(authJsonBefore, null, 2)}\n`, { mode: 0o600 });

  // A pure read sees the legacy entry even before anything writes.
  const readBefore = loadModelProfiles(dir);
  expect(readBefore[profileKey("legacy", "old-model")]).toEqual(legacyProfile);
  // A bare read never mutates auth.json.
  const authStillHasField = JSON.parse(await readFile(shellConfigPath(dir), "utf8")) as Record<string, unknown>;
  expect("modelProfiles" in authStillHasField).toBe(true);

  // A locked write (`refreshModelProfiles`) performs the physical migration.
  await refreshModelProfiles("newprov", ["new-model"], {}, { dir, now: () => 2000 });

  const authAfter = JSON.parse(await readFile(shellConfigPath(dir), "utf8")) as Record<string, unknown>;
  expect("modelProfiles" in authAfter).toBe(false);
  const { modelProfiles: _removed, ...expectedRest } = authJsonBefore;
  expect(authAfter).toEqual(expectedRest);

  const fileProfiles = JSON.parse(await readFile(modelProfilesFilePath(dir), "utf8")) as Record<string, unknown>;
  expect(fileProfiles[profileKey("legacy", "old-model")]).toEqual(legacyProfile);
  expect(fileProfiles[profileKey("newprov", "new-model")]).toBeDefined();
});

// ---------------------------------------------------------------------------
// Round 2 item 2 — `auth.json`'s own lock: `saveShellConfig`'s read-modify-
// write and the migration strip's read-modify-write of the SAME file must
// not clobber each other.
// ---------------------------------------------------------------------------

// `withAuthFileLockSync.test.ts` (`src/lib/shell-config.test.ts`) exercises the
// lock PRIMITIVE itself (acquire/release, stale reclaim, non-reentrancy).
// This test instead exercises the INTEGRATION: `saveShellConfig` running
// concurrently with `refreshModelProfiles` (which performs the migration
// strip internally). Both operations here are wholly synchronous critical
// sections, so Node's microtask-before-I/O-callback ordering makes
// `saveShellConfig` deterministically complete before the migration's own
// profiles-lock `mkdir` resolves — there is no TORN write to observe either
// way. What this test still guards against is a REGRESSION in the merge
// logic itself: that `saveShellConfig`'s patch and the migration's own
// `auth.json` rewrite (stripping `modelProfiles`) both end up reflected in
// the final file, not one silently overwriting the other's already-applied
// change.
test("concurrency: saveShellConfig racing the modelProfiles migration strip — neither change is lost", async () => {
  const dir = await tempDir("keryx-model-profile-auth-lock-race-");
  await mkdir(dir, { recursive: true });
  const legacyProfile: ModelProfile = {
    providerId: "legacy",
    modelId: "old-model",
    strengthTier: { value: "standard", source: "guessed" },
    priceInputPerMillion: { value: 2, source: "reported" },
    priceOutputPerMillion: { value: 10, source: "reported" },
    contextLength: { value: 32000, source: "reported" },
    priority: { value: -2, source: "auto" },
    available: true,
    chatCapable: true,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    refreshedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(
    shellConfigPath(dir),
    `${JSON.stringify(
      { provider: "anthropic", model: "claude-sonnet-5", modelProfiles: { [profileKey("legacy", "old-model")]: legacyProfile } },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  await Promise.all([
    Promise.resolve().then(() => saveShellConfig({ model: "claude-opus-4-8" }, dir)),
    refreshModelProfiles("newprov", ["new-model"], {}, { dir, now: () => 2000 }),
  ]);

  const authAfter = JSON.parse(await readFile(shellConfigPath(dir), "utf8")) as Record<string, unknown>;
  expect(authAfter.model).toBe("claude-opus-4-8"); // saveShellConfig's patch landed...
  expect(authAfter.provider).toBe("anthropic"); // ...an untouched field survives...
  expect("modelProfiles" in authAfter).toBe(false); // ...and the migration's strip ALSO landed, not lost

  const fileProfiles = JSON.parse(await readFile(modelProfilesFilePath(dir), "utf8")) as Record<string, unknown>;
  expect(fileProfiles[profileKey("legacy", "old-model")]).toBeDefined(); // migrated
  expect(fileProfiles[profileKey("newprov", "new-model")]).toBeDefined(); // the live refresh's own entry
});

test("concurrency: two providers refreshing at the same time both persist their entries — neither clobbers the other", async () => {
  const dir = await tempDir("keryx-model-profile-concurrent-");
  await Promise.all([
    refreshModelProfiles("provA", ["a1", "a2"], {}, { dir, now: () => 1000 }),
    refreshModelProfiles("provB", ["b1", "b2"], {}, { dir, now: () => 1000 }),
  ]);
  const stored = loadStoredModelProfiles(dir);
  expect(stored[profileKey("provA", "a1")]).toBeDefined();
  expect(stored[profileKey("provA", "a2")]).toBeDefined();
  expect(stored[profileKey("provB", "b1")]).toBeDefined();
  expect(stored[profileKey("provB", "b2")]).toBeDefined();
});

test("concurrency: a routing profile set racing a refresh — both writes land", async () => {
  const dir = await tempDir("keryx-model-profile-concurrent-set-");
  await refreshModelProfiles("prov", ["m1"], {}, { dir, now: () => 1000 });
  const [, corrected] = await Promise.all([
    refreshModelProfiles("prov", ["m1", "m2"], {}, { dir, now: () => 2000 }),
    setModelProfileField("prov", "m1", { field: "priority", value: 777 }, dir, () => 2000),
  ]);
  expect(corrected.priority).toEqual({ value: 777, source: "operator" });
  const stored = loadStoredModelProfiles(dir);
  expect(stored[profileKey("prov", "m2")]).toBeDefined();
  expect(stored[profileKey("prov", "m1")]!.priority).toEqual({ value: 777, source: "operator" });
});
