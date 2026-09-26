// Flow 346 — the EXTERNAL switch's editable block-list: which providers and
// model-id patterns count as "external" when `/external off` is in effect.
//
// User-editable, at `<keryx config dir>/external-providers.json`, created
// with the built-in defaults on first use (never overwritten once it
// exists) — same "operator-owned, keryx only seeds it" contract as
// `llm-providers.json` (custom OpenAI-compat providers). `keryx external
// list` prints the effective, on-disk list.
//
// This module is `src/lib/` (SHARED zone) so it can be read from the CLIENT
// choke point (`jev-client.ts`) and composed into the routing choke point
// (`harness/routing/table.ts`'s `ConnectedPredicate`, structurally matched
// here without an import — see `ExternalConnectedPredicate` below) without
// crossing a zone boundary.
import path from "node:path";
import { ensureKeryxConfigDir, isDefiniteAbsence, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "./config-dir";

export interface ExternalProviderEntry {
  /** A keryx provider id (`keryx providers list`) or the synthetic id `"jev"` (Jev/TypeSafe System One — not a `ProviderPort`, see `jev-client.ts`'s own header). Matched case-insensitively. */
  readonly id: string;
  /** Why this id is on the list — shown by `keryx external list` and folded into `ExternalBlockedError`'s message. */
  readonly reason: string;
}

export interface ExternalModelPatternEntry {
  /** A `*`-wildcard, case-insensitive glob matched against a model id — typically an OpenRouter vendor prefix (`"deepseek/*"`) or suffix (`"*:free"`). */
  readonly pattern: string;
  readonly reason: string;
}

export interface ExternalProvidersConfig {
  readonly version: 1;
  readonly providers: readonly ExternalProviderEntry[];
  readonly modelPatterns: readonly ExternalModelPatternEntry[];
  readonly notes: string;
}

/**
 * The built-in defaults (design §2) — the operator is expected to adjust
 * this list; each entry names WHY it starts here so an edit is an informed
 * one:
 *
 *   - `jev`: Jev/TypeSafe System One (OpenRouter's `/api/v1/systemone`)
 *     receives code, diffs and CI-log excerpts on every review/triage/
 *     edit-guard/select/routing-classifier/turn-guard call — the one
 *     destination this whole flow exists to gate.
 *   - `deepseek`, `zai`/`zai-coding`, `moonshot`: keryx's own direct
 *     OpenAI-compatible provider ids (`src/commands/providers.ts`) for
 *     vendors hosted under jurisdictions/terms where a prompt may be
 *     retained or trained on — connecting to them directly (not only via
 *     OpenRouter) sends the same private work just as surely.
 *   - the `modelPatterns` vendor prefixes (`deepseek/*`, `minimax/*`,
 *     `z-ai/*`/`zhipu/*`/`glm/*`, `moonshotai/*`, `qwen/*`/`alibaba/*`,
 *     `baidu/*`, `tencent/*`, `bytedance/*`, `01-ai/*`): the SAME vendors,
 *     reached instead through an OpenRouter model id — keryx has no
 *     first-class provider for several of them (minimax, qwen/alibaba,
 *     baidu, tencent, bytedance, 01-ai), so the block has to be model-id
 *     shaped rather than provider-id shaped to reach them at all.
 *   - `*:free`: OpenRouter's free-tier model ids — the free tier is
 *     documented as sometimes prompt-logged/trained-on by the underlying
 *     provider, which is unaudited per-model, so the whole tier is treated
 *     as untrusted by default.
 *   - `*muse*`: any model id containing "muse" — named explicitly by the
 *     operator, not a vendor-prefix inference.
 *
 * Deliberately OFF this list (design §2): the mainstream paid US providers
 * the operator connects directly — Anthropic, OpenAI, Google/Gemini,
 * GitHub Copilot, xAI (`grok`), Groq — plus local/loopback providers
 * (`rapid-mlx`) and Cerebras, none of which this flow's operator named as
 * questionable.
 */
export const DEFAULT_EXTERNAL_PROVIDERS_CONFIG: ExternalProvidersConfig = {
  version: 1,
  providers: [
    { id: "jev", reason: "Jev/TypeSafe System One (OpenRouter /api/v1/systemone) — receives code, diffs and CI-log excerpts on every review/triage/edit-guard/select call." },
    { id: "deepseek", reason: "DeepSeek — direct API, prompts may be retained/trained on under its terms." },
    { id: "zai", reason: "Z.AI (GLM) — direct API, prompts may be retained/trained on under its terms." },
    { id: "zai-coding", reason: "Z.AI GLM Coding Plan — same vendor/terms as \"zai\"." },
    { id: "moonshot", reason: "Moonshot (Kimi) — direct API, prompts may be retained/trained on under its terms." },
  ],
  modelPatterns: [
    { pattern: "deepseek/*", reason: "DeepSeek via OpenRouter — same vendor as the direct \"deepseek\" provider." },
    { pattern: "minimax/*", reason: "MiniMax — no direct keryx provider; reachable only via an OpenRouter model id." },
    { pattern: "z-ai/*", reason: "Z.AI (GLM) via OpenRouter — same vendor as the direct \"zai\" provider." },
    { pattern: "zhipu/*", reason: "Zhipu — Z.AI's model org under an older OpenRouter naming; same vendor as \"z-ai/*\"." },
    { pattern: "glm/*", reason: "GLM — an alternate OpenRouter vendor prefix for Zhipu/Z.AI models." },
    { pattern: "moonshotai/*", reason: "Moonshot AI (Kimi) via OpenRouter — same vendor as the direct \"moonshot\" provider." },
    { pattern: "qwen/*", reason: "Qwen (Alibaba) — no direct keryx provider; reachable only via an OpenRouter model id." },
    { pattern: "alibaba/*", reason: "Alibaba — an alternate OpenRouter vendor prefix for Qwen models." },
    { pattern: "baidu/*", reason: "Baidu (Ernie) — no direct keryx provider; reachable only via an OpenRouter model id." },
    { pattern: "tencent/*", reason: "Tencent (Hunyuan) — no direct keryx provider; reachable only via an OpenRouter model id." },
    { pattern: "bytedance/*", reason: "ByteDance — no direct keryx provider; reachable only via an OpenRouter model id." },
    { pattern: "01-ai/*", reason: "01.AI (Yi) — no direct keryx provider; reachable only via an OpenRouter model id." },
    { pattern: "*:free", reason: "OpenRouter free-tier models — the underlying provider's logging/training policy for the free tier is unaudited per-model." },
    { pattern: "*muse*", reason: "Operator-named explicitly, by model id substring." },
  ],
  notes:
    "Edit this file to change what `/external off` blocks. `providers`: a keryx provider id " +
    "(`keryx providers list`) or the synthetic id \"jev\" (Jev/TypeSafe, not a ProviderPort). " +
    "`modelPatterns`: a `*`-wildcard, case-insensitive glob matched against a model id — typically " +
    "an OpenRouter vendor prefix (\"deepseek/*\") or a tier suffix (\"*:free\"). Every entry's `reason` " +
    "is shown by `keryx external list` and folded into the block message. Deleting an entry, or the " +
    "whole file (keryx recreates it with these defaults), re-allows that destination even with " +
    "external off. `version` is this file's own schema version — keryx does not yet migrate it, but " +
    "reserves the field so a future release can.",
};

export function externalProvidersConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "external-providers.json");
}

