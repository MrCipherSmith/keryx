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

import { makeProvider } from "./make-provider";
import type { NormalizedError, NormalizedRequest, ProviderPort } from "./types";
import { providerByName } from "../../commands/providers";

/** Provider factory matching `makeProvider`'s shape (injectable for tests). */
export type ProviderFactory = (
  name: string,
  model: string,
  opts: { fetch: typeof fetch; env?: Record<string, string | undefined>; baseUrl?: string },
) => ProviderPort;

export const DEFAULT_PROVIDER = "anthropic";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  ollama: "llama3.2",
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
  const compat = providerByName(provider);
  if (compat) {
    const key = env[compat.envKey];
    return key !== undefined && key.length > 0;
  }
  return false;
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
}

export interface ModelTurnResult {
  provider: string;
  model: string;
  credentialAvailable: boolean;
  text: string;
  error?: NormalizedError;
}

/**
 * Run one fail-closed provider turn. Returns assembled text, or
 * `credentialAvailable: false` (empty text, no error) when no credential is
 * present and no factory was injected — the caller decides how to surface that.
 */
export async function runModelTurn(input: ModelTurnInput): Promise<ModelTurnResult> {
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const model = input.model ?? defaultModelFor(provider);
  const env = input.env ?? process.env;
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
  for await (const event of port.stream(request, { attemptId: request.requestId })) {
    if (event.kind === "text_delta" && event.text) {
      text += event.text;
    } else if (event.kind === "provider_error" && event.error) {
      error = event.error;
    }
  }

  return error
    ? { provider, model, credentialAvailable, text, error }
    : { provider, model, credentialAvailable, text };
}
