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
  type CustomCompatProvider,
  decideCrossFamilyReview,
  familyOf,
  loadCustomCompatProviders,
  removeCustomCompatProvider,
} from "../lib/provider-config";
import { extraRequestHeaders } from "../lib/oauth/catalog";
import { envWithOAuthAccess, oauthEnvKeyFor } from "../lib/oauth/grants";
import { logoutProvider } from "../lib/oauth/login";
import { resolveCallerSession } from "../lib/caller-session";
import {
  type ShellConfig,
  envWithSavedApiKeys,
  loadShellConfig,
  removeApiKey,
  removeProviderBaseUrl,
  removeProviderModelParams,
  savedCredentialEnvKeys,
} from "../lib/shell-config";
import { optionValue } from "../lib/args";
import { confirm as ttyConfirm } from "../lib/prompt";

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
  /**
   * This gateway is known to return usage when asked via `stream_options`.
   *
   * Opt-in per provider, and verified per provider, because the flag only helps
   * where the server honours it and a non-conformant gateway may reject an unknown
   * top-level field outright — breaking a path that works today. Without it the
   * stream carries NO usage at all and the session cannot report what it spent, so
   * every entry here is worth confirming; absent means "not yet checked", never
   * "unsupported".
   *
   * Confirmed: grok (x.ai) — the same request returns zero usage chunks without the
   * field and `prompt_tokens: 638, cached_tokens: 512` with it.
   * Unchecked: deepseek, openrouter, cerebras, groq, moonshot, zai, github-copilot.
   */
  streamUsage?: boolean;
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
  /**
   * Custom-provider-only override of the main agent turn's output-token
   * budget (flow 268); mirrors `CustomCompatProvider.maxOutputTokens`
   * (`src/lib/provider-config.ts`), which is its sole source — a built-in
   * entry never sets this. Read by `resolveAgentMaxOutputTokens`'s callers
   * (e.g. `commands/shell.ts`'s `makeAgentDeps`) via
   * `resolveProviderModelParams`/`resolveProviderModelParamsByName` below —
   * which also let an operator override it per-provider via
   * `ShellConfig.modelParams` without editing `llm-providers.json`.
   */
  maxOutputTokens?: number;
  /**
   * Default sampling temperature for this provider (flow 268). For a custom
   * provider this is copied straight from its `CustomCompatProvider` record
   * (`customCompatProviders` below); a built-in has no default of its own —
   * see `resolveProviderModelParams`'s `ShellConfig.modelParams` override.
   * Folded into `request.options.temperature` by `commands/agent.ts`'s
   * `buildRequestOptions` (and by `runShell`'s own chat-mode request).
   */
  temperature?: number;
  /**
   * Default abort timeout (ms) for the actual chat/completions call to this
   * provider (flow 268), independent of the `/models` discovery probe's own
   * timeout. Threaded into `StreamOptions.timeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Custom-provider-only reasoning configuration; mirrors
   * `CustomCompatProvider.reasoning` (`src/lib/provider-config.ts`), which is
   * its sole source — a built-in entry never sets this. Threaded onto
   * `OpenAiCompatCapabilityGrant.reasoning` by `makeProvider`
   * (`src/harness/provider/make-provider.ts`).
   */
  reasoning?: {
    format?: "field" | "inline-tags" | "split";
    requestParams?: Record<string, unknown>;
    replay?: "none" | "deepseek" | "minimax";
  };
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

/** Hosts MiniMax's OpenAI-compatible gateway is reachable at (flow 268 T24). */
const MINIMAX_REASONING_PRESET_HOSTS = new Set(["api.minimax.io", "api.minimaxi.com"]);

/** Host DeepSeek's OpenAI-compatible gateway is reachable at (flow 268 T26). */
const DEEPSEEK_REASONING_PRESET_HOSTS = new Set(["api.deepseek.com"]);

