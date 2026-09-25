// Flow 327 (Routing A2) — model profiles: what keryx honestly knows about
// each connected model (strength, price, context length) and where each
// field's value came from. PRD §6.1, docs/requirements/keryx-jev-router/PRD.md.
//
// Storage (AC3, rewritten 2026-09-25 — review of PR #718: 500+ profiles
// inside the credentials file and an unlocked read-modify-write race): its
// OWN file, `model-profiles.json`, in the same keryx user data dir
// `shell-config.ts`'s `auth.json` (credentials) and `shell-config.ts`'s
// `modelParams` sibling `provider-catalog-cache.ts`'s `provider-catalog.json`
// already live in — mode 0600, written atomically under `withFileLock`
// (`../../lib/fs.ts`), the SAME pattern `provider-catalog-cache.ts` uses for
// its own on-disk cache. Keyed by `<providerId>/<modelId>`.
// `loadModelProfiles` merges the stored map with the curated seed (AC4) so
// the seed shows up from the FIRST read without a forced write — an operator
// correction (`setModelProfileField`, AC8) or a live refresh
// (`refreshModelProfiles`, AC2/AC9) is what actually persists a row; a bare
// read never writes.
//
// A one-time migration (`migrateFromAuthJsonUnlocked`, run under the SAME
// lock at the start of every locked write) moves any `modelProfiles` still
// present in `auth.json` — the shape this flow originally shipped, before
// this rewrite — into `model-profiles.json` and then removes the field from
// `auth.json`, leaving every other key/grant in that file untouched. A pure
// read (`loadStoredModelProfiles`) never writes; it merges the legacy
// `auth.json` field in-memory so a caller sees the complete picture even
// before the next write physically migrates it.
//
// No TUI/CLI import here — pure data + pure functions, mirroring
// `./table.ts`'s own "no rendering deps" posture. Every function that
// touches disk takes the same `dir?: string` test seam every other writer in
// this codebase uses, defaulting to production.
import path from "node:path";
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  OPENAI_MODELS,
} from "../../commands/curated-model-lists";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../../lib/config-dir";
import { withFileLock } from "../../lib/fs";
import { loadShellConfig, shellConfigPath } from "../../lib/shell-config";
import { MODEL_RANK_HINTS, rankModelId } from "../../gdskills/model-tier";
import type { AvailablePredicate } from "./table";

// ---------------------------------------------------------------------------
// Types (PRD §6.1)
// ---------------------------------------------------------------------------

/** Where a field's value came from, in the order each is tried (PRD §6.1). */
export type ProfileSource = "reported" | "curated" | "guessed" | "operator" | "unknown";

export type PrioritySource = "auto" | "operator";

export type StrengthTier = "light" | "standard" | "deep";

/** A price/context field: either a real number with its provenance, or the honest `"unknown"` — never `0`, never fabricated (AC6/R17). */
export type NumericProfileField = { readonly value: number; readonly source: ProfileSource } | { readonly value: "unknown"; readonly source: "unknown" };

export interface ModelProfile {
  readonly providerId: string;
  readonly modelId: string;
  readonly strengthTier: { readonly value: StrengthTier; readonly source: ProfileSource };
  readonly priceInputPerMillion: NumericProfileField;
  readonly priceOutputPerMillion: NumericProfileField;
  readonly contextLength: NumericProfileField;
  readonly priority: { readonly value: number; readonly source: PrioritySource };
  /** False once a live fetch no longer lists this model (§6.2) — the profile is kept, not deleted. */
  readonly available: boolean;
  /**
   * False for a model that is not a chat/completion model — an embedding,
   * image, TTS/audio, moderation or rerank endpoint (review of PR #718,
   * operator decision 2026-09-25: "never auto-derive a non-chat model").
   * Detected from the id (`isNonChatModelId`) and, when a gateway's `/models`
   * body carries it, from modality metadata (`resolveChatCapable`) — never
   * from price/context, which a non-chat model can report just as validly as
   * a chat one. Always recomputed on refresh (not an operator-correctable
   * field — `ModelProfileFieldName` has no case for it); defaults `true` for
   * a profile stored before this field existed (`sanitizeStoredProfile`),
   * since every such profile predates this flow and none of them are
   * non-chat entries. `deriveDefaultTable` (`./derive-default-table.ts`)
   * excludes `chatCapable: false` from derivation; the `/routing` picker
   * still lists it, marked (`describePickerRowProfile`,
   * `../../tui/routing-inspector.ts`).
   */
  readonly chatCapable: boolean;
  /** Last time this model was present in a live fetch (advances only while `available`). */
  readonly lastSeenAt: string;
  readonly refreshedAt: string;
}

// ---------------------------------------------------------------------------
// Non-chat / non-derivable model detection (review of PR #718, item 3 —
// operator decision 2026-09-25: exclude non-chat models and OpenRouter
// `:free` variants from derivation; still list them in the picker, marked).
// ---------------------------------------------------------------------------

