// Flow 327 (Routing A2) — model profiles: what keryx honestly knows about
// each connected model (strength, price, context length) and where each
// field's value came from. PRD §6.1, docs/requirements/keryx-jev-router/PRD.md.
//
// Storage (AC3): per user, alongside `apiKeys`/`modelParams` in
// `src/lib/shell-config.ts` (`ShellConfig.modelProfiles`, a raw unvalidated
// field — same posture as `ShellConfig.routing`), keyed by
// `<providerId>/<modelId>`. `loadModelProfiles` merges that stored map with
// the curated seed (AC4) so the seed shows up from the FIRST read without a
// forced write — an operator correction (`setModelProfileField`, AC8) or a
// live refresh (`refreshModelProfiles`, AC2/AC9) is what actually persists a
// row; a bare read never writes.
//
// No TUI/CLI import here — pure data + pure functions, mirroring
// `./table.ts`'s own "no rendering deps" posture. `refreshModelProfiles` is
// the one function that touches disk (through `shell-config.ts`'s existing
// `dir?: string` test seam, defaulting to production like every other writer
// in this codebase).
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  OPENAI_MODELS,
} from "../../commands/curated-model-lists";
import { loadShellConfig, saveShellConfig } from "../../lib/shell-config";
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
  /** Last time this model was present in a live fetch (advances only while `available`). */
  readonly lastSeenAt: string;
  readonly refreshedAt: string;
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
}

function modelEntryId(entry: { id?: unknown; name?: unknown }): string | undefined {
  if (typeof entry.id === "string" && entry.id.length > 0) return entry.id;
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
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
    const entry = raw as { id?: unknown; name?: unknown; pricing?: unknown; context_length?: unknown };
    const id = modelEntryId(entry);
    if (id === undefined) continue;
    const fields: { priceInputPerMillion?: number; priceOutputPerMillion?: number; contextLength?: number } = {};
    const pricing = entry.pricing;
    if (typeof pricing === "object" && pricing !== null) {
      const prompt = usdPerTokenToPerMillion((pricing as { prompt?: unknown }).prompt);
      if (prompt !== undefined) fields.priceInputPerMillion = prompt;
      const completion = usdPerTokenToPerMillion((pricing as { completion?: unknown }).completion);
      if (completion !== undefined) fields.priceOutputPerMillion = completion;
    }
    const contextLength = entry.context_length;
    if (typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0) {
      fields.contextLength = contextLength;
    }
    if (Object.keys(fields).length > 0) out[id] = fields;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage (AC3) — raw read/write through `shell-config.ts`'s `modelProfiles`
// field, validated on the way in (a hand-edited or stale-shaped entry is
// dropped rather than trusted, same posture as `provider-catalog-cache.ts`'s
// `sanitizeEntry`).
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
  return {
    providerId: record.providerId,
    modelId: record.modelId,
    strengthTier: { value: tier.value as StrengthTier, source: tier.source as ProfileSource },
    priceInputPerMillion,
    priceOutputPerMillion,
    contextLength,
    priority: { value: priority.value, source: priority.source as PrioritySource },
    available: record.available,
    lastSeenAt: record.lastSeenAt,
    refreshedAt: record.refreshedAt,
  };
}

/** Raw stored profiles only (no curated merge) — `{}` when absent/empty/malformed. Never throws. */
export function loadStoredModelProfiles(dir?: string): Record<string, ModelProfile> {
  const raw = loadShellConfig(dir).modelProfiles;
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ModelProfile> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const profile = sanitizeStoredProfile(value);
    if (profile !== undefined) out[key] = profile;
  }
  return out;
}

/** Persist the FULL stored map (overwrites `modelProfiles` wholesale — callers merge first). Best-effort; never throws. */
export function saveStoredModelProfiles(profiles: Record<string, ModelProfile>, dir?: string): void {
  saveShellConfig({ modelProfiles: profiles }, dir);
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
    lastSeenAt: nowIso,
    refreshedAt: nowIso,
  };
}

/** Update an EXISTING profile's non-`operator` fields from a fresh live sighting (AC7, AC9, AC18). */
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
 */
export async function refreshModelProfiles(
  providerId: string,
  liveModelIds: readonly string[],
  parsedFields: Readonly<Record<string, ParsedModelProfileFields>>,
  deps: ProfileRefreshDeps = {},
): Promise<ProfileRefreshSummary> {
  const now = deps.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();
  const store = loadStoredModelProfiles(deps.dir);
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

  saveStoredModelProfiles(next, deps.dir);
  return { added, changed, unavailable };
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

/** Set one field on one profile as an operator correction (AC8). Reads the CURRENT effective profile (curated-merged) as the base so an untouched field keeps its prior value/source. Best-effort; never throws. */
export function setModelProfileField(providerId: string, modelId: string, update: ModelProfileFieldValue, dir?: string, now: () => number = Date.now): ModelProfile {
  const key = profileKey(providerId, modelId);
  const nowIso = new Date(now()).toISOString();
  const effective = loadModelProfiles(dir, now);
  const base: ModelProfile =
    effective[key] ?? {
      providerId,
      modelId,
      strengthTier: guessStrengthTier(modelId),
      priceInputPerMillion: { value: "unknown", source: "unknown" },
      priceOutputPerMillion: { value: "unknown", source: "unknown" },
      contextLength: { value: "unknown", source: "unknown" },
      priority: { value: PRIORITY_UNKNOWN_PRICE, source: "auto" },
      available: true,
      lastSeenAt: nowIso,
      refreshedAt: nowIso,
    };
  let next: ModelProfile;
  switch (update.field) {
    case "tier":
      next = { ...base, strengthTier: { value: update.value, source: "operator" } };
      break;
    case "priceInputPerMillion":
      next = { ...base, priceInputPerMillion: { value: update.value, source: "operator" } };
      break;
    case "priceOutputPerMillion":
      next = { ...base, priceOutputPerMillion: { value: update.value, source: "operator" } };
      break;
    case "contextLength":
      next = { ...base, contextLength: { value: update.value, source: "operator" } };
      break;
    case "priority":
      next = { ...base, priority: { value: update.value, source: "operator" } };
      break;
    default: {
      const exhaustive: never = update;
      next = exhaustive;
    }
  }
  const store = loadStoredModelProfiles(dir);
  const nextStore = { ...store, [key]: next };
  saveStoredModelProfiles(nextStore, dir);
  return next;
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
  ].join("  ");
}
