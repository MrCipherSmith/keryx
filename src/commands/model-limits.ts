// Provider-neutral model limits for `/status`.
//
// Grok Build's `/usage` shows a real context window and a usage-limit %.
// Keryx talks to many providers, so this module NEVER invents a window
// (no hardcoded 128k). It only surfaces numbers the provider actually
// reported: live `/models` fields, Ollama `/api/show`, optional balance,
// and rate-limit response headers when present.

import { isLoopbackHost, isPrivateEgressHost } from "../harness/mutation/guard";
import { envWithSavedApiKeys } from "../lib/shell-config";
import {
  DEFAULT_MODELS_PATH,
  balanceCapableProvider,
  fetchProviderBalance,
  providerApiKey,
  providerByName,
  resolveProviderBaseUrl,
  type ProviderBalance,
} from "./providers";

export const MODEL_LIMITS_TIMEOUT_MS = 8_000;
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** How a context-window figure was obtained. Absent = unknown, not guessed. */
export type ContextWindowSource = "live-models" | "ollama-show";

/** Rate-limit counters copied from response headers when the provider sent them. */
export interface RateLimitSnapshot {
  requestsLimit?: number;
  requestsRemaining?: number;
  tokensLimit?: number;
  tokensRemaining?: number;
  reset?: string;
}

/** Neutral limits snapshot for the active provider/model. All fields optional. */
export interface ModelLimits {
  contextWindow?: number;
  contextSource?: ContextWindowSource;
  rateLimit?: RateLimitSnapshot;
  balance?: ProviderBalance;
}

const CONTEXT_WINDOW_KEYS = [
  "context_length",
  "context_window",
  "contextWindow",
  "max_model_len",
  "max_input_tokens",
  "maxInputTokens",
] as const;

const NESTED_LIMIT_KEYS = ["architecture", "top_provider", "topProvider", "meta", "limits", "capabilities"] as const;

export function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

/**
 * Pull a context-window size out of a `/models` (or similar) object.
 * `max_tokens` is ignored — providers use it for output caps as often as input.
 */
export function extractContextWindow(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const rec = entry as Record<string, unknown>;
  for (const key of CONTEXT_WINDOW_KEYS) {
    const n = asPositiveInt(rec[key]);
    if (n !== undefined) {
      return n;
    }
  }
  for (const nested of NESTED_LIMIT_KEYS) {
    const inner = extractContextWindow(rec[nested]);
    if (inner !== undefined) {
      return inner;
    }
  }
  return undefined;
}

function entryId(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) {
    return "";
  }
  const rec = entry as Record<string, unknown>;
  if (typeof rec.id === "string" && rec.id.length > 0) {
    return rec.id;
  }
  if (typeof rec.name === "string" && rec.name.length > 0) {
    return rec.name;
  }
  return "";
}

/** Match `modelId` against a `/models` list: exact, then `org/name` suffix. */
export function findModelEntry(data: readonly unknown[], modelId: string): unknown | undefined {
  const wanted = modelId.trim();
  if (wanted.length === 0) {
    return undefined;
  }
  const lower = wanted.toLowerCase();
  const exact = data.find((entry) => entryId(entry).toLowerCase() === lower);
  if (exact !== undefined) {
    return exact;
  }
  const short = lower.includes("/") ? (lower.split("/").pop() ?? lower) : lower;
  return data.find((entry) => {
    const id = entryId(entry).toLowerCase();
    if (id.length === 0) {
      return false;
    }
    return id.endsWith(`/${short}`) || id.split("/").pop() === short;
  });
}

const REQUEST_LIMIT_HEADERS = [
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit",
  "anthropic-ratelimit-requests-limit",
] as const;
const REQUEST_REMAINING_HEADERS = [
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining",
  "anthropic-ratelimit-requests-remaining",
] as const;
const TOKEN_LIMIT_HEADERS = ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"] as const;
const TOKEN_REMAINING_HEADERS = [
  "x-ratelimit-remaining-tokens",
  "anthropic-ratelimit-tokens-remaining",
] as const;
const RESET_HEADERS = [
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset",
  "anthropic-ratelimit-requests-reset",
  "retry-after",
] as const;

function firstHeaderInt(headers: Headers, names: readonly string[]): number | undefined {
  for (const name of names) {
    const n = asPositiveInt(headers.get(name));
    if (n !== undefined) {
      return n;
    }
  }
  return undefined;
}

function firstHeaderText(headers: Headers, names: readonly string[]): string | undefined {
  for (const name of names) {
    const raw = headers.get(name)?.trim();
    if (raw !== undefined && raw.length > 0) {
      return raw;
    }
  }
  return undefined;
}

/** Copy rate-limit headers when present. Empty object → undefined (nothing to show). */
export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot | undefined {
  const snapshot: RateLimitSnapshot = {};
  const requestsLimit = firstHeaderInt(headers, REQUEST_LIMIT_HEADERS);
  const requestsRemaining = firstHeaderInt(headers, REQUEST_REMAINING_HEADERS);
  const tokensLimit = firstHeaderInt(headers, TOKEN_LIMIT_HEADERS);
  const tokensRemaining = firstHeaderInt(headers, TOKEN_REMAINING_HEADERS);
  const reset = firstHeaderText(headers, RESET_HEADERS);
  if (requestsLimit !== undefined) snapshot.requestsLimit = requestsLimit;
  if (requestsRemaining !== undefined) snapshot.requestsRemaining = requestsRemaining;
  if (tokensLimit !== undefined) snapshot.tokensLimit = tokensLimit;
  if (tokensRemaining !== undefined) snapshot.tokensRemaining = tokensRemaining;
  if (reset !== undefined) snapshot.reset = reset;
  return Object.keys(snapshot).length === 0 ? undefined : snapshot;
}