/**
 * Id-pattern signal (word-boundary, case-insensitive): embedding, image,
 * text-to-speech/speech-to-text, moderation and rerank endpoints are not
 * chat/completion models and must never be auto-derived into a routing
 * category. `audio` is included deliberately even though some real
 * multimodal CHAT models carry it in their id (e.g. an audio-preview
 * variant) — the operator's instruction names `audio` explicitly as one of
 * the excluded patterns, and a false exclusion there only means the picker's
 * "marked, still selectable" fallback applies (AC10's non-goal list), never
 * a broken selection.
 */
const NON_CHAT_ID_PATTERN = /\b(embed(?:ding)?|image|dall-?e|tts|text-to-speech|speech-to-text|whisper|audio|moderation|rerank)\b/i;

/** True when `modelId` names a non-chat model by its id alone (no metadata needed). */
export function isNonChatModelId(modelId: string): boolean {
  return NON_CHAT_ID_PATTERN.test(modelId);
}

/** OpenRouter's `:free` suffix convention (`vendor/model:free`) — excluded from derivation only, never marked non-chat (item 3). */
export function isFreeVariantModelId(modelId: string): boolean {
  return /:free$/i.test(modelId.trim());
}

/**
 * `chatCapable`, combining the always-available id heuristic with an
 * optional metadata signal (`parseModelProfileFieldsFromBody`'s
 * `chatCapable`, from OpenRouter's `architecture.output_modalities`/
 * `architecture.modality`). Metadata can only ever SHARPEN the id
 * heuristic's "chat" default to `false` — never override an id-pattern
 * `false` back to `true` — since the id patterns above are the operator's
 * explicit instruction and metadata is confirmed live for OpenRouter only
 * (PRD §6.1's own "confirmed live" posture for pricing/context_length).
 */
export function resolveChatCapable(modelId: string, metadataChatCapable?: boolean): boolean {
  if (isNonChatModelId(modelId)) return false;
  if (metadataChatCapable === false) return false;
  return true;
}

/** Never auto-derived (item 3): not chat-capable, or an OpenRouter `:free` variant. Still shown in the picker, marked. */
export function isModelDerivable(profile: ModelProfile): boolean {
  return profile.chatCapable && !isFreeVariantModelId(profile.modelId);
}

/** Storage key: `<providerId>/<modelId>`. */
export function profileKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

// ---------------------------------------------------------------------------
// Auto-priority (PRD §6.1 "Auto-priority")
// ---------------------------------------------------------------------------

/**
 * A fixed sentinel below every known price — an `unknown`-priced model always
 * sorts last by auto-priority, never in the middle (PRD's own "unknown is
 * never good news" stance, §6.1). Any real price is `>= 0` and this is
 * negative, so no legitimate `-priceInputPerMillion` value can collide with it.
 */
export const PRIORITY_UNKNOWN_PRICE = -1_000_000;

/** `priority.value = -priceInputPerMillion` when known, else the sentinel (PRD §6.1). */
export function computeAutoPriority(priceInputPerMillion: NumericProfileField): number {
  return priceInputPerMillion.value === "unknown" ? PRIORITY_UNKNOWN_PRICE : -priceInputPerMillion.value;
}

// ---------------------------------------------------------------------------
// Guessed strength tier (AC5) — reuses `rankModelId`/`MODEL_RANK_HINTS`
// (`src/gdskills/model-tier.ts:205-258`) verbatim, never a second table.
// ---------------------------------------------------------------------------

/** rank < 0 -> light, 0 -> standard, > 0 -> deep, undefined (no hint matched) -> standard (AC5). */
export function guessStrengthTier(modelId: string): { readonly value: StrengthTier; readonly source: "guessed" } {
  const rank = rankModelId(modelId, MODEL_RANK_HINTS);
  if (rank === undefined) return { value: "standard", source: "guessed" };
  if (rank < 0) return { value: "light", source: "guessed" };
  if (rank > 0) return { value: "deep", source: "guessed" };
  return { value: "standard", source: "guessed" };
}

/**
 * PRD §6.3's "entirely unknown" exclusion: no reported/curated/operator price
 * AND an unranked name (`rankModelId` matched no hint at all — the "not even
 * a guess" bare default, per `guessStrengthTier`'s own doc). A model with a
 * hint-ranked tier but still-unknown price stays comparable (tier alone is
 * enough to place it); only the conjunction of both is excluded.
 */
export function isProfileComparable(modelId: string, profile: ModelProfile | undefined): boolean {
  if (profile === undefined) return false;
  const priceUnknown = profile.priceInputPerMillion.value === "unknown";
  const unranked = rankModelId(modelId, MODEL_RANK_HINTS) === undefined;
  return !(priceUnknown && unranked);
}

// ---------------------------------------------------------------------------
// Curated seed (AC4) — exactly the three providers with no live `/models`
// source: ANTHROPIC_MODELS/OPENAI_MODELS/GEMINI_MODELS. Hand-maintained
// approximate USD-per-million-token prices and context lengths; update
// alongside `../../commands/curated-model-lists.ts` when a lineup moves on.
// Never treated as more authoritative than a `reported`/`operator` value —
// `loadModelProfiles` merges this UNDER whatever is already stored (AC4:
// "never overwriting an already-stored entry").
// ---------------------------------------------------------------------------