/**
 * Resolve the `reasoning` config a compat provider actually sends (flow 268
 * T24/T26): an EXPLICIT `reasoning` config on the provider always wins,
 * verbatim — this never overrides an operator's own choice, including one
 * that reintroduces a known issue. Absent, a provider whose `baseUrl` host
 * is an EXACT match (any path) for a known preset host gets a default
 * preset instead of "no reasoning config" (the pre-existing behaviour for
 * every other absent-config host).
 *
 * Why a preset, and why these:
 * - MiniMax's un-configured default mode duplicates every reasoning
 *   phrase — once inline in `delta.content` as `<think>…</think>`, once
 *   again plain in `delta.reasoning` — and the `reasoning` field is not
 *   trustworthy at the stream boundary (live smoke evidence against
 *   MiniMax-M3, 2026-09-17: the last `reasoning` chunk bled answer text
 *   across the boundary). `{ format: "split", requestParams: {
 *   reasoning_split: true }, replay: "minimax" }` asks MiniMax for
 *   out-of-band reasoning instead, which the same smoke run confirmed
 *   keryx renders and replays cleanly (`openai-compat-provider.ts`'s
 *   field-sourced tag strip, flow 268 T24, handles the one remaining rough
 *   edge: split mode's reasoning stream ending in a literal `</think>`
 *   line).
 * - DeepSeek's thinking mode returns HTTP 400 on a tool-bearing request
 *   whose prior assistant turns omit the `reasoning_content` field it sent
 *   (https://api-docs.deepseek.com/guides/thinking_mode/). Without a
 *   `reasoning` config at all, `grant.reasoning.replay` stays undefined and
 *   `openai-compat-provider.ts` never accumulates or re-attaches
 *   `reasoning_content` (gated on `replayMode === "deepseek"`), so the
 *   built-in `deepseek` provider 400s the moment a multi-turn tool call
 *   follows a thinking-mode reply. `{ format: "field", replay: "deepseek" }`
 *   asks for nothing extra on the wire (DeepSeek's reasoning already streams
 *   as a plain `reasoning_content` delta field) but turns on the replay
 *   accumulation/re-attachment `openai-compat-provider.ts` already
 *   implements for `replay: "deepseek"`.
 *
 * Pure: no network, no clock — string comparison against `baseUrl`'s parsed
 * hostname. An unparsable `baseUrl` resolves to "no preset" rather than
 * throwing (mirrors `resolveProviderBaseUrl`'s fail-open-to-unchanged shape).
 */
export function resolveCompatReasoningPreset(
  explicit: OpenAiCompatProvider["reasoning"],
  baseUrl: string,
): OpenAiCompatProvider["reasoning"] | undefined {
  if (explicit !== undefined) return explicit;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (MINIMAX_REASONING_PRESET_HOSTS.has(host)) {
    return { format: "split", requestParams: { reasoning_split: true }, replay: "minimax" };
  }
  if (DEEPSEEK_REASONING_PRESET_HOSTS.has(host)) {
    return { format: "field", replay: "deepseek" };
  }
  return undefined;
}

