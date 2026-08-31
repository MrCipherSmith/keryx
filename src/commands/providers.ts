// OpenAI-Chat-Completions-compatible provider registry (flow 085).
//
// Every entry here is reachable with just a base URL + a Bearer API key, so a
// single OpenAI-compatible adapter (`OllamaProvider` with an `apiKey`/`baseUrl`
// grant) serves all of them — see `makeProvider`. The registry is the ONE source
// of truth consumed by `detectProviders` (which providers to offer), the in-TUI
// picker (label / API-key prompt / live model fetch), and `makeProvider`
// (base URL + env var + chat path). Pure data + a pure fetch helper; no key is
// ever stored on these shapes or logged.
//
// Base URL = the part BEFORE the chat path. Most gateways answer at
// `{baseUrl}/v1/chat/completions` + `{baseUrl}/v1/models`; Z.AI's GLM endpoints
// are versioned `…/paas/v4` and answer at `/chat/completions` + `/models`
// (no `/v1`), hence the per-provider `chatPath`/`modelsPath` overrides.

import {
  type ConfiguredProvider,
  type CrossFamilyReviewDecision,
  decideCrossFamilyReview,
  familyOf,
  loadCustomCompatProviders,
} from "../lib/provider-config";
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";
import { optionValue } from "../lib/args";

/** A hosted OpenAI-compatible provider offered in the picker. */
export interface OpenAiCompatProvider {
  /** Stable id used as the provider name (e.g. `deepseek`). */
  name: string;
  /** Human label shown in the picker (e.g. `DeepSeek`). */
  label: string;
  /** API base URL (before the chat/models path). */
  baseUrl: string;
  /** Env var carrying the Bearer key (e.g. `DEEPSEEK_API_KEY`). */
  envKey?: string;
  /** False for local/edge OpenAI-compatible services that do not require a key (e.g. local Rapid/MLX). */
  requiresApiKey?: boolean;
  /** Optional platform allow-list for providers that are only valid on some OSes. */
  platforms?: readonly NodeJS.Platform[];
  /** Optional explicit SSRF-loopback opt-in for local/private endpoints (e.g. 127.0.0.1). */
  allowLoopback?: boolean;
  /** Chat path appended to `baseUrl`; defaults to `/v1/chat/completions`. */
  chatPath?: string;
  /** Model-list path appended to `baseUrl`; defaults to `/v1/models`. */
  modelsPath?: string;
  /** Curated fallback model ids (used when the live `/models` fetch fails). */
  models: string[];
  /** Optional in-file Bearer credential (custom file providers) — read directly, never env. */
  apiKey?: string;
  /**
   * Operator opt-in for custom file providers only: re-permits RFC1918
   * private-LAN egress for a hostname typed into the operator's own config.
   * Built-ins are never granted this. Metadata/link-local stay denied.
   */
  allowPrivateLan?: boolean;
  /** Short picker note (e.g. `coding plan`). */
  note?: string;
  /**
   * Optional balance-check endpoint (path appended to `baseUrl`) for providers
   * that expose one. `balanceKind` selects the response parser; absent when the
   * provider has no public balance API (Z.AI, Cerebras, Groq, Moonshot, Grok…).
   */
  balancePath?: string;
  balanceKind?: "deepseek" | "openrouter";
}

/** Normalize a provider registry entry's platform policy.
 * - If `platforms` is absent/empty, provider is treated as cross-platform.
 * - If `requiresApiKey` is absent, default is true.
 */
export function isProviderPlatformSupported(
  provider: OpenAiCompatProvider,
  platform: string = process.platform,
): boolean {
  if (provider.platforms === undefined || provider.platforms.length === 0) {
    return true;
  }
  return provider.platforms.includes(platform as NodeJS.Platform);
}

/** Default OpenAI-compatible chat + models paths (OpenRouter/DeepSeek/Groq/…). */
export const DEFAULT_CHAT_PATH = "/v1/chat/completions";
export const DEFAULT_MODELS_PATH = "/v1/models";

