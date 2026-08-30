// File-backed custom LLM provider registry (operator-defined; persisted by the
// in-TUI "add custom provider" wizard). Mirrors search-config.ts: best-effort,
// never throws, owner-only 0600 file in the keryx config dir.
//
// Custom providers are an EXPLICIT OPERATOR TRUST BOUNDARY: a URL the operator
// typed into their own config file is operator intent, so the egress gate
// re-permits RFC1918 private-LAN + loopback for them (see
// `customCompatProviders` in src/commands/providers.ts). Built-in providers
// stay denied on both.
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "./config-dir";

/** One operator-defined OpenAI-compatible provider, as persisted on disk. */
export interface CustomCompatProvider {
  /** Unique id used as the provider name (e.g. `internal-qwen`). */
  name: string;
  /** Human label shown in the picker; defaults to `name`. */
  label?: string;
  /** API base URL (before the chat/models path). */
  baseUrl: string;
  /** Optional bearer credential, stored in the same 0600 file. */
  apiKey?: string;
  /** False for keyless endpoints; defaults to true. */
  requiresApiKey?: boolean;
  /** Chat path appended to `baseUrl`; defaults to `/v1/chat/completions`. */
  chatPath?: string;
  /** Model-list path appended to `baseUrl`; defaults to `/v1/models`. */
  modelsPath?: string;
  /** Curated model ids (used when the live `/models` fetch fails). */
  models: string[];
  /** Short picker note. */
  note?: string;
}

interface LlmProvidersConfig {
  schemaVersion: 1;
  providers?: Record<string, CustomCompatProvider>;
}

/** Absolute path to the custom-provider registry file. */
export function llmProvidersConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "llm-providers.json");
}

function readJson(file: string): unknown | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const read = readConfigFile(file);
    return read.ok ? JSON.parse(read.text) : undefined;
  } catch {
    return undefined;
  }
}

/** Loose runtime shape guard for hand-edited files (never throws). */
export function isCustomCompatProvider(value: unknown): value is CustomCompatProvider {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    p.name.length > 0 &&
    typeof p.baseUrl === "string" &&
    p.baseUrl.length > 0 &&
    Array.isArray(p.models) &&
    p.models.every((m) => typeof m === "string")
  );
}

/**
 * Load every operator-defined custom provider. Returns `[]` for an absent,
 * malformed, or wrong-schema file — never throws, never surfaces an error.
 */
export function loadCustomCompatProviders(dir?: string): CustomCompatProvider[] {
  const value = readJson(llmProvidersConfigPath(dir));
  if (value === null || typeof value !== "object") return [];
  const record = value as Partial<LlmProvidersConfig>;
  if (record.schemaVersion !== 1 || record.providers === undefined || typeof record.providers !== "object") {
    return [];
  }
  return Object.values(record.providers)
    .filter(isCustomCompatProvider)
    .map((p) => ({
      ...p,
      name: p.name.trim(),
      baseUrl: p.baseUrl.replace(/\/+$/, ""),
      ...(typeof p.apiKey === "string" && p.apiKey.length > 0 ? { apiKey: p.apiKey } : {}),
    }));
}

// ---------------------------------------------------------------------------
// Cross-family review (flow 207, §5.4)
// ---------------------------------------------------------------------------
//
// The 1,000-PR study the roadmap cites reports ~8-10 recall points for reviewing
// with a different model family than authored the code (Claude->Claude 53.7% vs
// GPT->Claude 62.0%; GPT->GPT 50.5% vs Claude->GPT 60.0%). Nothing in the
// pipeline read the configured providers to make that choice.
//
// THIS FILE, AND NOT A NEW ONE. AC9 is "do not introduce a second source of
// provider truth", so the decision sits next to the loader that already owns
// `llm-providers.json`. The candidate list is an ARGUMENT rather than something
// looked up here, exactly as `rankDiscoveredModels` takes its catalogue: the
// caller assembles it from `allOpenAiCompatProviders()` (built-ins + this file's
// custom entries), which keeps the dependency pointing one way and makes the
// decision a pure function a test can drive without a config directory.
//
// WHAT IS NOT HERE, deliberately: no table of models. `MODEL_FAMILY_HINTS` names
// VENDOR WORDS and applies them to whatever is configured, the same shape
// `MODEL_RANK_HINTS` (src/gdskills/model-tier.ts) settled on for capability. A
// word list makes no claim about which models exist and cannot go stale when a
// vendor ships one.
//
// THE REFUSAL IS THE POINT. A gateway (`openrouter`) and a local runner
// (`ollama`, `rapid-mlx`) are not families: they front many. Classifying one as
// a family would let "cross-family" be recorded for a round that in fact ran on
// the same family twice, which is worse than not offering the feature — it makes
// a later recall comparison read a difference that was never there. Such a
// provider is therefore unclassifiable AT THE PROVIDER LEVEL and contributes
// candidates only through the specific models it lists.