/** Resolved per-provider sampling/budget/timeout overrides (flow 268). Every field absent when unconfigured. */
export interface ResolvedProviderModelParams {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/**
 * Resolve `temperature`/`maxOutputTokens`/`timeoutMs` for one provider.
 *
 * Precedence: `shellConfig.modelParams[provider.name]` (an operator override
 * saved for a BUILT-IN provider, `saveProviderModelParams`) wins when present,
 * else the provider record's OWN fields — which is how a custom provider's
 * `llm-providers.json` entry (already carrying these per `CustomCompatProvider`)
 * supplies its defaults, since a built-in `OpenAiCompatProvider` has none of
 * its own. Absent everywhere -> every field `undefined`, matching AC3's
 * byte-identical-when-unconfigured requirement; this function never invents a
 * default — the fallback lives at the request-construction call sites, same
 * as today (the agent turn's `?? DEFAULT_MAX_OUTPUT_TOKENS` in
 * `resolveAgentMaxOutputTokens`, `commands/agent.ts`; `runShell`'s own
 * chat-mode loop's `?? DEFAULT_MAX_OUTPUT_TOKENS`).
 */
export function resolveProviderModelParams(
  provider: OpenAiCompatProvider | CustomCompatProvider,
  shellConfig: Pick<ShellConfig, "modelParams"> = loadShellConfig(),
): ResolvedProviderModelParams {
  const override = shellConfig.modelParams?.[provider.name];
  const temperature = override?.temperature ?? provider.temperature;
  const maxOutputTokens = override?.maxOutputTokens ?? provider.maxOutputTokens;
  const timeoutMs = override?.timeoutMs ?? provider.timeoutMs;
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/**
 * Convenience wrapper over {@link resolveProviderModelParams} for a caller that
 * only has a provider NAME (e.g. a shell's current `providerName` string, not
 * an `OpenAiCompatProvider` object) — model-selection call sites in
 * `commands/shell.ts`/`tui/tui-shell.ts` use this. Returns every field
 * `undefined` for a name with no OpenAI-compatible registry entry (the native
 * anthropic/openai/gemini adapters, `ollama`-as-native, `fake`) — scope
 * discipline: this flow only covers OpenAI-compatible gateways (see
 * `docs requirements` for flow 268), so a native adapter's config surface is
 * simply untouched rather than guessed at.
 *
 * `dir`, when given, MUST be the same directory `shellConfig` was loaded
 * from (`loadShellConfig(dir)`) — it scopes the CUSTOM-provider lookup
 * (`providerByName`/`llm-providers.json`), the half of this resolution
 * `shellConfig` alone cannot reach, since a custom provider's own
 * `temperature`/`maxOutputTokens`/`timeoutMs` live on its `llm-providers.json`
 * record, not in `ShellConfig.modelParams`.
 */
export function resolveProviderModelParamsByName(
  name: string,
  shellConfig: Pick<ShellConfig, "modelParams"> = loadShellConfig(),
  dir?: string,
): ResolvedProviderModelParams {
  const provider = providerByName(name, dir);
  return provider === undefined ? {} : resolveProviderModelParams(provider, shellConfig);
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
    // Verified live against api.deepseek.com (2026-09-23): a stream carries
    // usage chunks even WITHOUT this field (one-word reply: input=11,
    // output=1), and the field itself is accepted rather than rejected
    // (HTTP 200, same usage). So unlike x.ai — which returns zero usage
    // chunks without it — DeepSeek does not have to be ASKED for usage.
    // It is set anyway because this flag is also the registry's only
    // evidence of "this gateway can be priced", which is what
    // `providerReportsUsage` (`src/commands/trigger-dispatch.ts`) reads to
    // decide whether an unattended run may start: without it every schedule
    // and `flow-next` dispatch refuses with `provider-usage-unknown` before
    // any model call, whatever the gateway actually does on the wire.
    streamUsage: true,
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
    streamUsage: true,
    models: ["grok-2-latest", "grok-2", "grok-beta"],
    note: "xAI · OpenAI-compatible",
  },
  {
    name: "github-copilot",
    label: "GitHub Copilot",
    baseUrl: "https://api.githubcopilot.com",
    envKey: "GITHUB_COPILOT_TOKEN",
    // Copilot is OpenAI-shaped but not versioned under /v1 — GET /v1/models is a
    // 404 HTML page ("404 page not found"), which the picker then treats as a
    // bad host. Chat is the same: /chat/completions, not /v1/chat/completions.
    chatPath: "/chat/completions",
    modelsPath: "/models",
    models: ["gpt-4o", "gpt-4.1", "gpt-4o-mini"],
    note: "Copilot · device login",
  },
];

/** Look up a registry provider by its `name`. `dir` scopes the custom-provider lookup, same as {@link allOpenAiCompatProviders}. */
export function providerByName(name: string, dir?: string): OpenAiCompatProvider | undefined {
  return allOpenAiCompatProviders(dir).find((p) => p.name === name);
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
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.maxOutputTokens !== undefined ? { maxOutputTokens: p.maxOutputTokens } : {}),
      ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
      ...(p.reasoning !== undefined ? { reasoning: p.reasoning } : {}),
    }));
}

/** Built-in + operator-defined custom providers, in picker order. */
export function allOpenAiCompatProviders(dir?: string): OpenAiCompatProvider[] {
  return [...OPENAI_COMPAT_PROVIDERS, ...customCompatProviders(dir)];
}

/** Default network timeout for live `/models` probes (offline must not hang the picker). */
export const MODELS_FETCH_TIMEOUT_MS = 10_000;

export type ModelsResolveSource = "live" | "fallback";

/**
 * Why a live `/models` probe produced nothing.
 *
 * The curated ids used to stand in for a failed probe, and stopping that was
 * right — a documentary id is not a model you can call. But the replacement
 * discarded the ANSWER as well as the ids: the picker showed
 * "(no models found)" whether the provider had no models, rejected the
 * credential, or was never reached. A rejected credential in particular is
 * not a fact about the provider's catalogue, and the operator can act on it
 * the moment they are told.
 */