/** Environment variable used to override a built-in provider's API endpoint. */
export function providerBaseUrlEnvKey(providerName: string): string {
  return `KERYX_${providerName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_BASE_URL`;
}

/** Resolve a provider endpoint from a safe environment override when present. */
export function resolveProviderBaseUrl(
  provider: OpenAiCompatProvider,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env[providerBaseUrlEnvKey(provider.name)]?.trim();
  if (override === undefined || override.length === 0) return provider.baseUrl;
  try {
    const url = new URL(override);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username.length > 0 || url.password.length > 0) {
      return provider.baseUrl;
    }
    return override.replace(/\/+$/, "");
  } catch {
    return provider.baseUrl;
  }
}

/**
 * The registry, in picker order. All are ALWAYS offered (a key is prompted +
 * persisted in-TUI when absent). Curated `models` are a fallback only — the
 * picker fetches each provider's LIVE `/models` list (filterable by name).
 */
export const OPENAI_COMPAT_PROVIDERS: readonly OpenAiCompatProvider[] = [
  {
    name: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    envKey: "OPENROUTER_API_KEY",
    models: ["openai/gpt-4o-mini", "google/gemini-2.0-flash-001", "qwen/qwen-2.5-7b-instruct", "meta-llama/llama-3.1-8b-instruct"],
    note: "hosted · 400+ models",
    // GET /api/v1/credits -> { credits: { total, used, remaining, total_usd, ... } }
    balancePath: "/api/v1/credits",
    balanceKind: "openrouter",
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "cheap per-token",
    // GET /user/balance -> { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
    balancePath: "/user/balance",
    balanceKind: "deepseek",
  },
  {
    name: "zai",
    label: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    envKey: "ZAI_API_KEY",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    // Curated fallback when live GET /models fails (auth missing, offline, …).
    // Newest first — matches https://docs.z.ai (GLM-5.2 / 5.1 / 5 / 4.7 …).
    models: [
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.6",
      "glm-4.5",
      "glm-4.5-air",
    ],
    note: "GLM API",
  },
  {
    name: "zai-coding",
    label: "Z.AI GLM Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    envKey: "ZAI_API_KEY",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    // Coding Plan docs: all plans support GLM-5.2, GLM-5-Turbo, GLM-4.7.
    // Live /models needs a Bearer key — without it the picker uses this list.
    models: [
      "glm-5.2",
      "glm-5-turbo",
      "glm-5",
      "glm-4.7",
      "glm-4.6",
      "glm-4.5",
    ],
    note: "coding plan (flat rate)",
  },
  {
    name: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai",
    envKey: "CEREBRAS_API_KEY",
    models: ["llama-3.3-70b", "llama-3.1-8b", "gpt-oss-120b", "qwen-3-32b"],
    note: "Cerebras Code plan · fast",
  },
  {
    name: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai",
    envKey: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gpt-oss-120b"],
    note: "free tier · fast",
  },
  {
    name: "rapid-mlx",
    label: "Rapid-MLX (Local)",
    baseUrl: "http://127.0.0.1:8010",
    requiresApiKey: false,
    allowLoopback: true,
    platforms: ["darwin"],
    // Local servers are authoritative for their installed model inventory.
    // Do not offer a guessed model when `/v1/models` is unavailable.
    models: [],
    note: "local · no key",
  },
  {
    name: "moonshot",
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai",
    envKey: "MOONSHOT_API_KEY",
    models: ["kimi-k2-turbo-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
    note: "Kimi",
  },
  {
    name: "grok",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai",
    envKey: "XAI_API_KEY",
    models: ["grok-2-latest", "grok-2", "grok-beta"],
    note: "xAI · OpenAI-compatible",
  },
];

/** Look up a registry provider by its `name`. */
export function providerByName(name: string): OpenAiCompatProvider | undefined {
  return allOpenAiCompatProviders().find((p) => p.name === name);
}

/**
 * Operator-defined custom providers from `llm-providers.json` (the in-TUI
 * "add custom provider" wizard), mapped onto the registry shape. Custom
 * entries are an explicit operator trust boundary: `allowLoopback` +
 * `allowPrivateLan` re-permit loopback and RFC1918 private-LAN egress for
 * them (a URL the operator typed into their own 0600 config file is operator
 * intent), while built-in providers remain denied on both. A custom entry
 * whose `name` collides with a built-in is excluded (built-ins win).
 */
export function customCompatProviders(dir?: string): OpenAiCompatProvider[] {
  const builtinNames = new Set(OPENAI_COMPAT_PROVIDERS.map((p) => p.name));
  return loadCustomCompatProviders(dir)
    .filter((p) => !builtinNames.has(p.name))
    .map((p): OpenAiCompatProvider => ({
      name: p.name,
      label: p.label ?? p.name,
      baseUrl: p.baseUrl,
      ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}),
      requiresApiKey: false,
      allowLoopback: true,
      allowPrivateLan: true,
      ...(p.chatPath !== undefined ? { chatPath: p.chatPath } : {}),
      ...(p.modelsPath !== undefined ? { modelsPath: p.modelsPath } : {}),
      models: p.models,
      ...(p.note !== undefined ? { note: p.note } : {}),
    }));
}

