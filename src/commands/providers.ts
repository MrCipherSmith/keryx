// OpenAI-Chat-Completions-compatible provider registry (flow 085).
//
// Every entry here is reachable with just a base URL + a Bearer API key, so a
// single OpenAI-compatible adapter (`OllamaProvider` with an `apiKey`/`baseUrl`
// grant) serves all of them — see `makeProvider`. The registry is the ONE source
// of truth consumed by `detectProviders` (which providers to offer), the in-TUI
// picker (label / API-key prompt / live model fetch), `makeProvider`
// (base URL + env var + chat path), and `keryx harness run` (which names it is
// allowed to accept, and which credential each one fails closed without —
// `knownProviderNames` / `credentialEnvKeyFor`). Pure data + a pure fetch helper;
// no key is ever stored on these shapes or logged.
//
// Base URL = the part BEFORE the chat path. Most gateways answer at
// `{baseUrl}/v1/chat/completions` + `{baseUrl}/v1/models`; Z.AI's GLM endpoints
// are versioned `…/paas/v4` and answer at `/chat/completions` + `/models`
// (no `/v1`), hence the per-provider `chatPath`/`modelsPath` overrides.

/**
 * Provenance of a curated model list: where the ids came from, when this
 * repository last changed them, and whether that change actually checked them
 * against the provider.
 *
 * Three fields rather than one sentence, because the first version of this was a
 * free-text line and every entry got stamped with the date of the commit that
 * introduced the FIELD — not the date its list was established. Seven lists last
 * touched 2026-07-20 read as verified 2026-08-05, which is precisely the
 * laundering the field exists to prevent. A boolean cannot be written
 * inattentively in the way a date string can.
 *
 * `checkedAgainstProvider: false` is the normal, honest state: the ids were
 * taken from the vendor's documentation when the entry was written and have not
 * been re-checked since. An offline test can assert the shape and the internal
 * consistency of this claim; it cannot assert the gateway still publishes these
 * ids today, because that needs a credential and a network call.
 */
export interface ModelsProvenance {
  /** Where the ids were taken from (vendor docs, a recorded `GET /models`, …). */
  source: string;
  /** `YYYY-MM-DD`: when this repository last changed the list. */
  listedOn: string;
  /**
   * True ONLY when the change that set `listedOn` compared the list against the
   * provider itself. When true, `source` must name the evidence.
   */
  checkedAgainstProvider: boolean;
}