export type ModelsFailure =
  /** 401/403 — the credential was sent and refused. */
  | { kind: "rejected"; status: number; detail?: string }
  /** Any other non-2xx. */
  | { kind: "http"; status: number; detail?: string }
  /** Never got an answer: offline, DNS, TLS, timeout. */
  | { kind: "unreachable"; detail?: string }
  /** 2xx, well-formed, and genuinely empty. */
  | { kind: "empty" };

export interface ModelsResolveResult {
  models: string[];
  /** `live` when the provider's HTTP `/models` returned at least one id. */
  source: ModelsResolveSource;
  /** Present exactly when `models` is empty and a live probe was attempted. */
  failure?: ModelsFailure;
}

/** Longest error body read from a failed `/models` probe before giving up on it. */
const MODELS_ERROR_BODY_LIMIT = 4_096;

/**
 * Pull a human sentence out of a provider's error body.
 *
 * Every gateway spells it differently — `{error:{message}}` (OpenAI shape),
 * `{error:"…"}` (xAI), `{detail:"…"}` (Cerebras), `{message:"…"}` — and a
 * few answer in HTML. Returns `undefined` rather than echoing markup at the
 * operator.
 */
export function modelsErrorDetail(body: string): string | undefined {
  const text = body.slice(0, MODELS_ERROR_BODY_LIMIT).trim();
  if (text.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON. A plain one-liner is still worth showing; markup is not.
    parsed = undefined;
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
    for (const field of ["detail", "message"] as const) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    // Parsed, but nothing here is a sentence. Echoing the raw JSON at the
    // operator is noise, not an explanation — the status code says more.
    return undefined;
  }
  if (text.startsWith("<") || text.includes("<html")) {
    return undefined;
  }
  const firstLine = text.split("\n", 1)[0]?.trim();
  return firstLine !== undefined && firstLine.length > 0 ? firstLine : undefined;
}

/**
 * One line explaining an empty model list, for a picker or a toast.
 *
 * Pure and exported so the wording is asserted without a terminal.
 */