/** Where a `loadExternalProvidersConfig` result actually came from. */
export type ExternalProvidersConfigOrigin = "default-created" | "default-fallback-malformed" | "user-file";

export interface LoadedExternalProvidersConfig {
  readonly config: ExternalProvidersConfig;
  readonly origin: ExternalProvidersConfigOrigin;
  readonly path: string;
  /** Set only for `origin: "default-fallback-malformed"` — the reason the on-disk file was ignored. */
  readonly warning?: string;
}

function isProviderEntry(value: unknown): value is ExternalProviderEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id.length > 0 && (v.reason === undefined || typeof v.reason === "string");
}

function isPatternEntry(value: unknown): value is ExternalModelPatternEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.pattern === "string" && v.pattern.length > 0 && (v.reason === undefined || typeof v.reason === "string");
}

/**
 * Loosely validates a parsed `external-providers.json`: `providers`/
 * `modelPatterns` must be arrays of entries with at least the required
 * string field (`reason` defaults to `""` when a hand-edited entry omits
 * it — a missing reason is a documentation gap, not a reason to fall back
 * to the built-in defaults wholesale). Returns `undefined` when the shape
 * is not salvageable at all (not an object, or either array field present
 * but not an array).
 */
export function validateExternalProvidersConfig(parsed: unknown): ExternalProvidersConfig | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const v = parsed as Record<string, unknown>;
  const rawProviders = v.providers;
  const rawPatterns = v.modelPatterns;
  if (rawProviders !== undefined && !Array.isArray(rawProviders)) return undefined;
  if (rawPatterns !== undefined && !Array.isArray(rawPatterns)) return undefined;
  const providers: ExternalProviderEntry[] = ((rawProviders as unknown[] | undefined) ?? [])
    .filter(isProviderEntry)
    .map((entry) => ({ id: entry.id, reason: entry.reason ?? "" }));
  const modelPatterns: ExternalModelPatternEntry[] = ((rawPatterns as unknown[] | undefined) ?? [])
    .filter(isPatternEntry)
    .map((entry) => ({ pattern: entry.pattern, reason: entry.reason ?? "" }));
  return {
    version: 1,
    providers,
    modelPatterns,
    notes: typeof v.notes === "string" ? v.notes : DEFAULT_EXTERNAL_PROVIDERS_CONFIG.notes,
  };
}

