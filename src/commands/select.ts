// Provider/model detection + the interactive numbered picker (flow 022, T6 /
// AC1-AC2, R2-4 interactive CLI/TUI).
//
// `detectProviders(deps)` probes the local environment for usable chat
// providers WITHOUT any SDK and WITHOUT ever storing a credential: it issues a
// single injected-`fetch` `GET {baseUrl}/api/tags` to enumerate Ollama chat
// models (fail-SOFT — a throw / non-2xx simply omits ollama), adds `anthropic`
// ONLY when `deps.env.ANTHROPIC_API_KEY` is a non-empty string (a STATIC
// `claude-*` list, ZERO network calls, the key never leaves `env`), and
// (flow 183 T9) `openai`/`gemini` the same way — `deps.env.OPENAI_API_KEY` /
// `deps.env.GEMINI_API_KEY` (falling back to `GOOGLE_API_KEY`), each a
// static curated list, zero network calls, key never leaves `env` — and
// ALWAYS offers `fake`. It is deterministic: no `Date.now`/`Math.random`.
//
// `pickProviderModel(io, detected)` renders a numbered provider menu then a
// numbered model menu over the injected `ShellIO`, re-prompting on
// non-numeric / out-of-range input and falling back deterministically to
// `detected[0]` (+ its first model) on EOF. It never throws and never hangs.
//
// Offline / deterministic: `fetch` + `env` are always injected; no real
// network, no real TTY/stdin. See `.metaproject/flows/
// 022-2026-07-13-keryx-r2-4-tui/acceptance-criteria.md` (AC1-AC2).

import { isLoopbackHost, isPrivateEgressHost } from "../harness/mutation/guard";
import {
  allOpenAiCompatProviders,
  fetchOpenAiCompatModels,
  isProviderPlatformSupported,
  providerByName,
  resolveProviderBaseUrl,
  resolveModelsForPicker,
} from "./providers";

type ShellIO = {
  lines: AsyncIterable<string>;
  write: (text: string) => void;
  onTurnStart?: () => void;
  onTurnEnd?: (full: string) => void;
  onSystem?: (text: string) => void;
  /** Flush queued asynchronous notices only while terminal output is safe. */
  onSafeBoundary?: () => void;
};

/** A provider detected as usable, with its selectable chat `models`. */
export interface DetectedProvider {
  name: string;
  models: string[];
  /** Present only for providers with a concrete endpoint (ollama + OpenAI-compat). */
  baseUrl?: string;
  /** OpenAI-compat registry providers: env var carrying the Bearer key. */
  envKey?: string;
  /** Chat path override (Z.AI GLM answers at `/chat/completions`, no `/v1`). */
  chatPath?: string;
  /** Models-list path override (Z.AI GLM: `/models`). */
  modelsPath?: string;
  /** Display label + short note for the picker chrome. */
  label?: string;
  note?: string;
}

/** Injected dependencies keeping `detectProviders` deterministic + offline. */
export interface DetectProvidersDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Ollama probe base URL; defaults to the loopback Ollama default. */
  baseUrl?: string;
  /** Runtime platform filter for registry providers (defaults to `process.platform`). */
  platform?: string;
}

/** Mirrors `OllamaProvider`'s `DEFAULT_BASE_URL` (loopback Ollama default). */
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** Static `claude-*` model list surfaced when `ANTHROPIC_API_KEY` is present. */
const ANTHROPIC_MODELS: readonly string[] = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];

/**
 * Static OpenAI model list surfaced when `OPENAI_API_KEY` is present (flow
 * 183 T9). No live listing endpoint is wired (`OpenAiProvider.describe()`
 * declares `modelListing: false`) — this curated set mirrors
 * `ANTHROPIC_MODELS`'s pattern exactly. Current as of this writing; update
 * when OpenAI's model lineup moves on.
 */
const OPENAI_MODELS: readonly string[] = ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"];

/**
 * Static Gemini model list surfaced when `GEMINI_API_KEY`/`GOOGLE_API_KEY`
 * is present (flow 183 T9). No live listing endpoint is wired
 * (`GeminiProvider.describe()` declares `modelListing: false`) — mirrors
 * `ANTHROPIC_MODELS`'s pattern. Current as of this writing; update when
 * Gemini's model lineup moves on.
 */
const GEMINI_MODELS: readonly string[] = ["gemini-3.7-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"];

/**
 * Fetch OpenRouter's LIVE model list (`GET /api/v1/models`, public — no key) so the
 * picker offers all models (filterable by name, e.g. `:free`). Thin wrapper over the
 * generic {@link fetchOpenAiCompatModels} for the `openrouter` registry entry;
 * falls back to its curated list on any failure. Never throws.
 */
export async function fetchOpenRouterModels(fetchFn: typeof fetch): Promise<string[]> {
  const openrouter = providerByName("openrouter");
  return openrouter === undefined ? [] : fetchOpenAiCompatModels(fetchFn, openrouter);
}