export function modelsFailureLine(providerLabel: string, failure: ModelsFailure): string {
  const detail = "detail" in failure && failure.detail !== undefined ? ` — ${failure.detail}` : "";
  switch (failure.kind) {
    case "rejected":
      return `${providerLabel} rejected the credential (HTTP ${failure.status})${detail}`;
    case "http":
      return `${providerLabel} could not list models (HTTP ${failure.status})${detail}`;
    case "unreachable":
      return `${providerLabel} could not be reached${detail}`;
    case "empty":
      return `${providerLabel} reports no models`;
  }
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
  // models: only the provider's live `/models` response is authoritative. The
  // REASON, though, is carried out — an empty list with no explanation sent
  // the operator looking for a broken picker instead of an expired token.
  const fallback = (failure: ModelsFailure): ModelsResolveResult => ({ models: [], source: "fallback", failure });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = { signal: controller.signal };
    const extraHeaders = extraRequestHeaders(provider.name);
    const headers: Record<string, string> = extraHeaders === undefined ? {} : { ...extraHeaders };
    if (apiKey !== undefined && apiKey.length > 0) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers;
    }
    const res = await fetchFn(url, init);
    if (!res.ok) {
      const detail = modelsErrorDetail(await res.text().catch(() => ""));
      const kind = res.status === 401 || res.status === 403 ? "rejected" : "http";
      return fallback({ kind, status: res.status, ...(detail === undefined ? {} : { detail }) });
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
      return fallback({ kind: "empty" });
    }
    return { models: Array.from(new Set(ids)).sort(), source: "live" };
  } catch (err) {
    // An abort is the timeout above, not a network fault — say which.
    const aborted = controller.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    return fallback({ kind: "unreachable", detail: aborted ? `timed out after ${timeoutMs}ms` : message });
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
// Test connection / Disconnect (flow 304) — the `/connect` row buttons and
// their CLI parity (`keryx providers test`/`keryx providers remove`).
// ---------------------------------------------------------------------------

/**
 * Run the provider's live model-list probe for a "Test connection" action —
 * the exact probe `filterConnectedDetectedProviders` already runs to decide
 * whether a provider belongs in `/connect`'s list in the first place. Resolves
 * the key the same way that filter does: an env var when the registry names
 * one, else the provider's own in-file `apiKey` (custom/local providers).
 * Never throws.
 */
export async function testProviderConnection(
  provider: OpenAiCompatProvider,
  fetchFn: typeof fetch = globalThis.fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<ModelsResolveResult> {
  const apiKey = providerApiKey(provider, env) ?? provider.apiKey;
  return fetchOpenAiCompatModelsDetailed(fetchFn, provider, apiKey, { timeoutMs: MODELS_FETCH_TIMEOUT_MS });
}

/**
 * Every OTHER provider (built-in or custom) whose OWN credential lives in the
 * SAME env var as `envKey` — e.g. built-in `zai`/`zai-coding` both read
 * `ZAI_API_KEY` (flow 304 review finding #2: disconnecting one silently
 * disconnected the other, with no warning). Generic over whatever provider
 * list is handed in — never special-cased by name — so it covers a custom
 * provider that happens to share a built-in's env var the same way it covers
 * two built-ins. Pure; `providers` is normally `allOpenAiCompatProviders(dir)`.
 */
export function providersSharingEnvKey(
  envKey: string,
  excludeName: string,
  providers: readonly OpenAiCompatProvider[],
): string[] {
  return providers
    .filter((p) => p.envKey === envKey && p.name !== excludeName)
    .map((p) => p.name)
    .sort();
}

/** The confirmation/result phrase naming `sharedWith`, or `undefined` when nothing is shared. */
export function sharedCredentialWarning(sharedWith: readonly string[], envKey: string | undefined): string | undefined {
  if (sharedWith.length === 0 || envKey === undefined) return undefined;
  return `this also disconnects ${sharedWith.join(", ")} (same ${envKey})`;
}

/**
 * Why a provider's credential cannot be resolved to a single owned artifact —
 * or can, naming which one Disconnect must remove.
 *
 * - `custom`: an `llm-providers.json` entry (`removeCustomCompatProvider`),
 *   together with any saved `baseUrls`/`modelParams` override for it.
 * - `oauth-grant`: a device-code/PKCE grant in `auth.json` (`logoutProvider` —
 *   LOCAL delete only; it does not call a vendor revoke endpoint, see
 *   `logoutProvider`'s own doc and `docs/docs/cli-reference.md`). `envKey`
 *   (when the grant maps onto one, via `oauthEnvKeyFor`) is the var
 *   `envWithOAuthAccess` copied the access token onto (e.g. `grok` →
 *   `XAI_API_KEY`) — flow 304 review finding #1: this used to go unnoticed by
 *   `process.env`, so the NEXT `/connect` misclassified the just-disconnected
 *   provider as `env-var-only` and told the operator to unset a variable
 *   keryx itself had set.
 * - `saved-api-key`: a key keryx itself saved under `apiKeys[envKey]` in
 *   `auth.json` (`removeApiKey`).
 * - `env-var-only`: the provider's env var IS set, but not by keryx (absent
 *   from `savedCredentialEnvKeys()`/`apiKeys`) — the operator exported it in
 *   their own shell. Not removable: unsetting a live process's env would
 *   silently reappear on the next launch, which is worse than refusing.
 * - `no-credential`: nothing keryx holds for this provider (a keyless local
 *   provider, e.g. `rapid-mlx`, or a name with no saved credential at all).
 */
export type ProviderConnectionKind = "custom" | "oauth-grant" | "saved-api-key" | "env-var-only" | "no-credential";

export interface ProviderConnectionClassification {
  kind: ProviderConnectionKind;
  /** Present for `saved-api-key`/`env-var-only`/`oauth-grant` (when mapped): the env var carrying the key. */
  envKey?: string;
  /** Every OTHER provider sharing that same env var (flow 304 review finding #2). Always present; empty when none. */
  sharedWith: string[];
}

/**
 * Classify how (if at all) `name`'s credential is held, in the SAME order
 * Disconnect must check it: a custom provider's file entry outranks a
 * same-named built-in (matches `allOpenAiCompatProviders`'s own precedence —
 * a custom `name` colliding with a built-in is excluded from
 * `customCompatProviders`, so this order never double-classifies one name).
 * Pure; never throws.
 */
export function classifyProviderConnection(
  name: string,
  env: Record<string, string | undefined> = process.env,
  dir?: string,
): ProviderConnectionClassification {
  if (customCompatProviders(dir).some((p) => p.name === name)) {
    return { kind: "custom", sharedWith: [] };
  }
  if (loadShellConfig(dir).oauthGrants?.[name] !== undefined) {
    const envKey = oauthEnvKeyFor(name);
    const sharedWith = envKey === undefined ? [] : providersSharingEnvKey(envKey, name, allOpenAiCompatProviders(dir));
    return { kind: "oauth-grant", ...(envKey !== undefined ? { envKey } : {}), sharedWith };
  }
  const registry = providerByName(name, dir);
  const envKey = registry?.envKey;
  if (envKey === undefined) {
    return { kind: "no-credential", sharedWith: [] };
  }
  const sharedWith = providersSharingEnvKey(envKey, name, allOpenAiCompatProviders(dir));
  if (loadShellConfig(dir).apiKeys?.[envKey] !== undefined) {
    return { kind: "saved-api-key", envKey, sharedWith };
  }
  const raw = env[envKey];
  if (typeof raw === "string" && raw.length > 0) {
    return { kind: "env-var-only", envKey, sharedWith };
  }
  return { kind: "no-credential", sharedWith: [] };
}

export interface DisconnectProviderResult {
  ok: boolean;
  kind: ProviderConnectionKind;
  /** Set on `ok: false` (env-var-only) and as an informational note on `no-credential`. */
  reason?: string;
  /** Every OTHER provider this disconnect ALSO affected, sharing the same env var. Always present. */
  sharedWith: string[];
}

/**
 * Disconnect one provider: remove exactly the credential
 * {@link classifyProviderConnection} says it owns, and nothing belonging to a
 * sibling provider'S OWN storage. Also clears `process.env[envKey]` for THIS
 * process when (and only when) the removed key is one keryx itself loaded
 * into it (`savedCredentialEnvKeys()`) — an operator-exported var is never
 * touched, in `env-var-only` or any other branch. This covers BOTH a saved
 * API key and an OAuth grant's mapped env var (flow 304 review finding #1).
 * A shared env var (finding #2) is, by construction, actually removed for
 * every provider in `sharedWith` too — one `apiKeys[envKey]`/env entry serves
 * all of them — `sharedWith` is reported so a caller can say so BEFORE and
 * AFTER acting, not because a second removal is needed. Best-effort; never
 * throws.
 */
export function disconnectProvider(
  name: string,
  env: Record<string, string | undefined> = process.env,
  dir?: string,
): DisconnectProviderResult {
  const classification = classifyProviderConnection(name, env, dir);
  switch (classification.kind) {
    case "custom":
      removeCustomCompatProvider(name, dir);
      removeProviderBaseUrl(name, dir);
      removeProviderModelParams(name, dir);
      return { ok: true, kind: "custom", sharedWith: classification.sharedWith };
    case "oauth-grant": {
      logoutProvider(name, dir);
      const envKey = classification.envKey;
      if (envKey !== undefined && savedCredentialEnvKeys().has(envKey)) {
        delete process.env[envKey];
      }
      return { ok: true, kind: "oauth-grant", sharedWith: classification.sharedWith };
    }
    case "saved-api-key": {
      const envKey = classification.envKey!;
      removeApiKey(envKey, dir);
      if (savedCredentialEnvKeys().has(envKey)) {
        delete process.env[envKey];
      }
      return { ok: true, kind: "saved-api-key", sharedWith: classification.sharedWith };
    }
    case "env-var-only":
      return {
        ok: false,
        kind: "env-var-only",
        reason: `set via ${classification.envKey} in your environment — unset ${classification.envKey} in your shell to disconnect`,
        sharedWith: classification.sharedWith,
      };
    case "no-credential":
      return {
        ok: true,
        kind: "no-credential",
        reason: "no saved credential for this provider — nothing to remove",
        sharedWith: classification.sharedWith,
      };
  }
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

/** Seams for `keryx providers test`/`keryx providers remove` tests: production passes none. */
export interface ProvidersCommandDeps {
  /** Injected fetch for `test` (never a real network call in a test). */
  readonly fetch?: typeof fetch;
  /** Injected env for `test`/`remove` key resolution. Default `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Config dir `test`/`remove` read/write against. Default the real one. */
  readonly dir?: string;
  /** Confirmation prompt for `remove`. Default: a real TTY `y/N` prompt (`../lib/prompt`'s `confirm`). */
  readonly confirm?: (question: string, defaultValue?: boolean) => Promise<boolean>;
}

/**
 * `keryx providers` — reporting over the provider configuration, plus the
 * `test`/`remove` actions (flow 304) that give CLI parity with the `/connect`
 * row buttons. `list`/`cross-family` stay read-only/network-free (AC8);
 * `test` makes exactly one network call, and `remove` writes to disk only
 * after confirmation.
 */
export async function providersCommand(args: string[], deps: ProvidersCommandDeps = {}): Promise<void> {
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
  if (command === "test") {
    await runProvidersTest(args.slice(1), deps);
    return;
  }
  if (command === "remove") {
    await runProvidersRemove(args.slice(1), deps);
    return;
  }
  console.error(`Unknown providers command: ${command}`);
  printProvidersHelp();
  process.exitCode = 1;
}

/** `keryx providers test <name> [--json]` — the CLI form of the `[Test]` row button. */
async function runProvidersTest(args: string[], deps: ProvidersCommandDeps): Promise<void> {
  const name = args[0];
  if (name === undefined || name === "--help" || name === "-h") {
    console.error("Usage: keryx providers test <name> [--json]");
    process.exitCode = 1;
    return;
  }
  const dir = deps.dir;
  const provider = providerByName(name, dir);
  if (provider === undefined) {
    console.error(`Unknown provider: ${name}`);
    process.exitCode = 1;
    return;
  }
  const env = deps.env ?? envWithOAuthAccess(envWithSavedApiKeys(process.env, dir));
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const result = await testProviderConnection(provider, fetchFn, env);
  const label = provider.label ?? provider.name;
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        { provider: name, ok: result.source === "live", models: result.models.length, failure: result.failure ?? null },
        null,
        2,
      ),
    );
    if (result.source !== "live") process.exitCode = 1;
    return;
  }
  if (result.source === "live") {
    console.log(`${label}: ok — ${result.models.length} model(s)`);
    return;
  }
  console.log(modelsFailureLine(label, result.failure ?? { kind: "empty" }));
  process.exitCode = 1;
}

