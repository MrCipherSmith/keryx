// Provider/model detection + the interactive numbered picker (flow 022, T6 /
// AC1-AC2, R2-4 interactive CLI/TUI).
//
// `detectProviders(deps)` probes the local environment for usable chat
// providers WITHOUT any SDK and WITHOUT ever storing a credential: it issues a
// single injected-`fetch` `GET {baseUrl}/api/tags` to enumerate Ollama chat
// models (fail-SOFT — a throw / non-2xx simply omits ollama), adds `anthropic`
// ONLY when `deps.env.ANTHROPIC_API_KEY` is a non-empty string (a STATIC
// `claude-*` list, ZERO network calls, the key never leaves `env`), and ALWAYS
// offers `fake`. It is deterministic: no `Date.now`/`Math.random`.
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
import type { ShellIO } from "./shell";

/** A provider detected as usable, with its selectable chat `models`. */
export interface DetectedProvider {
  name: "ollama" | "anthropic" | "openrouter" | "fake";
  models: string[];
  /** Present only for providers with a concrete endpoint (ollama, openrouter). */
  baseUrl?: string;
}

/** Injected dependencies keeping `detectProviders` deterministic + offline. */
export interface DetectProvidersDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Ollama probe base URL; defaults to the loopback Ollama default. */
  baseUrl?: string;
}

/** Mirrors `OllamaProvider`'s `DEFAULT_BASE_URL` (loopback Ollama default). */
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** Static `claude-*` model list surfaced when `ANTHROPIC_API_KEY` is present. */
const ANTHROPIC_MODELS: readonly string[] = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];

/**
 * Static recommended cheap tool-capable model list surfaced when
 * `OPENROUTER_API_KEY` is present (OpenRouter serves 400+ models; these are a
 * curated default — any OpenRouter model id can still be passed via `--model`).
 */
const OPENROUTER_MODELS: readonly string[] = [
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash-001",
  "qwen/qwen-2.5-7b-instruct",
  "meta-llama/llama-3.1-8b-instruct",
];
/** OpenRouter's OpenAI-compatible base URL (the adapter appends /v1/chat/completions). */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/**
 * Fetch OpenRouter's LIVE model list (`GET /api/v1/models`, public — no key) so the
 * picker offers all models (filterable by name, e.g. `:free`). Returns model ids
 * sorted alphabetically; on any failure (offline / non-2xx / malformed) falls back
 * to the curated {@link OPENROUTER_MODELS}. Never throws.
 */
export async function fetchOpenRouterModels(fetchFn: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchFn(`${OPENROUTER_BASE_URL}/v1/models`);
    if (!res.ok) {
      return [...OPENROUTER_MODELS];
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> } | null;
    const ids = Array.isArray(body?.data)
      ? body.data.map((m) => (typeof m.id === "string" ? m.id : "")).filter((id) => id.length > 0)
      : [];
    return ids.length > 0 ? Array.from(new Set(ids)).sort() : [...OPENROUTER_MODELS];
  } catch {
    return [...OPENROUTER_MODELS];
  }
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

  // OpenRouter is ALWAYS offered (a major hosted gateway). The `OPENROUTER_API_KEY`
  // is read from env at provider-construction time, or the interactive shell
  // prompts for it when absent — so a user need not pre-set the env var just to see
  // it in the picker. Static curated (cheap) model list; no network probe; the key
  // is never surfaced on the returned shape / logged.
  detected.push({ name: "openrouter", models: [...OPENROUTER_MODELS], baseUrl: OPENROUTER_BASE_URL });

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

/**
 * Interactive numbered provider + model picker over the injected `ShellIO`.
 * Re-prompts on invalid input; on EOF before a valid choice, falls back
 * deterministically to `detected[0]` (+ its first model). Never throws/hangs.
 */
export async function pickProviderModel(
  io: ShellIO,
  detected: DetectedProvider[],
): Promise<{ provider: string; model: string; baseUrl?: string }> {
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

  // Stage 2 — model menu for the chosen provider.
  io.write(`Select a model for ${chosenProvider.name}:\n`);
  for (let i = 0; i < chosenProvider.models.length; i++) {
    io.write(`  ${i + 1}. ${chosenProvider.models[i]}\n`);
  }

  while (true) {
    const line = await nextLine();
    if (line === undefined) {
      return fallback();
    }
    const index = parseChoice(line, chosenProvider.models.length);
    if (index === undefined) {
      io.write("Invalid choice — enter the number of a listed model.\n");
      continue;
    }
    const model = chosenProvider.models[index];
    if (model === undefined) {
      io.write("Invalid choice — enter the number of a listed model.\n");
      continue;
    }
    return toSelection(chosenProvider, model);
  }
}