interface CuratedEntry {
  readonly tier: StrengthTier;
  readonly priceInputPerMillion: number;
  readonly priceOutputPerMillion: number;
  readonly contextLength: number;
}

const CURATED_SEED: Readonly<Record<string, Readonly<Record<string, CuratedEntry>>>> = {
  anthropic: {
    "claude-sonnet-5": { tier: "standard", priceInputPerMillion: 3, priceOutputPerMillion: 15, contextLength: 200_000 },
    "claude-opus-4-8": { tier: "deep", priceInputPerMillion: 15, priceOutputPerMillion: 75, contextLength: 200_000 },
    "claude-haiku-4-5": { tier: "light", priceInputPerMillion: 0.8, priceOutputPerMillion: 4, contextLength: 200_000 },
  },
  openai: {
    "gpt-5.6": { tier: "deep", priceInputPerMillion: 1.25, priceOutputPerMillion: 10, contextLength: 400_000 },
    "gpt-5.6-terra": { tier: "standard", priceInputPerMillion: 0.5, priceOutputPerMillion: 4, contextLength: 300_000 },
    "gpt-5.6-luna": { tier: "light", priceInputPerMillion: 0.15, priceOutputPerMillion: 0.6, contextLength: 200_000 },
  },
  gemini: {
    "gemini-3.7-flash": { tier: "light", priceInputPerMillion: 0.3, priceOutputPerMillion: 2.5, contextLength: 1_000_000 },
    "gemini-2.5-pro": { tier: "deep", priceInputPerMillion: 1.25, priceOutputPerMillion: 10, contextLength: 2_000_000 },
    "gemini-2.5-flash-lite": { tier: "light", priceInputPerMillion: 0.1, priceOutputPerMillion: 0.4, contextLength: 1_000_000 },
  },
};

// Confirms `CURATED_SEED`'s keys track `curated-model-lists.ts` at module
// load — a drift there (a model added/removed) fails loudly instead of
// silently seeding a stale or missing entry.
function assertCuratedCoverage(providerId: string, ids: readonly string[]): void {
  const table = CURATED_SEED[providerId] ?? {};
  for (const id of ids) {
    if (!(id in table)) {
      throw new Error(`model-profile.ts: CURATED_SEED[${JSON.stringify(providerId)}] is missing an entry for ${JSON.stringify(id)} — update it alongside curated-model-lists.ts`);
    }
  }
}
assertCuratedCoverage("anthropic", ANTHROPIC_MODELS);
assertCuratedCoverage("openai", OPENAI_MODELS);
assertCuratedCoverage("gemini", GEMINI_MODELS);

function curatedProfile(providerId: string, modelId: string, entry: CuratedEntry, now: string): ModelProfile {
  const priceInputPerMillion: NumericProfileField = { value: entry.priceInputPerMillion, source: "curated" };
  return {
    providerId,
    modelId,
    strengthTier: { value: entry.tier, source: "curated" },
    priceInputPerMillion,
    priceOutputPerMillion: { value: entry.priceOutputPerMillion, source: "curated" },
    contextLength: { value: entry.contextLength, source: "curated" },
    priority: { value: computeAutoPriority(priceInputPerMillion), source: "auto" },
    available: true,
    // The three curated providers (ANTHROPIC_MODELS/OPENAI_MODELS/GEMINI_MODELS,
    // `../../commands/curated-model-lists.ts`) list chat models exclusively —
    // no embedding/image/TTS entry has ever been curated here.
    chatCapable: true,
    lastSeenAt: now,
    refreshedAt: now,
  };
}