/** `keryx providers remove <name> [--yes] [--json]` — the CLI form of the `[Disconnect]` row button. */
async function runProvidersRemove(args: string[], deps: ProvidersCommandDeps): Promise<void> {
  const name = args[0];
  if (name === undefined || name === "--help" || name === "-h") {
    console.error("Usage: keryx providers remove <name> [--yes] [--json]");
    process.exitCode = 1;
    return;
  }
  const dir = deps.dir;
  const env = deps.env ?? process.env;
  const json = args.includes("--json");
  // flow 304 review finding #3: an unknown name used to report success and
  // exit 0. Validate the SAME way `test` does, before even asking to confirm.
  if (providerByName(name, dir) === undefined) {
    if (json) {
      console.log(JSON.stringify({ provider: name, ok: false, reason: "unknown provider" }, null, 2));
    } else {
      console.error(`Unknown provider: ${name}`);
    }
    process.exitCode = 1;
    return;
  }
  // Classified BEFORE confirming (flow 304 review finding #2) so the
  // confirmation prompt can name every provider this ALSO disconnects —
  // `disconnectProvider` re-classifies internally too, which is fine: this
  // read is pure and cheap, and the two must agree since nothing external
  // can change the classification between this call and the actual removal
  // (a CLI invocation is single-threaded, unlike the TUI's own arm/confirm
  // gap, which re-classifies at confirm time for the same reason).
  const classification = classifyProviderConnection(name, env, dir);
  const warning = sharedCredentialWarning(classification.sharedWith, classification.envKey);
  const yes = args.includes("--yes");
  const confirmFn = deps.confirm ?? ttyConfirm;
  const question =
    warning === undefined
      ? `Disconnect provider "${name}" and remove its saved credential?`
      : `Disconnect provider "${name}" and remove its saved credential? Note: ${warning}.`;
  const confirmed = yes || (await confirmFn(question, false));
  if (!confirmed) {
    if (json) {
      console.log(JSON.stringify({ provider: name, ok: false, reason: "not confirmed", sharedWith: classification.sharedWith }, null, 2));
    } else {
      console.log("keryx providers remove: not confirmed — nothing was changed.");
    }
    if (!yes && !process.stdin.isTTY && deps.confirm === undefined) process.exitCode = 1;
    return;
  }
  const result = disconnectProvider(name, env, dir);
  if (json) {
    console.log(
      JSON.stringify(
        { provider: name, ok: result.ok, kind: result.kind, sharedWith: result.sharedWith, reason: result.reason ?? null },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    console.log(`keryx providers remove: "${name}" not removed — ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  const sharedNote = sharedCredentialWarning(result.sharedWith, classification.envKey);
  console.log(
    `keryx providers remove: "${name}" disconnected (${result.kind}).${sharedNote !== undefined ? ` Note: ${sharedNote}.` : ""}${result.reason !== undefined ? ` ${result.reason}` : ""}`,
  );
}

function runProvidersList(args: string[]): void {
  const env = envWithOAuthAccess(envWithSavedApiKeys());
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
  const decision = crossFamilyReviewForSession(
    args.includes("--opt-in"),
    {
      providerId: optionValue(args, "--session-provider"),
      modelId: optionValue(args, "--session-model"),
    },
    { fromShellConfig: args.includes("--from-shell-config") },
  );

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
 * `session` fields are optional and resolve through `resolveCallerSession`,
 * exactly as `keryx review tier` resolves its session: `KERYX_SESSION_PROVIDER`/
 * `KERYX_SESSION_MODEL`, else nothing — the selection `keryx shell` persisted
 * only with `fromShellConfig`. So the two model-selection seams compose: `review
 * tier` answers "how capable a model", this answers "whose model", and both read
 * the same session. The persisted selection is not the default because it is not
 * the caller: from Claude Code it classified a Claude-authored change as the
 * family `keryx shell` was last pointed at.
 *
 * Never throws, never makes a network call, and returns a decision with a stated
 * reason on every path.
 */
export function crossFamilyReviewForSession(
  optIn: boolean,
  session: { providerId?: string | undefined; modelId?: string | undefined } = {},
  options: { fromShellConfig?: boolean; env?: Readonly<Record<string, string | undefined>> } = {},
): CrossFamilyReviewDecision {
  const resolved = resolveCallerSession({
    flagProvider: session.providerId,
    flagModel: session.modelId,
    fromShellConfig: options.fromShellConfig,
    env: options.env,
  });
  return decideCrossFamilyReview({
    optIn,
    session: { providerId: resolved.providerId, modelId: resolved.modelId },
    configured: configuredProviders(envWithOAuthAccess(envWithSavedApiKeys())),
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
  keryx providers cross-family [--opt-in] [--session-provider <id>] [--session-model <id>] [--from-shell-config] [--json]
  keryx providers test <name> [--json]
  keryx providers remove <name> [--yes] [--json]

Commands:
  list          Providers this operator has configured, and the family of each
  cross-family  Whether review can run on a different model family than authored
                the change, and the record the round should carry
  test          Run this provider's live model-list probe and report ok/count
                or the failure reason. Makes ONE network call — unlike list/
                cross-family, not network-free
  remove        Disconnect a provider: remove its saved API key, OAuth grant,
                or custom-provider entry. Errors on an unknown name (exit 1)
                before asking anything. Asks for confirmation on a terminal;
                refuses without one unless --yes. A provider whose only
                credential is an environment variable you exported yourself
                cannot be removed — the command names the variable to unset.
                Some built-ins share one env var (e.g. zai/zai-coding both
                read ZAI_API_KEY): removing either ALSO disconnects the
                other, and both the confirmation prompt and the result name
                every provider this affects — --json lists them under
                sharedWith

cross-family is OPT-IN: without --opt-in it reports what would happen and
chooses single-family review. Dispatching to another provider spends tokens and
sends the change to a second vendor, which is a decision rather than an
optimisation. With no second family configured it reports single-family review
with a stated reason and exits 0 — that is a normal configuration, not an error.

Disconnecting a provider removes only keryx's LOCAL copy of its credential. It
does not revoke anything at the vendor: an OAuth grant is deleted from
auth.json only (no revoke call), and a saved API key simply stops being read —
the key itself is still valid until you revoke it yourself with the vendor.
`);
}