/** Built-in + operator-defined custom providers, in picker order. */
export function allOpenAiCompatProviders(dir?: string): OpenAiCompatProvider[] {
  return [...OPENAI_COMPAT_PROVIDERS, ...customCompatProviders(dir)];
}

/** Default network timeout for live `/models` probes (offline must not hang the picker). */
export const MODELS_FETCH_TIMEOUT_MS = 10_000;

export type ModelsResolveSource = "live" | "fallback";

export interface ModelsResolveResult {
  models: string[];
  /** `live` when the provider's HTTP `/models` returned at least one id. */
  source: ModelsResolveSource;
}

/**
 * Fetch a provider's LIVE model list (`GET {baseUrl}{modelsPath}`), sending the
 * Bearer `apiKey` when present (some `/models` endpoints require auth; OpenRouter's
 * is public). ALWAYS attempts the network when `fetchFn` is available — curated
 * `models` are only a fallback for offline / non-2xx / timeout / empty body.
 * Never throws.
 */
export async function fetchOpenAiCompatModels(
  fetchFn: typeof fetch,
  provider: OpenAiCompatProvider,
  apiKey?: string,
  opts?: { timeoutMs?: number },
): Promise<string[]> {
  const result = await fetchOpenAiCompatModelsDetailed(fetchFn, provider, apiKey, opts);
  return result.models;
}

/**
 * Same as {@link fetchOpenAiCompatModels} but reports whether the list came from
 * the live endpoint or the curated fallback (for UI status lines / tests).
 */