/** One hint that an id contains a word naming its VENDOR. Ordinal-free; a label. */
export interface ModelFamilyHint {
  /** Case-insensitive regex source, tested against a provider id or a model id. */
  readonly pattern: string;
  /** The family label this word implies. */
  readonly family: string;
  /** Why this word, for whoever edits it next. */
  readonly note: string;
}

/**
 * Vendor words, and nothing else.
 *
 * Words this list does NOT contain are the honest part. `openrouter`, `groq`,
 * `cerebras`, `ollama` and `rapid-mlx` are absent because they name a place a
 * model runs, not who built it — see the refusal note above.
 */
export const MODEL_FAMILY_HINTS: readonly ModelFamilyHint[] = [
  { pattern: "\\banthropic\\b", family: "anthropic", note: "Anthropic, by vendor name" },
  { pattern: "\\bclaude\\b", family: "anthropic", note: "Anthropic's product line" },
  { pattern: "\\bopenai\\b", family: "openai", note: "OpenAI, by vendor name" },
  { pattern: "\\bgpt(?:-|\\b)", family: "openai", note: "OpenAI's product line" },
  { pattern: "\\bcodex\\b", family: "openai", note: "OpenAI's coding line" },
  { pattern: "\\b(?:google|vertex)\\b", family: "google", note: "Google, by vendor name" },
  { pattern: "\\bgemini\\b", family: "google", note: "Google's product line" },
  { pattern: "\\bdeepseek\\b", family: "deepseek", note: "DeepSeek, vendor and line" },
  { pattern: "\\b(?:moonshot|kimi)\\b", family: "moonshot", note: "Moonshot, vendor and line" },
  { pattern: "\\b(?:zai|z\\.ai|zhipu|glm)\\b", family: "zhipu", note: "Z.AI / Zhipu, vendor and line" },
  { pattern: "\\b(?:xai|grok)\\b", family: "xai", note: "xAI, vendor and line" },
  { pattern: "\\bmistral\\b", family: "mistral", note: "Mistral, vendor and line" },
  { pattern: "\\b(?:meta|llama)\\b", family: "meta", note: "Meta, vendor and line" },
  { pattern: "\\bqwen\\b", family: "alibaba", note: "Alibaba's Qwen line" },
];

/**
 * The family a bare id belongs to, or `null` when no hint applies.
 *
 * `null` is load-bearing: it means "we cannot say", and every caller treats that
 * as a refusal to claim a family difference rather than as a family of its own.
 * An id matching two hints is also `null` — an ambiguous name is not a family,
 * and guessing between them is the failure the whole design avoids.
 */
export function familyOf(id: string, hints: readonly ModelFamilyHint[] = MODEL_FAMILY_HINTS): string | null {
  const value = id.trim();
  if (value.length === 0) return null;
  const matched = new Set<string>();
  for (const hint of hints) {
    let re: RegExp;
    try {
      re = new RegExp(hint.pattern, "i");
    } catch {
      continue;
    }
    if (re.test(value)) matched.add(hint.family);
  }
  return matched.size === 1 ? ([...matched][0] as string) : null;
}

/** One provider/model pair that could review, with the family it belongs to. */
export interface CrossFamilyCandidate {
  readonly provider: string;
  /** The specific model, when the family came from a model id rather than the provider. */
  readonly model: string | null;
  readonly family: string;
}

/** A configured provider, as the caller assembled it from the registry + custom file. */
export interface ConfiguredProvider {
  readonly name: string;
  readonly models?: readonly string[];
}

/** What the caller knows before deciding. */
export interface CrossFamilyReviewInput {
  /**
   * AC10. `false` means single-family, always, with the reason recorded.
   * Dispatching to another provider spends tokens and sends the operator's code
   * to a second vendor; that is a decision, and it is never taken by default.
   */
  readonly optIn: boolean;
  /** The provider/model the change was authored on. */
  readonly session: { readonly providerId: string; readonly modelId: string };
  /** Providers the operator has actually configured. */
  readonly configured: readonly ConfiguredProvider[];
}

/**
 * The record a round carries (AC10).
 *
 * Serialisable by construction so the review pipeline can embed it verbatim.
 * `reviewer_family` next to `author_family` is what makes a recall comparison
 * possible later; `mode` alone would not, because "cross-family" without naming
 * the two families cannot be grouped after the fact.
 */