/** The curated seed as a `<providerId>/<modelId>`-keyed map, materialized as of `nowIso` (display-only timestamps — not yet persisted). */
export function curatedSeedProfiles(nowIso: string): Record<string, ModelProfile> {
  const out: Record<string, ModelProfile> = {};
  for (const [providerId, models] of Object.entries(CURATED_SEED)) {
    for (const [modelId, entry] of Object.entries(models)) {
      out[profileKey(providerId, modelId)] = curatedProfile(providerId, modelId, entry, nowIso);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing a `/models` response body for pricing/context_length (AC2) —
// generic over ANY gateway shape: reads the fields when present, per-field,
// never gateway-specific. Confirmed live for OpenRouter (2026-09-25):
// `pricing: {prompt, completion}` (USD per token, as strings) and a numeric
// `context_length` per `data[]` entry — see PRD §6.1.
// ---------------------------------------------------------------------------

export interface ParsedModelProfileFields {
  readonly priceInputPerMillion?: number;
  readonly priceOutputPerMillion?: number;
  readonly contextLength?: number;
  /**
   * Item 3 — a definitive modality signal from the gateway's own `/models`
   * body, when it carries one. `false` means the entry's OWN metadata says
   * its output is not text (an embedding/image/audio endpoint); `true` means
   * text output is confirmed; omitted means the body carried no modality
   * field at all, and `resolveChatCapable` falls back to the id heuristic.
   */
  readonly chatCapable?: boolean;
}

function modelEntryId(entry: { id?: unknown; name?: unknown }): string | undefined {
  if (typeof entry.id === "string" && entry.id.length > 0) return entry.id;
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  return undefined;
}

/**
 * Item 3 — OpenRouter's `architecture.output_modalities` (an array, e.g.
 * `["text"]`/`["text","image"]`) or `architecture.modality` (a string, e.g.
 * `"text->text"`/`"text->embedding"`). `undefined` when the entry carries
 * neither shape — the id heuristic (`resolveChatCapable`) decides alone.
 * Never throws.
 */
function chatCapableFromArchitecture(entry: { architecture?: unknown }): boolean | undefined {
  const architecture = entry.architecture;
  if (typeof architecture !== "object" || architecture === null) return undefined;
  const record = architecture as { output_modalities?: unknown; modality?: unknown };
  if (Array.isArray(record.output_modalities)) {
    const modalities = record.output_modalities.filter((m): m is string => typeof m === "string");
    if (modalities.length === 0) return undefined;
    return modalities.some((m) => m.toLowerCase() === "text");
  }
  if (typeof record.modality === "string" && record.modality.length > 0) {
    const output = record.modality.split("->").at(-1)?.trim().toLowerCase() ?? "";
    if (output.length === 0) return undefined;
    return output.includes("text");
  }
  return undefined;
}

function usdPerTokenToPerMillion(raw: unknown): number | undefined {
  const num = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : undefined;
  if (num === undefined || !Number.isFinite(num) || num < 0) return undefined;
  // Round to 6 decimal places — USD-per-token as a string (e.g. "0.00000632")
  // times 1e6 lands on a binary-float artifact (0.25279999999999997) more
  // often than not; 6 places is far finer than any real per-million price
  // matters at and keeps stored/displayed values honest-looking.
  return Math.round(num * 1_000_000 * 1_000_000) / 1_000_000;
}

/**
 * Extract per-model `{priceInputPerMillion?, priceOutputPerMillion?,
 * contextLength?}` from the SAME `data[]` array `fetchOpenAiCompatModelsDetailed`
 * already reads ids from (`src/commands/providers.ts`). A field absent or
 * malformed on a given entry is simply omitted — never coerced to `0` or a
 * guess (AC6). Never throws.
 */
export function parseModelProfileFieldsFromBody(body: unknown): Record<string, ParsedModelProfileFields> {
  const out: Record<string, ParsedModelProfileFields> = {};
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { id?: unknown; name?: unknown; pricing?: unknown; context_length?: unknown; architecture?: unknown };
    const id = modelEntryId(entry);
    if (id === undefined) continue;
    const fields: { priceInputPerMillion?: number; priceOutputPerMillion?: number; contextLength?: number; chatCapable?: boolean } = {};
    const pricing = entry.pricing;
    if (typeof pricing === "object" && pricing !== null) {
      const prompt = usdPerTokenToPerMillion((pricing as { prompt?: unknown }).prompt);
      if (prompt !== undefined) fields.priceInputPerMillion = prompt;
      const completion = usdPerTokenToPerMillion((pricing as { completion?: unknown }).completion);
      if (completion !== undefined) fields.priceOutputPerMillion = completion;
    }
    const chatCapable = chatCapableFromArchitecture(entry);
    if (chatCapable !== undefined) fields.chatCapable = chatCapable;
    const contextLength = entry.context_length;
    if (typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0) {
      fields.contextLength = contextLength;
    }
    if (Object.keys(fields).length > 0) out[id] = fields;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage (AC3, rewritten) — `model-profiles.json`, its own file, validated
// on the way in (a hand-edited or stale-shaped entry is dropped rather than
// trusted, same posture as `provider-catalog-cache.ts`'s `sanitizeEntry`).
// ---------------------------------------------------------------------------

const PROFILE_SOURCES: ReadonlySet<string> = new Set(["reported", "curated", "guessed", "operator", "unknown"]);
const PRIORITY_SOURCES: ReadonlySet<string> = new Set(["auto", "operator"]);
const STRENGTH_TIERS: ReadonlySet<string> = new Set(["light", "standard", "deep"]);

function sanitizeNumericField(value: unknown): NumericProfileField | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { value?: unknown; source?: unknown };
  if (record.value === "unknown" && record.source === "unknown") return { value: "unknown", source: "unknown" };
  if (typeof record.value === "number" && Number.isFinite(record.value) && typeof record.source === "string" && PROFILE_SOURCES.has(record.source) && record.source !== "unknown") {
    return { value: record.value, source: record.source as ProfileSource };
  }
  return undefined;
}

function sanitizeStoredProfile(value: unknown): ModelProfile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.providerId !== "string" || record.providerId.length === 0) return undefined;
  if (typeof record.modelId !== "string" || record.modelId.length === 0) return undefined;
  const tier = record.strengthTier as { value?: unknown; source?: unknown } | undefined;
  if (typeof tier !== "object" || tier === null || typeof tier.value !== "string" || !STRENGTH_TIERS.has(tier.value) || typeof tier.source !== "string" || !PROFILE_SOURCES.has(tier.source)) {
    return undefined;
  }
  const priceInputPerMillion = sanitizeNumericField(record.priceInputPerMillion);
  const priceOutputPerMillion = sanitizeNumericField(record.priceOutputPerMillion);
  const contextLength = sanitizeNumericField(record.contextLength);
  if (priceInputPerMillion === undefined || priceOutputPerMillion === undefined || contextLength === undefined) return undefined;
  const priority = record.priority as { value?: unknown; source?: unknown } | undefined;
  if (typeof priority !== "object" || priority === null || typeof priority.value !== "number" || !Number.isFinite(priority.value) || typeof priority.source !== "string" || !PRIORITY_SOURCES.has(priority.source)) {
    return undefined;
  }
  if (typeof record.available !== "boolean") return undefined;
  if (typeof record.lastSeenAt !== "string" || typeof record.refreshedAt !== "string") return undefined;
  // `chatCapable` defaults to `true` for a profile stored before this field
  // existed (every profile written by keryx prior to this rewrite) — see the
  // field's own doc on `ModelProfile`.
  const chatCapable = typeof record.chatCapable === "boolean" ? record.chatCapable : true;
  return {
    providerId: record.providerId,
    modelId: record.modelId,
    strengthTier: { value: tier.value as StrengthTier, source: tier.source as ProfileSource },
    priceInputPerMillion,
    priceOutputPerMillion,
    contextLength,
    priority: { value: priority.value, source: priority.source as PrioritySource },
    available: record.available,
    chatCapable,
    lastSeenAt: record.lastSeenAt,
    refreshedAt: record.refreshedAt,
  };
}

const MODEL_PROFILES_FILE = "model-profiles.json";
const MODEL_PROFILES_LOCK_TIMEOUT_MS = 3_000;
const MODEL_PROFILES_LOCK_RETRY_MS = 15;
const MODEL_PROFILES_LOCK_STALE_MS = 10_000;

/** Absolute path to `model-profiles.json` — the keryx user data dir, the same dir `shell-config.ts`'s `auth.json` and `provider-catalog-cache.ts`'s `provider-catalog.json` live in. */
export function modelProfilesFilePath(dir?: string): string {
  return path.join(keryxConfigDir(dir), MODEL_PROFILES_FILE);
}

/** Read `model-profiles.json` alone (no `auth.json` legacy merge, no lock). `{}` when absent/oversized/unreadable/malformed. Never throws. */
function readModelProfilesFileUnlocked(dir?: string): Record<string, ModelProfile> {
  const read = readConfigFile(modelProfilesFilePath(dir));
  if (!read.ok) return {};
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, ModelProfile> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const profile = sanitizeStoredProfile(value);
      if (profile !== undefined) out[key] = profile;
    }
    return out;
  } catch {
    return {};
  }
}