export async function fetchOpenAiCompatModelsDetailed(
  fetchFn: typeof fetch,
  provider: OpenAiCompatProvider,
  apiKey?: string,
  opts?: { timeoutMs?: number },
): Promise<ModelsResolveResult> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}${provider.modelsPath ?? DEFAULT_MODELS_PATH}`;
  const timeoutMs = opts?.timeoutMs ?? MODELS_FETCH_TIMEOUT_MS;
  // A failed discovery must never turn curated/documentary ids into selectable
  // models: only the provider's live `/models` response is authoritative.
  const fallback: ModelsResolveResult = { models: [], source: "fallback" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (apiKey !== undefined && apiKey.length > 0) {
      init.headers = { authorization: `Bearer ${apiKey}` };
    }
    const res = await fetchFn(url, init);
    if (!res.ok) {
      return fallback;
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> } | null;
    const ids = Array.isArray(body?.data)
      ? body.data
          .map((m) => {
            if (typeof m.id === "string" && m.id.length > 0) {
              return m.id;
            }
            // Some gateways put the model id in `name` instead of `id`.
            if (typeof m.name === "string" && m.name.length > 0) {
              return m.name;
            }
            return "";
          })
          .filter((id) => id.length > 0)
      : [];
    if (ids.length === 0) {
      return fallback;
    }
    return { models: Array.from(new Set(ids)).sort(), source: "live" };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the model list for a picker entry: registry OpenAI-compat providers
 * ALWAYS hit live `/models` when the network is available (Bearer key from
 * `env` when required); ollama/anthropic/fake keep their already-detected list.
 * Never throws.
 */
export async function resolveModelsForPicker(
  fetchFn: typeof fetch,
  provider: { name: string; models: string[]; baseUrl?: string; envKey?: string },
  env: Record<string, string | undefined> = process.env,
  opts?: { timeoutMs?: number },
): Promise<ModelsResolveResult> {
  const compat = providerByName(provider.name);
  if (compat === undefined) {
    return { models: [...provider.models], source: "fallback" };
  }
  const envKey = provider.envKey ?? compat.envKey;
  const raw = envKey === undefined ? undefined : env[envKey];
  const apiKey = typeof raw === "string" && raw.length > 0 ? raw : compat.apiKey;
  return fetchOpenAiCompatModelsDetailed(
    fetchFn,
    { ...compat, ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}) },
    apiKey,
    opts,
  );
}


// --- balance ----------------------------------------------------------------

/** Normalized provider balance (null when the provider has no balance API). */
export interface ProviderBalance {
  /** Currency code the amounts are in (e.g. "USD"). */
  currency: string;
  /** Total balance available to spend. */
  total: number;
  /** Amount already spent (OpenRouter). Undefined when not reported. */
  used?: number;
  /** Amount remaining after spend (OpenRouter). Undefined when not reported. */
  remaining?: number;
  /** True when the response was provider-reported (vs. a default). */
  exact: boolean;
}

/** Network timeout for balance probes (a slow endpoint must not hang the UI). */
export const BALANCE_FETCH_TIMEOUT_MS = 8_000;

/** Look up a registry provider that exposes a balance endpoint, by name. */
export function balanceCapableProvider(name: string): OpenAiCompatProvider | undefined {
  const provider = providerByName(name);
  if (provider === undefined || provider.balancePath === undefined || provider.balanceKind === undefined) {
    return undefined;
  }
  return provider;
}

function parseDeepSeekBalance(body: unknown): ProviderBalance | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const infos = (body as { balance_infos?: unknown }).balance_infos;
  if (!Array.isArray(infos)) {
    return undefined;
  }
  for (const info of infos) {
    if (typeof info !== "object" || info === null) {
      continue;
    }
    const total = Number((info as { total_balance?: unknown }).total_balance);
    if (Number.isFinite(total)) {
      const currency = String((info as { currency?: unknown }).currency ?? "USD");
      return { currency, total, exact: true };
    }
  }
  return undefined;
}

function parseOpenRouterBalance(body: unknown): ProviderBalance | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const credits = (body as { credits?: unknown }).credits;
  if (typeof credits !== "object" || credits === null) {
    return undefined;
  }
  const total = Number((credits as { total?: unknown }).total);
  const used = Number((credits as { used?: unknown }).used);
  if (!Number.isFinite(total)) {
    return undefined;
  }
  const usedField = Number.isFinite(used) ? { used } : {};
  const remaining = Number.isFinite(used) ? total - used : undefined;
  return {
    currency: String((credits as { currency?: unknown }).currency ?? "USD"),
    total,
    ...usedField,
    ...(remaining !== undefined ? { remaining } : {}),
    exact: true,
  };
}

/**
 * Fetch the current balance for a provider that exposes a balance endpoint.
 * Returns `undefined` for providers without one, on network error, or on a
 * non-2xx / malformed response. Never throws.
 */
export async function fetchProviderBalance(
  fetchFn: typeof fetch,
  provider: OpenAiCompatProvider,
  apiKey?: string,
  opts?: { timeoutMs?: number },
): Promise<ProviderBalance | undefined> {
  if (provider.balancePath === undefined || provider.balanceKind === undefined) {
    return undefined;
  }
  const url = `${provider.baseUrl.replace(/\/+$/, "")}${provider.balancePath}`;
  const timeoutMs = opts?.timeoutMs ?? BALANCE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (apiKey !== undefined && apiKey.length > 0) {
      init.headers = { authorization: `Bearer ${apiKey}` };
    }
    const res = await fetchFn(url, init);
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as unknown;
    return provider.balanceKind === "deepseek"
      ? parseDeepSeekBalance(body)
      : parseOpenRouterBalance(body);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the API key for a provider from an env-like record. */
export function providerApiKey(
  provider: OpenAiCompatProvider,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const envKey = provider.envKey;
  if (envKey === undefined) {
    return undefined;
  }
  const raw = env[envKey];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// ---------------------------------------------------------------------------
// `keryx providers` — what is configured, and whether review can cross families
// ---------------------------------------------------------------------------

/**
 * The providers the operator has actually CONFIGURED (flow 207, AC9).
 *
 * "Configured" is not "listed". `OPENAI_COMPAT_PROVIDERS` is a picker menu — a
 * built-in with no credential is an offer, not a capability, and counting it
 * would let `keryx providers cross-family` report a second family that cannot be
 * reached. So a built-in qualifies only when a key resolves (env, or one
 * `keryx shell` persisted) or when it needs none; a custom entry in
 * `llm-providers.json` always qualifies, because writing it there IS the
 * operator's act.
 *
 * There is no second registry here: `allOpenAiCompatProviders` already merges
 * the built-ins with this project's `llm-providers.json` loader, and this
 * function only filters it.
 */
export function configuredProviders(
  env: Record<string, string | undefined> = process.env,
  dir?: string,
): ConfiguredProvider[] {
  const customNames = new Set(customCompatProviders(dir).map((provider) => provider.name));
  return allOpenAiCompatProviders(dir)
    .filter((provider) => {
      if (customNames.has(provider.name)) return true;
      if (provider.requiresApiKey === false) return true;
      return providerApiKey(provider, env) !== undefined || provider.apiKey !== undefined;
    })
    .filter((provider) => isProviderPlatformSupported(provider))
    .map((provider) => ({ name: provider.name, models: provider.models }));
}

/**
 * `keryx providers` — read-only reporting over the provider configuration.
 *
 * Read-only and network-free on purpose. `keryx review tier` already probes live
 * `/models` when it needs a capability ordering; this command answers a question
 * about CONFIGURATION, so it reads files and exits. That is also what lets it
 * carry a `read: true` command descriptor with no side effects.
 */
export function providersCommand(args: string[]): void {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printProvidersHelp();
    return;
  }
  if (command === "list") {
    runProvidersList(args.slice(1));
    return;
  }
  if (command === "cross-family") {
    runCrossFamily(args.slice(1));
    return;
  }
  console.error(`Unknown providers command: ${command}`);
  printProvidersHelp();
  process.exitCode = 1;
}

function runProvidersList(args: string[]): void {
  const env = envWithSavedApiKeys();
  const configured = configuredProviders(env).map((provider) => ({
    provider: provider.name,
    family: familyOf(provider.name),
  }));

  if (args.includes("--json")) {
    console.log(JSON.stringify({ configured }, null, 2));
    return;
  }

  console.log("# configured providers");
  console.log("");
  if (configured.length === 0) {
    console.log("none — no built-in provider has a credential and llm-providers.json defines nothing.");
    return;
  }
  for (const entry of configured) {
    console.log(
      `- ${entry.provider}: family ${entry.family ?? "not classified (a gateway or local runner fronts many families; its individual models are classified instead)"}`,
    );
  }
}

/**
 * `keryx providers cross-family` — the §5.4 decision, run rather than reasoned
 * about.
 *
 * ALWAYS EXITS 0 (AC11). Absence of a second provider is a normal state, and the
 * only thing that changes is the `mode` and the recorded reason. A non-zero exit
 * here would make "you have one vendor" indistinguishable from "the command
 * broke", and would turn a normal configuration into a failing gate for every
 * operator who has not signed up with two vendors.
 *
 * `--opt-in` is off by default (AC10). Running the command without it reports
 * what WOULD happen; it never enrols anybody.
 */
function runCrossFamily(args: string[]): void {
  const decision = crossFamilyReviewForSession(args.includes("--opt-in"), {
    providerId: optionValue(args, "--session-provider"),
    modelId: optionValue(args, "--session-model"),
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify({ cross_family_review: decision }, null, 2));
    return;
  }
  console.log(renderCrossFamilyDecision(decision));
}

/**
 * THE SEAM. One call, for anything that needs the §5.4 decision.
 *
 * This is what the review pipeline (`src/commands/review.ts`, `src/review/**`)
 * calls to obtain the `cross_family_review` block for a round. It is defined
 * here rather than there so that the provider configuration keeps exactly one
 * reader (AC9): a caller supplies only the two things it already holds — whether
 * the operator opted in, and the session it is running on — and never enumerates
 * providers itself.
 *
 * `session` fields are optional and fall back to the selection `keryx shell`
 * persisted, matching what `sessionModelFromArgs` in `review.ts` already does
 * for `keryx review tier`. So the two model-selection seams compose: `review
 * tier` answers "how capable a model", this answers "whose model", and both read
 * the same session.
 *
 * Never throws, never makes a network call, and returns a decision with a stated
 * reason on every path.
 */