/**
 * Load the effective external-providers list. Missing -> create it with the
 * built-in defaults and return those (`origin: "default-created"`).
 * Present but unreadable/unparsable/not-salvageable -> fall back to the
 * built-in defaults IN MEMORY (never overwrite whatever is actually on disk)
 * with a `warning` (AC5). Present and valid -> the on-disk content
 * (`origin: "user-file"`), which may legitimately be an EMPTY list — an
 * operator who wants `/external off` to block nothing gets exactly that,
 * not a silent revert to the defaults.
 */
export function loadExternalProvidersConfig(dir?: string): LoadedExternalProvidersConfig {
  const file = externalProvidersConfigPath(dir);
  const read = readConfigFile(file);
  if (!read.ok) {
    if (isDefiniteAbsence(read.reason)) {
      try {
        ensureKeryxConfigDir(dir);
        writeOwnerOnlyFileAtomic(file, `${JSON.stringify(DEFAULT_EXTERNAL_PROVIDERS_CONFIG, null, 2)}\n`);
      } catch {
        // Best-effort, like every other config-dir writer — the caller still
        // gets a correct in-memory default even if persisting it failed.
      }
      return { config: DEFAULT_EXTERNAL_PROVIDERS_CONFIG, origin: "default-created", path: file };
    }
    return {
      config: DEFAULT_EXTERNAL_PROVIDERS_CONFIG,
      origin: "default-fallback-malformed",
      path: file,
      warning: `${file} could not be read (${read.reason}) — using the built-in defaults for this run.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return {
      config: DEFAULT_EXTERNAL_PROVIDERS_CONFIG,
      origin: "default-fallback-malformed",
      path: file,
      warning: `${file} is not valid JSON — using the built-in defaults for this run.`,
    };
  }
  const validated = validateExternalProvidersConfig(parsed);
  if (validated === undefined) {
    return {
      config: DEFAULT_EXTERNAL_PROVIDERS_CONFIG,
      origin: "default-fallback-malformed",
      path: file,
      warning: `${file} is not a valid external-providers.json (expected {version, providers[], modelPatterns[], notes}) — using the built-in defaults for this run.`,
    };
  }
  return { config: validated, origin: "user-file", path: file };
}

/** `*` -> `.*`, everything else literal, case-insensitive, anchored both ends. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function isProviderIdExternal(providerId: string, config: ExternalProvidersConfig): boolean {
  const needle = providerId.toLowerCase();
  return config.providers.some((entry) => entry.id.toLowerCase() === needle);
}

export function isModelIdExternal(modelId: string, config: ExternalProvidersConfig): boolean {
  return config.modelPatterns.some((entry) => patternToRegExp(entry.pattern).test(modelId));
}

/** The first matching entry's `reason`, provider match checked before model-pattern match. `undefined` when neither matches. */
export function externalBlockReason(providerId: string | undefined, modelId: string | undefined, config: ExternalProvidersConfig): string | undefined {
  if (providerId !== undefined) {
    const needle = providerId.toLowerCase();
    const hit = config.providers.find((entry) => entry.id.toLowerCase() === needle);
    if (hit !== undefined) return hit.reason;
  }
  if (modelId !== undefined) {
    const hit = config.modelPatterns.find((entry) => patternToRegExp(entry.pattern).test(modelId));
    if (hit !== undefined) return hit.reason;
  }
  return undefined;
}

/**
 * Structurally identical to `src/harness/routing/table.ts`'s
 * `ConnectedPredicate` — kept as a LOCAL type (not an import) so this SHARED
 * module never depends on `harness` (CLIENT zone); TypeScript's structural
 * typing lets a caller pass this straight into `resolveCategoryDetailed`/
 * `resolveCategory` without a cast.
 */
export type ExternalConnectedPredicate = (providerId: string, modelId?: string) => boolean;

/**
 * The routing choke point (design §3): wrap an existing `ConnectedPredicate`
 * (`connectedPredicateFrom`, `harness/routing/table.ts`) so a candidate
 * naming an externally-blocked provider or model reads as "not connected" —
 * `resolveCategoryDetailed` already falls through to the next layer (and
 * reports the fallback in `notices`, never silently) for that outcome, so
 * this is additive, not a new fallback path. A no-op (`base` returned
 * unchanged) when external is on.
 */
export function externalAllowedConnectedPredicate(
  base: ExternalConnectedPredicate,
  externalOn: boolean,
  config: ExternalProvidersConfig,
): ExternalConnectedPredicate {
  if (externalOn) return base;
  return (providerId, modelId) => {
    if (isProviderIdExternal(providerId, config)) return false;
    if (modelId !== undefined && isModelIdExternal(modelId, config)) return false;
    return base(providerId, modelId);
  };
}