/** The always-available offline echo provider's model list. */
const FAKE_MODELS: readonly string[] = ["fake-echo"];

/** The `/api/tags` model shape we consume (extra fields ignored). */
interface OllamaTagModel {
  name?: unknown;
  details?: { family?: unknown } | undefined;
}

/** True when a model is an embedding model (excluded from the chat list). */
function isEmbeddingModel(model: OllamaTagModel): boolean {
  const name = typeof model.name === "string" ? model.name.toLowerCase() : "";
  const familyRaw = model.details?.family;
  const family = typeof familyRaw === "string" ? familyRaw.toLowerCase() : "";
  return family.includes("embed") || family.includes("bert") || name.includes("embed");
}

/**
 * Probe `{baseUrl}/api/tags` and return the chat model ids (embedding models
 * excluded). Returns `undefined` fail-SOFT on any throw / non-2xx — the caller
 * then omits ollama entirely rather than surfacing an error.
 */
async function probeOllamaModels(deps: DetectProvidersDeps, baseUrl: string): Promise<string[] | undefined> {
  // SSRF guard (review-hardening fix #1): before dialing, resolve the host and
  // fail-SOFT (omit ollama, issue NO fetch) on any private/link-local/metadata
  // destination — while keeping LOOPBACK (Ollama's own default) unblocked. Reuses
  // the same `isPrivateEgressHost`/`isLoopbackHost` predicates as the
  // `OllamaProvider` chat path, so metadata/private are always denied there and
  // here. NOTE: loopback is allowed UNCONDITIONALLY for the probe (enumerating a
  // local Ollama's model names via GET /api/tags is the feature's default
  // purpose and sends no user data), whereas the chat path gates loopback behind
  // an explicit `grant.allowLoopback` opt-in — a deliberate difference, not a
  // widening of the private/metadata denial.
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = baseUrl;
  }
  if (isPrivateEgressHost(host) && !isLoopbackHost(host)) {
    return undefined;
  }
  let response: Response;
  try {
    response = await deps.fetch(`${baseUrl}/api/tags`);
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const rawModels = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(rawModels)) {
    return undefined;
  }
  const models: string[] = [];
  for (const entry of rawModels as OllamaTagModel[]) {
    if (typeof entry?.name !== "string") {
      continue;
    }
    if (isEmbeddingModel(entry)) {
      continue;
    }
    models.push(entry.name);
  }
  return models;
}

/**
 * Detect usable chat providers. Order: real providers first (ollama, then
 * anthropic), `fake` always last. Never throws.
 */
export async function detectProviders(deps: DetectProvidersDeps): Promise<DetectedProvider[]> {
  const baseUrl = deps.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  const platform = deps.platform ?? process.platform;
  const detected: DetectedProvider[] = [];

  const ollamaModels = await probeOllamaModels(deps, baseUrl);
  if (ollamaModels !== undefined) {
    detected.push({ name: "ollama", models: ollamaModels, baseUrl });
  }

  const anthropicKey = deps.env.ANTHROPIC_API_KEY;
  if (typeof anthropicKey === "string" && anthropicKey.length > 0) {
    // The credential is read from `env` only — never placed on the returned
    // shape (which has no field for it) and never logged.
    detected.push({ name: "anthropic", models: [...ANTHROPIC_MODELS] });
  }

  // flow 183 T9: openai/gemini as first-class picker entries, same shape as
  // anthropic above — key presence gates visibility, the key itself never
  // reaches the returned shape or gets logged.
  const openaiKey = deps.env.OPENAI_API_KEY;
  if (typeof openaiKey === "string" && openaiKey.length > 0) {
    detected.push({ name: "openai", models: [...OPENAI_MODELS] });
  }

  const geminiKey = deps.env.GEMINI_API_KEY ?? deps.env.GOOGLE_API_KEY;
  if (typeof geminiKey === "string" && geminiKey.length > 0) {
    detected.push({ name: "gemini", models: [...GEMINI_MODELS] });
  }

  // Hosted OpenAI-compatible providers (OpenRouter, DeepSeek, Z.AI GLM, Cerebras,
  // Groq, Moonshot, …) are ALWAYS offered — each key is read from env at
  // construction time, or the interactive shell prompts + persists it, so the user
  // need not pre-set env vars just to see them. Curated `models` are a fallback; the
  // picker fetches each provider's live `/models` list. Keys never surface here.
  for (const p of allOpenAiCompatProviders()) {
    if (!isProviderPlatformSupported(p, platform)) {
      continue;
    }
    detected.push({
      name: p.name,
      models: [...p.models],
      baseUrl: resolveProviderBaseUrl(p, deps.env),
      label: p.label,
      ...(p.chatPath !== undefined ? { chatPath: p.chatPath } : {}),
      ...(p.modelsPath !== undefined ? { modelsPath: p.modelsPath } : {}),
      ...(p.note !== undefined ? { note: p.note } : {}),
      ...(p.envKey !== undefined ? { envKey: p.envKey } : {}),
    });
  }

  detected.push({ name: "fake", models: [...FAKE_MODELS] });
  return detected;
}