export interface CrossFamilyReviewDecision {
  readonly schemaVersion: 1;
  readonly mode: "cross-family" | "single-family";
  /** Whether cross-family review was ASKED FOR. Recorded separately from `mode`. */
  readonly requested: boolean;
  /** The family that authored the change, or `null` when it could not be named. */
  readonly author_family: string | null;
  /** The family that will review, or `null` when review stays single-family. */
  readonly reviewer_family: string | null;
  readonly reviewer_provider: string | null;
  readonly reviewer_model: string | null;
  /** One sentence. Always present, including on the happy path. */
  readonly reason: string;
  /** Every other-family option that was on the table when the decision was made. */
  readonly candidates: readonly CrossFamilyCandidate[];
}

/**
 * Every other-family provider/model the operator has configured.
 *
 * A provider whose OWN id names a vendor contributes that family once. A gateway
 * or local runner contributes nothing by itself and instead contributes one
 * candidate per listed model whose id names a vendor — which is how a
 * single-provider OpenRouter setup can still review across families, without
 * this file ever claiming that "openrouter" is a family.
 */
export function crossFamilyCandidates(
  configured: readonly ConfiguredProvider[],
  authorFamily: string | null,
  hints: readonly ModelFamilyHint[] = MODEL_FAMILY_HINTS,
): CrossFamilyCandidate[] {
  const out: CrossFamilyCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: CrossFamilyCandidate): void => {
    if (candidate.family === authorFamily) return;
    const key = `${candidate.provider} ${candidate.model ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  for (const provider of configured) {
    const providerFamily = familyOf(provider.name, hints);
    if (providerFamily !== null) {
      push({ provider: provider.name, model: null, family: providerFamily });
      continue;
    }
    for (const model of provider.models ?? []) {
      const modelFamily = familyOf(model, hints);
      if (modelFamily !== null) push({ provider: provider.name, model, family: modelFamily });
    }
  }
  return out;
}

/**
 * Decide whether this round reviews across families.
 *
 * Total and pure: every input yields a decision with a stated reason, and no
 * input yields a throw. AC11 is the shape of the whole function — the absence of
 * a second provider is a NORMAL state, so it produces `single-family` with a
 * reason, never an error and never a non-zero exit.
 */
export function decideCrossFamilyReview(
  input: CrossFamilyReviewInput,
  hints: readonly ModelFamilyHint[] = MODEL_FAMILY_HINTS,
): CrossFamilyReviewDecision {
  const authorFamily =
    familyOf(input.session.providerId, hints) ?? familyOf(input.session.modelId, hints);
  const candidates = crossFamilyCandidates(input.configured, authorFamily, hints);
  const base = {
    schemaVersion: 1,
    requested: input.optIn,
    author_family: authorFamily,
    candidates,
  } as const;
  const single = (reason: string): CrossFamilyReviewDecision => ({
    ...base,
    mode: "single-family",
    reviewer_family: null,
    reviewer_provider: null,
    reviewer_model: null,
    reason,
  });

  if (!input.optIn) {
    // AC10, stated first because it outranks everything below it: a configured
    // second vendor is not consent to send code to it.
    return single(
      "cross-family review was not requested; it is opt-in because dispatching to another provider spends tokens and sends the change to a second vendor",
    );
  }

  if (authorFamily === null) {
    return single(
      `cross-family review was requested, but the session provider "${input.session.providerId || "(none)"}" and model "${input.session.modelId || "(none)"}" carry no vendor marker the hints recognise, so no configured provider can be called a DIFFERENT family than the one that authored the change`,
    );
  }

  if (input.configured.length === 0) {
    return single(
      `cross-family review was requested, but no provider is configured beyond the ${authorFamily} session; single-family review is the normal state, not a failure`,
    );
  }

  const chosen = candidates[0];
  if (chosen === undefined) {
    return single(
      `cross-family review was requested, but none of the ${input.configured.length} configured provider(s) resolves to a family other than ${authorFamily}; single-family review is the normal state, not a failure`,
    );
  }

  return {
    ...base,
    mode: "cross-family",
    reviewer_family: chosen.family,
    reviewer_provider: chosen.provider,
    reviewer_model: chosen.model,
    reason: `cross-family review was requested and granted: the change was authored on ${authorFamily} and will be reviewed on ${chosen.family} via provider "${chosen.provider}"${chosen.model === null ? "" : ` (model "${chosen.model}")`}`,
  };
}

/** Merge `provider` into the persisted registry (0600). Best-effort; never throws. */
export function saveCustomCompatProvider(provider: CustomCompatProvider, dir?: string): void {
  try {
    ensureKeryxConfigDir(dir);
    const current = loadCustomCompatProviders(dir).reduce<Record<string, CustomCompatProvider>>((acc, p) => {
      acc[p.name] = p;
      return acc;
    }, {});
    current[provider.name] = provider;
    writeOwnerOnlyFile(
      llmProvidersConfigPath(dir),
      `${JSON.stringify({ schemaVersion: 1, providers: current }, null, 2)}\n`,
    );
  } catch {
    // best-effort persistence — a failure just means the provider is re-entered
  }
}