/** Overwrite `model-profiles.json` wholesale, atomically, mode 0600. Callers merge first and hold the lock. */
function writeModelProfilesFileUnlocked(profiles: Record<string, ModelProfile>, dir?: string): void {
  ensureKeryxConfigDir(dir);
  writeOwnerOnlyFileAtomic(modelProfilesFilePath(dir), `${JSON.stringify(profiles, null, 2)}\n`);
}

/**
 * Rewrite `auth.json` with its `modelProfiles` field removed, preserving
 * every other key/grant byte-for-byte (same `JSON.stringify(_, null, 2)`
 * formatting `saveShellConfig` uses, so an untouched field round-trips
 * identically). A no-op when the field is already absent. Best-effort —
 * caught by `migrateFromAuthJsonUnlocked`, never throws on its own.
 */
function stripModelProfilesFromAuthJsonUnlocked(dir?: string): void {
  const file = shellConfigPath(dir);
  const read = readConfigFile(file);
  if (!read.ok) return;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(read.text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!("modelProfiles" in raw)) return;
  const { modelProfiles: _removed, ...rest } = raw;
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify(rest, null, 2)}\n`);
}

/**
 * The one-time migration (AC3 rewrite): any `modelProfiles` still present in
 * `auth.json` (this flow's original storage, before the rewrite) is merged
 * into `model-profiles.json` and then removed from `auth.json`. Runs INSIDE
 * `withModelProfilesLock`, at the start of every locked write, so it never
 * races a concurrent writer. `model-profiles.json`'s own content wins on a
 * key collision (it is the more-authoritative, already-migrated copy);
 * `auth.json`'s legacy entries fill in anything not yet in the file.
 * Best-effort; never throws. Returns the (possibly just-migrated) current
 * file content.
 */
function migrateFromAuthJsonUnlocked(dir?: string): Record<string, ModelProfile> {
  const fileProfiles = readModelProfilesFileUnlocked(dir);
  const rawLegacy = loadShellConfig(dir).modelProfiles;
  if (rawLegacy === undefined) return fileProfiles;
  if (typeof rawLegacy !== "object" || rawLegacy === null || Object.keys(rawLegacy).length === 0) {
    // Present but empty/malformed — still retire the field.
    stripModelProfilesFromAuthJsonUnlocked(dir);
    return fileProfiles;
  }
  const legacyProfiles: Record<string, ModelProfile> = {};
  for (const [key, value] of Object.entries(rawLegacy as Record<string, unknown>)) {
    const profile = sanitizeStoredProfile(value);
    if (profile !== undefined) legacyProfiles[key] = profile;
  }
  const merged = { ...legacyProfiles, ...fileProfiles };
  writeModelProfilesFileUnlocked(merged, dir);
  stripModelProfilesFromAuthJsonUnlocked(dir);
  return merged;
}

/**
 * Every read-modify-write on the profile store (AC3 rewrite — the lock race
 * finding) runs `fn` against the current, migrated content, under the SAME
 * file lock `provider-catalog-cache.ts` uses for its own cache: two
 * providers refreshing concurrently, `providers test`, and `routing profile
 * set` all serialize here rather than clobbering each other's write.
 */
async function withModelProfilesLock<T>(dir: string | undefined, fn: (current: Record<string, ModelProfile>) => T | Promise<T>): Promise<T> {
  return withFileLock(
    `${modelProfilesFilePath(dir)}.lock`,
    async () => fn(migrateFromAuthJsonUnlocked(dir)),
    { timeoutMs: MODEL_PROFILES_LOCK_TIMEOUT_MS, retryMs: MODEL_PROFILES_LOCK_RETRY_MS, staleMs: MODEL_PROFILES_LOCK_STALE_MS },
  );
}

/**
 * Raw stored profiles only (no curated merge) — `{}` when absent/empty/
 * malformed. Never throws, never writes: the legacy `auth.json.modelProfiles`
 * field (when the one-time migration hasn't physically run yet) is merged in
 * MEMORY ONLY, so a bare read always sees the complete picture without ever
 * mutating `auth.json` itself — only a locked write
 * (`withModelProfilesLock`) does that.
 */
export function loadStoredModelProfiles(dir?: string): Record<string, ModelProfile> {
  const fileProfiles = readModelProfilesFileUnlocked(dir);
  const rawLegacy = loadShellConfig(dir).modelProfiles;
  if (typeof rawLegacy !== "object" || rawLegacy === null || Object.keys(rawLegacy).length === 0) {
    return fileProfiles;
  }
  const legacyProfiles: Record<string, ModelProfile> = {};
  for (const [key, value] of Object.entries(rawLegacy as Record<string, unknown>)) {
    const profile = sanitizeStoredProfile(value);
    if (profile !== undefined) legacyProfiles[key] = profile;
  }
  return { ...legacyProfiles, ...fileProfiles };
}

/**
 * The operator's effective catalogue (AC3/AC4/AC15): every stored profile,
 * plus a curated-seed entry for any curated id NOT already stored (a stored
 * entry — however it got there, including a prior curated-seed write or a
 * live refresh — always wins; AC4's "never overwriting"). Pure read; does
 * NOT persist the seed to disk (persistence happens the first time something
 * actually writes — `setModelProfileField` or `refreshModelProfiles`).
 */
export function loadModelProfiles(dir?: string, now: () => number = Date.now): Record<string, ModelProfile> {
  const nowIso = new Date(now()).toISOString();
  return { ...curatedSeedProfiles(nowIso), ...loadStoredModelProfiles(dir) };
}

/** `AvailablePredicate` (`./table.ts`) built from a profile map (AC10). A `"model"` id with no profile at all is treated as available — no data is not evidence of absence. */
export function availablePredicateFromProfiles(profiles: Readonly<Record<string, ModelProfile>>): AvailablePredicate {
  return (providerId, modelId) => {
    const profile = profiles[profileKey(providerId, modelId)];
    return profile === undefined ? true : profile.available;
  };
}

// ---------------------------------------------------------------------------
// Refresh / diff (AC2, AC9, AC15) — the diff-not-replace contract: a newly
// listed id is added, a still-listed id updates its non-operator fields, a
// no-longer-listed id (for THIS provider only) is kept and marked unavailable.
// ---------------------------------------------------------------------------

export interface ProfileRefreshSummary {
  readonly added: number;
  readonly changed: number;
  readonly unavailable: number;
}

export interface ProfileRefreshDeps {
  readonly dir?: string;
  readonly now?: () => number;
}

function buildField(reported: number | undefined, curatedFallback: NumericProfileField | undefined): NumericProfileField {
  if (reported !== undefined) return { value: reported, source: "reported" };
  if (curatedFallback !== undefined && curatedFallback.value !== "unknown") return curatedFallback;
  return { value: "unknown", source: "unknown" };
}

function freshProfile(providerId: string, modelId: string, parsed: ParsedModelProfileFields | undefined, nowIso: string): ModelProfile {
  const tier = guessStrengthTier(modelId);
  const priceInputPerMillion = buildField(parsed?.priceInputPerMillion, undefined);
  return {
    providerId,
    modelId,
    strengthTier: tier,
    priceInputPerMillion,
    priceOutputPerMillion: buildField(parsed?.priceOutputPerMillion, undefined),
    contextLength: buildField(parsed?.contextLength, undefined),
    priority: { value: computeAutoPriority(priceInputPerMillion), source: "auto" },
    available: true,
    chatCapable: resolveChatCapable(modelId, parsed?.chatCapable),
    lastSeenAt: nowIso,
    refreshedAt: nowIso,
  };
}

/** Update an EXISTING profile's non-`operator` fields from a fresh live sighting (AC7, AC9, AC18). `chatCapable` is always recomputed — it is not an operator-correctable field (`ModelProfileFieldName`). */
function updateProfile(existing: ModelProfile, parsed: ParsedModelProfileFields | undefined, nowIso: string): ModelProfile {
  const tier = existing.strengthTier.source === "operator" ? existing.strengthTier : guessStrengthTier(existing.modelId);
  const priceInputPerMillion =
    existing.priceInputPerMillion.source === "operator" ? existing.priceInputPerMillion : buildField(parsed?.priceInputPerMillion, undefined);
  const priceOutputPerMillion =
    existing.priceOutputPerMillion.source === "operator" ? existing.priceOutputPerMillion : buildField(parsed?.priceOutputPerMillion, undefined);
  const contextLength = existing.contextLength.source === "operator" ? existing.contextLength : buildField(parsed?.contextLength, undefined);
  const priority = existing.priority.source === "operator" ? existing.priority : { value: computeAutoPriority(priceInputPerMillion), source: "auto" as const };
  return {
    ...existing,
    strengthTier: tier,
    priceInputPerMillion,
    priceOutputPerMillion,
    contextLength,
    priority,
    available: true,
    chatCapable: resolveChatCapable(existing.modelId, parsed?.chatCapable),
    lastSeenAt: nowIso,
    refreshedAt: nowIso,
  };
}

function profilesEqualIgnoringTimestamps(a: ModelProfile, b: ModelProfile): boolean {
  return (
    JSON.stringify({ ...a, lastSeenAt: undefined, refreshedAt: undefined }) === JSON.stringify({ ...b, lastSeenAt: undefined, refreshedAt: undefined })
  );
}

/**
 * Diff `liveModelIds` (this refresh's live list for `providerId`) against the
 * stored catalogue and persist the result (AC2, AC9, AC15). Reused by both
 * `fetchOpenAiCompatModelsDetailed`'s opt-in `refreshProfiles` (AC2) and the
 * flow-309 live provider catalog (AC16), which passes ITS already-fetched
 * body's parsed fields — never a second network request.
 *
 * Best-effort: a storage failure is swallowed (matches every other writer in
 * this codebase, e.g. `saveShellConfig`) and the summary reflects what was
 * computed even if the save itself silently failed.
 *
 * The whole read-diff-write runs under `withModelProfilesLock` (AC3 rewrite
 * — the lock race finding): several providers refreshing at once (shell
 * startup, `providers status --refresh`), `providers test`, and a concurrent
 * `routing profile set` all serialize on the SAME lock, so two providers
 * refreshing concurrently both land their entries rather than one clobbering
 * the other's read-before-write.
 */
export async function refreshModelProfiles(
  providerId: string,
  liveModelIds: readonly string[],
  parsedFields: Readonly<Record<string, ParsedModelProfileFields>>,
  deps: ProfileRefreshDeps = {},
): Promise<ProfileRefreshSummary> {
  const now = deps.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();
  try {
    return await withModelProfilesLock(deps.dir, (store) => {
      const liveSet = new Set(liveModelIds);
      let added = 0;
      let changed = 0;
      let unavailable = 0;
      const next: Record<string, ModelProfile> = { ...store };

      for (const modelId of liveSet) {
        const key = profileKey(providerId, modelId);
        const existing = store[key];
        if (existing === undefined) {
          next[key] = freshProfile(providerId, modelId, parsedFields[modelId], nowIso);
          added += 1;
          continue;
        }
        const updated = updateProfile(existing, parsedFields[modelId], nowIso);
        if (!profilesEqualIgnoringTimestamps(existing, updated) || existing.available !== true) {
          changed += 1;
        }
        next[key] = updated;
      }

      // Every id previously stored for THIS provider but absent from this
      // refresh's live list — mark unavailable, keep everything else (AC9).
      // Other providers' entries are untouched (the `store[key]` spread above
      // already carries them through unchanged).
      for (const [key, profile] of Object.entries(store)) {
        if (profile.providerId !== providerId) continue;
        if (liveSet.has(profile.modelId)) continue;
        if (profile.available === false) continue; // already marked; not a new "went unavailable"
        next[key] = { ...profile, available: false, refreshedAt: nowIso };
        unavailable += 1;
      }

      writeModelProfilesFileUnlocked(next, deps.dir);
      return { added, changed, unavailable };
    });
  } catch {
    // Best-effort, like every other writer in this module — a lock timeout
    // or a write failure must never turn a successful `/models` fetch into a
    // failed one (this is called from inside `fetchOpenAiCompatModelsDetailed`).
    return { added: 0, changed: 0, unavailable: 0 };
  }
}

// ---------------------------------------------------------------------------
// Operator corrections (AC8) — `keryx routing profile set`/`/routing`'s
// profile editor. Persists the FULL effective profile (curated/guessed
// baseline materialized, not a sparse row) with the touched field's source
// forced to `"operator"` so a later refresh never overwrites it (PRD §6.1).
// ---------------------------------------------------------------------------

export type ModelProfileNumericFieldName = "priceInputPerMillion" | "priceOutputPerMillion" | "contextLength";
export type ModelProfileFieldName = "tier" | ModelProfileNumericFieldName | "priority";

export type ModelProfileFieldValue =
  | { readonly field: "tier"; readonly value: StrengthTier }
  | { readonly field: ModelProfileNumericFieldName; readonly value: number }
  | { readonly field: "priority"; readonly value: number };

/**
 * Set one field on one profile as an operator correction (AC8). Reads the
 * CURRENT effective profile (curated-merged, under the lock) as the base so
 * an untouched field keeps its prior value/source. The whole read-modify-
 * write runs under `withModelProfilesLock` (AC3 rewrite), the same lock
 * `refreshModelProfiles` uses, so a `routing profile set` racing a live
 * refresh never clobbers the other's write. Best-effort; never throws —
 * a lock timeout returns the CORRECTION as computed (so a caller still sees
 * what it asked for) even though it could not be persisted.
 */
export async function setModelProfileField(providerId: string, modelId: string, update: ModelProfileFieldValue, dir?: string, now: () => number = Date.now): Promise<ModelProfile> {
  const key = profileKey(providerId, modelId);
  const nowIso = new Date(now()).toISOString();
  const computeNext = (base: ModelProfile): ModelProfile => {
    switch (update.field) {
      case "tier":
        return { ...base, strengthTier: { value: update.value, source: "operator" } };
      case "priceInputPerMillion":
        return { ...base, priceInputPerMillion: { value: update.value, source: "operator" } };
      case "priceOutputPerMillion":
        return { ...base, priceOutputPerMillion: { value: update.value, source: "operator" } };
      case "contextLength":
        return { ...base, contextLength: { value: update.value, source: "operator" } };
      case "priority":
        return { ...base, priority: { value: update.value, source: "operator" } };
      default: {
        const exhaustive: never = update;
        return exhaustive;
      }
    }
  };
  const fallbackBase: ModelProfile = {
    providerId,
    modelId,
    strengthTier: guessStrengthTier(modelId),
    priceInputPerMillion: { value: "unknown", source: "unknown" },
    priceOutputPerMillion: { value: "unknown", source: "unknown" },
    contextLength: { value: "unknown", source: "unknown" },
    priority: { value: PRIORITY_UNKNOWN_PRICE, source: "auto" },
    available: true,
    chatCapable: resolveChatCapable(modelId),
    lastSeenAt: nowIso,
    refreshedAt: nowIso,
  };
  try {
    return await withModelProfilesLock(dir, (store) => {
      const nowIsoSeed = new Date(now()).toISOString();
      const effective = { ...curatedSeedProfiles(nowIsoSeed), ...store };
      const base = effective[key] ?? fallbackBase;
      const next = computeNext(base);
      const nextStore = { ...store, [key]: next };
      writeModelProfilesFileUnlocked(nextStore, dir);
      return next;
    });
  } catch {
    return computeNext(fallbackBase);
  }
}

// ---------------------------------------------------------------------------
// Display (AC8, AC12) — shared formatting so the CLI and TUI never diverge.
// ---------------------------------------------------------------------------

export function formatNumericField(field: NumericProfileField, unit: string): string {
  if (field.value === "unknown") return "unknown";
  return `${field.value}${unit} (${field.source})`;
}

export function formatModelProfileLine(profile: ModelProfile): string {
  const status = profile.available ? "available" : "unavailable";
  return [
    `${profile.providerId}/${profile.modelId}`,
    `tier=${profile.strengthTier.value} (${profile.strengthTier.source})`,
    `in=${formatNumericField(profile.priceInputPerMillion, "/M")}`,
    `out=${formatNumericField(profile.priceOutputPerMillion, "/M")}`,
    `context=${profile.contextLength.value === "unknown" ? "unknown" : `${profile.contextLength.value} (${profile.contextLength.source})`}`,
    `priority=${profile.priority.value} (${profile.priority.source})`,
    status,
    ...(isModelDerivable(profile) ? [] : ["non-chat/free — never auto-derived"]),
  ].join("  ");
}