/**
 * Interactive agent/chat mode picker over the injected `ShellIO`. Renders a
 * numbered menu (`1. agent`, `2. chat`), reads one choice, and returns `true`
 * for agent / `false` for chat. Re-prompts on invalid input. DEFAULTS to agent
 * (`true`) on an empty line (bare Enter) or EOF — agent is the product default.
 * Never throws/hangs; shares the caller's line iterator like `pickProviderModel`.
 */
export async function pickAgentMode(io: ShellIO): Promise<boolean> {
  const iterator = io.lines[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string | undefined> => {
    const result = await iterator.next();
    return result.done === true ? undefined : result.value;
  };

  io.write("Select a mode:\n");
  io.write("  1. agent  (read-only tools + metaproject context)\n");
  io.write("  2. chat   (plain conversation, no tools)\n");

  while (true) {
    const line = await nextLine();
    if (line === undefined) {
      return true; // EOF → default to agent
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed === "1") {
      return true; // bare Enter or "1" → agent
    }
    if (trimmed === "2") {
      return false;
    }
    io.write("Invalid choice — enter 1 (agent) or 2 (chat), or Enter for agent.\n");
  }
}

/** Parse a 1-based menu choice into a 0-based index, or `undefined` if invalid. */
function parseChoice(line: string, count: number): number | undefined {
  const trimmed = line.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < 1 || value > count) {
    return undefined;
  }
  return value - 1;
}

/** Build the `{provider, model, baseUrl?}` result, omitting an absent `baseUrl`. */
function toSelection(provider: DetectedProvider, model: string): { provider: string; model: string; baseUrl?: string } {
  return provider.baseUrl === undefined
    ? { provider: provider.name, model }
    : { provider: provider.name, model, baseUrl: provider.baseUrl };
}

/** Optional deps so tests can inject fetch/env without real network. */
export interface PickProviderModelDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Interactive numbered provider + model picker over the injected `ShellIO`.
 * After a provider is chosen, ALWAYS attempts a live `/models` request when
 * that provider is OpenAI-compat (and the network answers); curated lists are
 * only the offline/error fallback. Re-prompts on invalid input; on EOF before
 * a valid choice, falls back deterministically to `detected[0]` (+ its first
 * model). Never throws/hangs.
 */
export async function pickProviderModel(
  io: ShellIO,
  detected: DetectedProvider[],
  deps: PickProviderModelDeps = {},
): Promise<{ provider: string; model: string; baseUrl?: string }> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const iterator = io.lines[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string | undefined> => {
    const result = await iterator.next();
    return result.done === true ? undefined : result.value;
  };

  const fallback = (): { provider: string; model: string; baseUrl?: string } => {
    const first = detected[0];
    if (first === undefined) {
      throw new Error("pickProviderModel: `detected` must be non-empty");
    }
    const model = first.models[0] ?? "";
    return toSelection(first, model);
  };

  // Stage 1 — provider menu.
  io.write("Select a provider:\n");
  for (let i = 0; i < detected.length; i++) {
    const provider = detected[i];
    if (provider === undefined) {
      continue;
    }
    io.write(`  ${i + 1}. ${provider.name}\n`);
  }

  let chosenProvider: DetectedProvider;
  while (true) {
    const line = await nextLine();
    if (line === undefined) {
      return fallback();
    }
    const index = parseChoice(line, detected.length);
    if (index === undefined) {
      io.write("Invalid choice — enter the number of a listed provider.\n");
      continue;
    }
    const provider = detected[index];
    if (provider === undefined) {
      io.write("Invalid choice — enter the number of a listed provider.\n");
      continue;
    }
    chosenProvider = provider;
    break;
  }

  // Stage 2 — live model list when the network is up; curated offline fallback.
  io.write(`Fetching models for ${chosenProvider.name}…\n`);
  const resolved = await resolveModelsForPicker(fetchFn, chosenProvider, env);
  const models = resolved.models.length > 0 ? resolved.models : chosenProvider.models;
  if (resolved.source === "live") {
    io.write(`  (${models.length} model(s) from API)\n`);
  } else if (providerByName(chosenProvider.name) !== undefined) {
    io.write(`  (offline/API fallback · ${models.length} curated model(s))\n`);
  }

  io.write(`Select a model for ${chosenProvider.name}:\n`);
  for (let i = 0; i < models.length; i++) {
    io.write(`  ${i + 1}. ${models[i]}\n`);
  }

  while (true) {
    const line = await nextLine();
    if (line === undefined) {
      return fallback();
    }
    const index = parseChoice(line, models.length);
    if (index === undefined) {
      io.write("Invalid choice — enter the number of a listed model.\n");
      continue;
    }
    const model = models[index];
    if (model === undefined) {
      io.write("Invalid choice — enter the number of a listed model.\n");
      continue;
    }
    return toSelection(chosenProvider, model);
  }
}