export function formatRateLimit(limit: RateLimitSnapshot | undefined): string | undefined {
  if (limit === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (limit.requestsRemaining !== undefined && limit.requestsLimit !== undefined) {
    parts.push(`${limit.requestsRemaining}/${limit.requestsLimit} requests`);
  } else if (limit.requestsRemaining !== undefined) {
    parts.push(`${limit.requestsRemaining} requests left`);
  } else if (limit.requestsLimit !== undefined) {
    parts.push(`${limit.requestsLimit} request cap`);
  }
  if (limit.tokensRemaining !== undefined && limit.tokensLimit !== undefined) {
    parts.push(`${limit.tokensRemaining}/${limit.tokensLimit} tokens`);
  } else if (limit.tokensRemaining !== undefined) {
    parts.push(`${limit.tokensRemaining} tokens left`);
  }
  if (limit.reset !== undefined) {
    parts.push(`reset ${limit.reset}`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Ollama `/api/show`: prefer configured `num_ctx`, else architecture `*.context_length`. */
export function extractOllamaContextWindow(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.parameters === "string") {
    const match = /\bnum_ctx\s+(\d+)/.exec(rec.parameters);
    if (match?.[1] !== undefined) {
      const n = asPositiveInt(match[1]);
      if (n !== undefined) {
        return n;
      }
    }
  }
  const info = rec.model_info;
  if (typeof info === "object" && info !== null) {
    for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
      if (key === "context_length" || key.endsWith(".context_length")) {
        const n = asPositiveInt(value);
        if (n !== undefined) {
          return n;
        }
      }
    }
  }
  return extractContextWindow(body);
}

export interface LoadSessionLimitsInput {
  provider: string;
  model: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

async function timedFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function ollamaShowAllowed(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  if (isPrivateEgressHost(host) && !isLoopbackHost(host)) {
    return false;
  }
  return true;
}

async function fetchCompatLimits(
  fetchFn: typeof fetch,
  providerName: string,
  model: string,
  baseUrl: string | undefined,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Pick<ModelLimits, "contextWindow" | "contextSource" | "rateLimit">> {
  const compat = providerByName(providerName);
  if (compat === undefined) {
    return {};
  }
  const resolved = resolveProviderBaseUrl(
    { ...compat, ...(baseUrl !== undefined ? { baseUrl } : {}) },
    env,
  );
  const url = `${resolved.replace(/\/+$/, "")}${compat.modelsPath ?? DEFAULT_MODELS_PATH}`;
  const apiKey = providerApiKey(compat, env) ?? compat.apiKey;
  const init: RequestInit = {};
  if (apiKey !== undefined && apiKey.length > 0) {
    init.headers = { authorization: `Bearer ${apiKey}` };
  }
  const res = await timedFetch(fetchFn, url, init, timeoutMs);
  if (res === undefined || !res.ok) {
    return {};
  }
  const rateLimit = parseRateLimitHeaders(res.headers);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return rateLimit === undefined ? {} : { rateLimit };
  }
  const data = (body as { data?: unknown } | null)?.data;
  const entries = Array.isArray(data) ? data : Array.isArray(body) ? body : [];
  const entry = findModelEntry(entries, model);
  const contextWindow = extractContextWindow(entry);
  return {
    ...(contextWindow !== undefined ? { contextWindow, contextSource: "live-models" as const } : {}),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
  };
}

async function fetchOllamaLimits(
  fetchFn: typeof fetch,
  model: string,
  baseUrl: string | undefined,
  timeoutMs: number,
): Promise<Pick<ModelLimits, "contextWindow" | "contextSource">> {
  const resolved = (baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  if (!ollamaShowAllowed(resolved)) {
    return {};
  }
  const res = await timedFetch(
    fetchFn,
    `${resolved}/api/show`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model }),
    },
    timeoutMs,
  );
  if (res === undefined || !res.ok) {
    return {};
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {};
  }
  const contextWindow = extractOllamaContextWindow(body);
  return contextWindow === undefined ? {} : { contextWindow, contextSource: "ollama-show" };
}

/**
 * Live limits for the active selection. Never throws. Missing fields stay
 * absent — `/status` renders them as "—" rather than a guessed window.
 */
export async function loadSessionLimits(input: LoadSessionLimitsInput): Promise<ModelLimits> {
  const fetchFn = input.fetch ?? globalThis.fetch;
  const env = envWithSavedApiKeys(input.env ?? process.env);
  const timeoutMs = input.timeoutMs ?? MODEL_LIMITS_TIMEOUT_MS;
  const provider = input.provider.trim();
  const model = input.model.trim();

  const limitsPromise: Promise<Pick<ModelLimits, "contextWindow" | "contextSource" | "rateLimit">> =
    provider === "ollama"
      ? fetchOllamaLimits(fetchFn, model, input.baseUrl, timeoutMs)
      : providerByName(provider) !== undefined
        ? fetchCompatLimits(fetchFn, provider, model, input.baseUrl, env, timeoutMs)
        : Promise.resolve({});

  const capable = balanceCapableProvider(provider);
  const balancePromise: Promise<ProviderBalance | undefined> =
    capable === undefined
      ? Promise.resolve(undefined)
      : fetchProviderBalance(
          fetchFn,
          { ...capable, ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}) },
          providerApiKey(capable, env) ?? capable.apiKey,
          { timeoutMs },
        );

  const [limits, balance] = await Promise.all([limitsPromise, balancePromise]);
  return {
    ...limits,
    ...(balance !== undefined ? { balance } : {}),
  };
}
