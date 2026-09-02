// Single-shot model turn helper (flow 087, item 3 — model-backed commands).
//
// Factors the provider-turn plumbing shared by every model-backed `keryx`
// command (wiki enrich, health explain --narrate, test suggest, flow plan,
// memory reflect --narrate) into ONE place: credential detection, provider
// construction, and a fail-closed single completion over the neutral
// `ProviderPort.stream` boundary. No tools, no policy loop.
//
// FAIL-CLOSED: without a credential for the requested provider (and without an
// injected factory, which tests use) it returns `credentialAvailable: false`
// and empty text — never falling back to an offline FakeProvider (which has no
// transcript) and never touching the network. Deterministic given an injected
// factory.
//
// Default provider resolution (when `--provider` is omitted):
//   1. last provider/model from shell auth.json (if that provider has a key)
//   2. first keyed provider with a credential in env/auth.json
//   3. legacy fallback name `anthropic` (fail-closed if no ANTHROPIC_API_KEY)

import { makeProvider } from "./make-provider";
import type { NormalizedError, NormalizedRequest, NormalizedUsage, ProviderPort } from "./types";
import { OPENAI_COMPAT_PROVIDERS, providerByName } from "../../commands/providers";
import { envWithSavedApiKeys, loadShellConfig } from "../../lib/shell-config";

/** Provider factory matching `makeProvider`'s shape (injectable for tests). */
export type ProviderFactory = (
  name: string,
  model: string,
  opts: { fetch: typeof fetch; env?: Record<string, string | undefined>; baseUrl?: string },
) => ProviderPort;

/**
 * Legacy fallback name when no flag, no saved shell provider, and no keyed
 * credential is found. Not a hard requirement — only used for error messages
 * and fail-closed empty turns.
 */
export const DEFAULT_PROVIDER = "anthropic";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  ollama: "llama3.2",
  // flow 183: keep in sync with select.ts's OPENAI_MODELS/GEMINI_MODELS
  // curated defaults.
  openai: "gpt-5.6-luna",
  gemini: "gemini-2.5-flash-lite",
};

/** Resolve the default model id for a provider. */
export function defaultModelFor(provider: string): string {
  if (DEFAULT_MODELS[provider]) {
    return DEFAULT_MODELS[provider] as string;
  }
  const compat = providerByName(provider);
  return compat?.models[0] ?? "unknown";
}

/** Whether a usable credential exists for `provider` in `env`. */
export function hasCredential(provider: string, env: Record<string, string | undefined>): boolean {
  if (provider === "ollama") {
    return true; // local loopback, no key required
  }
  if (provider === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    return key !== undefined && key.length > 0;
  }
  if (provider === "openai") {
    const key = env.OPENAI_API_KEY;
    return key !== undefined && key.length > 0;
  }
  if (provider === "gemini") {
    const key = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
    return key !== undefined && key.length > 0;
  }
  const compat = providerByName(provider);
  if (compat) {
    if (compat.requiresApiKey === false) {
      return true;
    }
    if (compat.envKey === undefined) {
      return false;
    }
    const key = env[compat.envKey];
    return key !== undefined && key.length > 0;
  }
  return false;
}

/**
 * Providers that require a real API key (excludes ollama — always "available"
 * so it must not win automatic selection unless the user asked for it).
 */
export function keyedProviderCandidates(): string[] {
  return [
    "anthropic",
    "openai",
    "gemini",
    ...OPENAI_COMPAT_PROVIDERS.filter((provider) => provider.requiresApiKey !== false).map((p) => p.name),
  ];
}

/**
 * Pick a provider for narrate/single-turn when the caller omitted `--provider`.
 *
 * Order:
 * 1. Shell-saved provider+model from auth.json, if that provider has a key
 * 2. First keyed provider with a credential in `env`
 * 3. `DEFAULT_PROVIDER` (anthropic) — typically fails closed with a clear error
 *
 * Ollama is never auto-selected (would always win and hit the network).
 */
export function resolveAutoProvider(
  env: Record<string, string | undefined>,
  opts?: { preferSavedShell?: boolean },
): { provider: string; model?: string } {
  if (opts?.preferSavedShell !== false) {
    try {
      const saved = loadShellConfig();
      if (
        typeof saved.provider === "string" &&
        saved.provider.length > 0 &&
        hasCredential(saved.provider, env)
      ) {
        return {
          provider: saved.provider,
          ...(typeof saved.model === "string" && saved.model.length > 0
            ? { model: saved.model }
            : {}),
        };
      }
    } catch {
      // ignore config read failures
    }
  }
  for (const name of keyedProviderCandidates()) {
    if (hasCredential(name, env)) {
      return { provider: name };
    }
  }
  return { provider: DEFAULT_PROVIDER };
}