/** A hosted OpenAI-compatible provider offered in the picker. */
export interface OpenAiCompatProvider {
  /** Stable id used as the provider name (e.g. `deepseek`). */
  name: string;
  /** Human label shown in the picker (e.g. `DeepSeek`). */
  label: string;
  /** API base URL (before the chat/models path). */
  baseUrl: string;
  /** Env var carrying the Bearer key (e.g. `DEEPSEEK_API_KEY`). */
  envKey: string;
  /** Chat path appended to `baseUrl`; defaults to `/v1/chat/completions`. */
  chatPath?: string;
  /** Model-list path appended to `baseUrl`; defaults to `/v1/models`. */
  modelsPath?: string;
  /**
   * Model ids offered when the live `/models` fetch fails, PREFERRED FIRST —
   * `models[0]` is the id `defaultModelFor` (harness/provider/single-turn.ts)
   * hands a caller who named no model. Every id here must be one the provider
   * itself declares. Naming an alias the provider still answers on but does not
   * list is defect D5 of the 2026-08-05 shell benchmark: it works until the day
   * it stops, and nothing in the product says it was never listed.
   */
  models: string[];
  /** Where {@link OpenAiCompatProvider.models} came from and how old it is. */
  modelsProvenance: ModelsProvenance;
  /** Short picker note (e.g. `coding plan`). */
  note?: string;
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
    modelsProvenance: {
      source: "openrouter.ai model listing, as read when the entry was written",
      listedOn: "2026-07-20",
      checkedAgainstProvider: false,
    },
    note: "hosted · 400+ models",
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    envKey: "DEEPSEEK_API_KEY",
    // D5 (2026-08-05 shell benchmark): this list used to read
    // ["deepseek-chat", "deepseek-reasoner"]. The DeepSeek API lists neither —
    // it declares deepseek-v4-flash and deepseek-v4-pro. `deepseek-chat` still
    // answers, which is precisely why nobody noticed that keryx's default model
    // for this provider was an undeclared alias.
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    modelsProvenance: {
      source:
        "api.deepseek.com GET /v1/models, as recorded in docs/requirements/keryx-shell-benchmark/run-2026-08-05.md §7 (D5)",
      listedOn: "2026-08-05",
      checkedAgainstProvider: true,
    },
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
    modelsProvenance: {
      source: "docs.z.ai GLM model list, as read when the entry was written",
      listedOn: "2026-07-20",
      checkedAgainstProvider: false,
    },
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
    modelsProvenance: {
      source: "docs.z.ai Coding Plan model support table, as read when the entry was written",
      listedOn: "2026-07-20",
      checkedAgainstProvider: false,
    },
    note: "coding plan (flat rate)",
  },
  {
    name: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai",
    envKey: "CEREBRAS_API_KEY",
    models: ["llama-3.3-70b", "llama-3.1-8b", "gpt-oss-120b", "qwen-3-32b"],
    modelsProvenance: {
      source: "inference-docs.cerebras.ai model list, as read when the entry was written",
      listedOn: "2026-07-20",
      checkedAgainstProvider: false,
    },
    note: "Cerebras Code plan · fast",
  },
  {
    name: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai",
    envKey: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gpt-oss-120b"],
    modelsProvenance: {
      source: "console.groq.com/docs/models, as read when the entry was written",
      listedOn: "2026-07-20",
      checkedAgainstProvider: false,
    },
    note: "free tier · fast",
  },
  {
    name: "moonshot",
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai",
    envKey: "MOONSHOT_API_KEY",
    models: ["kimi-k2-turbo-preview", "moonshot-v1-128k", "moonshot-v1-32k"],
    modelsProvenance: {
      source: "platform.moonshot.ai model list, as read when the entry was written",
      listedOn: "2026-07-20",
      checkedAgainstProvider: false,
    },
    note: "Kimi",
  },
  {
    name: "grok",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai",
    envKey: "XAI_API_KEY",
    models: ["grok-2-latest", "grok-2", "grok-beta"],
    modelsProvenance: {
      source: "docs.x.ai model list, as read when the entry was written",
      listedOn: "2026-07-20",
      checkedAgainstProvider: false,
    },
    note: "xAI · OpenAI-compatible",
  },
];

/** Look up a registry provider by its `name`. */
export function providerByName(name: string): OpenAiCompatProvider | undefined {
  return OPENAI_COMPAT_PROVIDERS.find((p) => p.name === name);
}

/**
 * Provider names that are not OpenAI-compat gateways but are still selectable:
 * the offline fixture provider, the local loopback runtime, and the first-party
 * Anthropic adapter. Kept beside the registry so "every provider keryx accepts"
 * has ONE answer ({@link knownProviderNames}) instead of a literal set copied
 * into each command — the copy in `harness run` is what let the CLI refuse
 * DeepSeek while `docs/docs/cli-reference.md` promised it (benchmark D4).
 */
export const NON_REGISTRY_PROVIDERS = ["fake", "anthropic", "ollama"] as const;

/** Every provider name keryx accepts, built-ins first, then the registry. */
export function knownProviderNames(): string[] {
  return [...NON_REGISTRY_PROVIDERS, ...OPENAI_COMPAT_PROVIDERS.map((p) => p.name)];
}

/** Whether `name` is a provider keryx knows how to construct. */
export function isKnownProvider(name: string): boolean {
  return knownProviderNames().includes(name);
}

/**
 * The environment variable a provider's credential is read from, or `undefined`
 * when it needs none: `fake` never opens a socket, and `ollama` is a local
 * runtime that takes no key. Note what the second one does NOT say — nothing
 * here confines ollama to loopback. Its default base URL is loopback and the
 * provider's egress guard rejects private/link-local/metadata hosts, but an
 * arbitrary PUBLIC base URL is fetched. A caller that lets an untrusted party
 * choose the base URL must constrain it itself; `keryx harness run` does
 * (`refuseBaseUrl`).
 *
 * This is the fail-closed check's input: a caller that gets a name back MUST
 * refuse to proceed when that variable is absent. Widening
 * {@link knownProviderNames} without widening this would trade a usage error for
 * a credential-less network attempt, which is the wrong direction.
 */
export function credentialEnvKeyFor(name: string): string | undefined {
  if (name === "anthropic") {
    return "ANTHROPIC_API_KEY";
  }
  return providerByName(name)?.envKey;
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
  const raw = env[envKey];
  const apiKey = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  return fetchOpenAiCompatModelsDetailed(fetchFn, compat, apiKey, opts);
}