export function crossFamilyReviewForSession(
  optIn: boolean,
  session: { providerId?: string | undefined; modelId?: string | undefined } = {},
): CrossFamilyReviewDecision {
  const config = loadShellConfig();
  return decideCrossFamilyReview({
    optIn,
    session: {
      providerId: (session.providerId ?? config.provider ?? "").trim(),
      modelId: (session.modelId ?? config.model ?? "").trim(),
    },
    configured: configuredProviders(envWithSavedApiKeys()),
  });
}

/** The human form of the decision. The reason is never omitted. */
export function renderCrossFamilyDecision(decision: CrossFamilyReviewDecision): string {
  const lines: string[] = [];
  lines.push("# cross-family review");
  lines.push("");
  lines.push(`mode: ${decision.mode}`);
  lines.push(`requested: ${decision.requested ? "yes (--opt-in)" : "no"}`);
  lines.push(`author_family: ${decision.author_family ?? "not classified"}`);
  lines.push(`reviewer_family: ${decision.reviewer_family ?? "none (single-family review)"}`);
  lines.push(`reviewer_provider: ${decision.reviewer_provider ?? "none"}`);
  lines.push(`reviewer_model: ${decision.reviewer_model ?? "none"}`);
  lines.push(`candidates: ${decision.candidates.length}`);
  for (const candidate of decision.candidates) {
    lines.push(`  - ${candidate.family} via ${candidate.provider}${candidate.model === null ? "" : ` (${candidate.model})`}`);
  }
  lines.push("");
  lines.push(`reason: ${decision.reason}`);
  lines.push("");
  lines.push("## record");
  lines.push("");
  // Flow 209 AC2. This used to say "embed this block in the round's structured
  // output", which named no command and no file — and so nothing ever did. The
  // consumer now exists and is named here, because an instruction that does not
  // say WHERE is how a field ships with no reader.
  lines.push("Record it on the round, and read it back:");
  lines.push("");
  lines.push("    keryx providers cross-family --opt-in --json > cross-family.json");
  lines.push("    keryx review ingest ... --cross-family-review cross-family.json");
  lines.push("    keryx review status <review-id>   # reads it off disk and refuses a self-contradictory record");
  lines.push("");
  lines.push("A round that records nothing reports `not recorded`, which is NOT `single-family`: nobody decided.");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({ cross_family_review: decision }, null, 2));
  lines.push("```");
  return lines.join("\n");
}

function printProvidersHelp(): void {
  console.log(`keryx providers

Usage:
  keryx providers list [--json]
  keryx providers cross-family [--opt-in] [--session-provider <id>] [--session-model <id>] [--json]

Commands:
  list          Providers this operator has configured, and the family of each
  cross-family  Whether review can run on a different model family than authored
                the change, and the record the round should carry

cross-family is OPT-IN: without --opt-in it reports what would happen and
chooses single-family review. Dispatching to another provider spends tokens and
sends the change to a second vendor, which is a decision rather than an
optimisation. With no second family configured it reports single-family review
with a stated reason and exits 0 — that is a normal configuration, not an error.
`);
}