export interface ModelTurnInput {
  /** Provider name (anthropic | ollama | openrouter | grok | …). */
  provider?: string;
  /** Model id; a per-provider default is used when absent. */
  model?: string;
  /** Trusted system instruction. */
  system: string;
  /** The user message (project content). */
  user: string;
  /** Output token budget. Defaults to 1024. */
  maxOutputTokens?: number;
  /** Correlation id stem. */
  requestId?: string;
  // Injected, all-optional for deterministic offline tests:
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  baseUrl?: string;
  providerFactory?: ProviderFactory;
  /** Cancels the underlying provider stream when the owning operation stops. */
  signal?: AbortSignal;
  /**
   * When false, skip reading shell auth.json for auto provider selection
   * (tests). Default true.
   */
  preferSavedShell?: boolean;
}

export interface ModelTurnResult {
  provider: string;
  model: string;
  credentialAvailable: boolean;
  text: string;
  error?: NormalizedError;
  usage?: NormalizedUsage;
  latencyMs?: number;
  reasoning?: boolean;
}

/**
 * Run one fail-closed provider turn. Returns assembled text, or
 * `credentialAvailable: false` (empty text, no error) when no credential is
 * present and no factory was injected — the caller decides how to surface that.
 */
export async function runModelTurn(input: ModelTurnInput): Promise<ModelTurnResult> {
  // Merge keys from `~/.local/share/keryx/auth.json` so model-backed CLI commands
  // (wiki enrich, health explain --narrate, …) see keys the user already entered
  // in `keryx shell`.
  const env = envWithSavedApiKeys(input.env ?? process.env);

  let provider: string;
  let model: string;
  if (input.provider !== undefined && input.provider.length > 0) {
    provider = input.provider;
    model = input.model ?? defaultModelFor(provider);
  } else {
    const auto = resolveAutoProvider(
      env,
      input.preferSavedShell === false ? { preferSavedShell: false } : undefined,
    );
    provider = auto.provider;
    model = input.model ?? auto.model ?? defaultModelFor(provider);
  }

  const credentialAvailable = hasCredential(provider, env);

  if (!credentialAvailable && input.providerFactory === undefined) {
    return { provider, model, credentialAvailable: false, text: "" };
  }

  const factory = input.providerFactory ?? makeProvider;
  const port = factory(provider, model, {
    fetch: input.fetch ?? globalThis.fetch,
    env,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  });

  const request: NormalizedRequest = {
    providerId: provider,
    modelId: model,
    systemInstruction: input.system,
    messages: [{ role: "user", content: input.user, provenance: "project" }],
    budget: {
      maxOutputTokens: input.maxOutputTokens ?? 1024,
      runReservation: input.maxOutputTokens ?? 1024,
    },
    stream: true,
    requestId: input.requestId ?? "keryx-model-turn",
    parentRunId: input.requestId ?? "keryx-model-turn",
  };

  let text = "";
  let error: NormalizedError | undefined;
  let usage: NormalizedUsage | undefined;
  let reasoning = false;
  const startedAt = performance.now();
  let firstByteAt: number | undefined;
  for await (const event of port.stream(request, {
    attemptId: request.requestId,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  })) {
    if (firstByteAt === undefined) {
      firstByteAt = performance.now();
    }
    if (event.kind === "text_delta" && event.text) {
      text += event.text;
    } else if (event.kind === "provider_error" && event.error) {
      error = event.error;
    } else if (event.kind === "reasoning_delta") {
      reasoning = true;
    } else if (event.kind === "usage_update" && event.usage) {
      usage = event.usage;
    }
  }

  const latencyMs =
    firstByteAt !== undefined ? Math.max(0, Math.round(firstByteAt - startedAt)) : undefined;

  const usageField = usage !== undefined ? { usage } : {};
  const latencyField = latencyMs !== undefined ? { latencyMs } : {};
  const reasoningField = reasoning ? { reasoning } : {};
  return error
    ? { provider, model, credentialAvailable, text, error, ...usageField, ...latencyField, ...reasoningField }
    : { provider, model, credentialAvailable, text, ...usageField, ...latencyField, ...reasoningField };
}
