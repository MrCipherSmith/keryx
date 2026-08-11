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
  /** Short picker note (e.g. `coding plan`). */
  note?: string;
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
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "cheap per-token",
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
    models: ["qwen3.5-9b-4bit"],
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
  return OPENAI_COMPAT_PROVIDERS.find((p) => p.name === name);
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
  const fallback: ModelsResolveResult = { models: [...provider.models], source: "fallback" };
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
  provider: { name: string; models: string[]; envKey?: string },
  env: Record<string, string | undefined> = process.env,
  opts?: { timeoutMs?: number },
): Promise<ModelsResolveResult> {
  const compat = providerByName(provider.name);
  if (compat === undefined) {
    return { models: [...provider.models], source: "fallback" };
  }
  const envKey = provider.envKey ?? compat.envKey;
  const raw = envKey === undefined ? undefined : env[envKey];
  const apiKey = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  return fetchOpenAiCompatModelsDetailed(fetchFn, compat, apiKey, opts);
}
