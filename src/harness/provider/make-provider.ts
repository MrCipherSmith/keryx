// Shared provider-selection factory (review-polish item B, flow 028).
//
// De-duplicates the `new AnthropicProvider|OllamaProvider|FakeProvider`
// construction switch previously copy-pasted across `src/commands/shell.ts`
// (`realMakeProvider`) and `src/commands/harness.ts` — INCLUDING the
// anthropic-without-`ANTHROPIC_API_KEY` fallback to an offline no-op
// `FakeProvider` (never a network attempt without a credential). Behavior is
// identical to both prior call sites.
//
// Pure construction: `makeProvider` only CONSTRUCTS a provider — it never calls
// `opts.fetch` (no network merely by selecting a provider). Deterministic and
// offline aside from the credential read from `opts.env ?? process.env`.
//
// Flow 183 T5: the compat-registry branch (OpenRouter/DeepSeek/Z.AI/Cerebras/
// Groq/Moonshot/Grok/…) now constructs the extracted `OpenAiCompatEngine`
// engine directly instead of the (now-thin-wrapper) `OllamaProvider`. Its
// `describe()`/`descriptorDocument()` identity is pinned to `providerId:
// "ollama"` / Ollama's `providerRevision` — UNCHANGED from before this
// extraction (existing `make-provider.test.ts` assertions pin
// `describe().descriptor.providerId === "ollama"` for these registry
// entries; giving each its own real provider id is a separate, out-of-scope
// naming fix, not part of this pure-extraction task).
import { providerByName, resolveProviderBaseUrl } from "../../commands/providers";
import { AnthropicProvider } from "./anthropic/anthropic-provider";
import { OpenAiCompatEngine } from "./compat/openai-compat-provider";
import { FakeProvider } from "./fake-provider";
import { GeminiProvider } from "./gemini/gemini-provider";
import { OllamaProvider } from "./ollama/ollama-provider";
import { OpenAiProvider } from "./openai/openai-provider";
import type { ProviderPort } from "./types";

/** Mirrors `OllamaProvider`'s internal identity (unchanged since the flow 183 extraction). */
const OLLAMA_COMPAT_IDENTITY = {
  defaultBaseUrl: "http://localhost:11434",
  providerRevision: "ollama-2024-10-22",
  providerId: "ollama",
  providerLabel: "Ollama",
  defaultModel: { modelId: "llama3.1:latest", revision: "latest" },
} as const;

/** Injected construction inputs (fetch is passed through to the network providers). */
export interface MakeProviderOpts {
  fetch: typeof fetch;
  /** Credential/config source; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Scoped credential map for a subagent/child construction (flow 090 / AC4).
   * When provided it is used for key lookup INSTEAD of `env`/`process.env`, so a
   * child sees only the credentials its policy grants and cannot probe ambient
   * `process.env` for the presence of keys it was never granted (Critic Q8). Only
   * the keys present here are visible; everything else fails closed to
   * `FakeProvider`.
   */
  credentials?: Record<string, string | undefined>;
  /** Ollama loopback base url (forwarded to `OllamaProvider` when present). */
  baseUrl?: string;
}

/**
 * Construct the {@link ProviderPort} for `name`:
 *   - `"anthropic"` + a non-empty `ANTHROPIC_API_KEY` -> `AnthropicProvider`.
 *   - `"anthropic"` + no/empty key -> the offline `FakeProvider` (fail-closed:
 *     never constructs `AnthropicProvider`, never touches the network).
 *   - `"openai"` + a non-empty `OPENAI_API_KEY` -> `OpenAiProvider` (native
 *     Responses API adapter, flow 183 T6) — same fail-closed shape as
 *     `"anthropic"`: no/empty key -> `FakeProvider`, never constructed
 *     without a credential.
 *   - `"gemini"` + a non-empty `GEMINI_API_KEY` (falling back to
 *     `GOOGLE_API_KEY` when absent/empty) -> `GeminiProvider` (native
 *     generateContent/streamGenerateContent adapter, flow 183 T7) — same
 *     fail-closed shape as `"anthropic"`/`"openai"`.
 *   - `"ollama"` -> `OllamaProvider` (loopback grant, optional `baseUrl`).
 *   - a registered OpenAI-compatible provider (OpenRouter, DeepSeek, Z.AI,
 *     Cerebras, Groq, Moonshot, Grok, Rapid-MLX, …) -> the extracted
 *     `OpenAiCompatEngine` engine directly, constructed with Ollama's
 *     identity (`OLLAMA_COMPAT_IDENTITY`) — unchanged from when this branch
 *     constructed `OllamaProvider` with the same grant.
 *   - `"fake"` or any unrecognized name -> `FakeProvider`.
 *
 * `model` is accepted for forward-compatibility (mirrors both call sites) but
 * does not vary construction today.
 */
export function makeProvider(name: string, _model: string, opts: MakeProviderOpts): ProviderPort {
  // A scoped credential map (child path) takes precedence over ambient env, so a
  // child construction never reads `process.env` for keys it was not granted.
  const env = opts.credentials ?? opts.env ?? process.env;
  if (name === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      return new FakeProvider([]);
    }
    return new AnthropicProvider({ fetch: opts.fetch, grant: { network: true, apiKey } });
  }
  if (name === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      return new FakeProvider([]);
    }
    return new OpenAiProvider({ fetch: opts.fetch, grant: { network: true, apiKey } });
  }
  if (name === "gemini") {
    // GEMINI_API_KEY preferred; GOOGLE_API_KEY as fallback when the former is
    // absent/empty (both are documented; GEMINI_API_KEY is primary per
    // specification.md §2's naming note). Never constructs GeminiProvider
    // without a credential (same fail-closed shape as anthropic/openai above).
    const apiKey =
      env.GEMINI_API_KEY !== undefined && env.GEMINI_API_KEY.length > 0 ? env.GEMINI_API_KEY : env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      return new FakeProvider([]);
    }
    return new GeminiProvider({ fetch: opts.fetch, grant: { network: true, apiKey } });
  }
  if (name === "ollama") {
    return new OllamaProvider({
      fetch: opts.fetch,
      grant: { network: true, allowLoopback: true, ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}) },
    });
  }
  // Any registered OpenAI-compatible provider (OpenRouter, DeepSeek, Z.AI GLM,
  // Cerebras, Groq, Moonshot, …, Rapid-MLX) — reuse the OpenAI-compat adapter
  // with a bearer credential read from its `envKey` when required by the
  // provider definition. Keyless entries (e.g. rapid-mlx) are still accepted.
  const compat = providerByName(name);
  if (compat !== undefined) {
    const needsKey = compat.requiresApiKey !== false;
    const apiKey = compat.apiKey ?? (compat.envKey === undefined ? undefined : env[compat.envKey]);
    if (needsKey && (apiKey === undefined || apiKey.length === 0)) {
      return new FakeProvider([]);
    }
    const grant: {
      network: true;
      baseUrl: string;
      allowLoopback?: true;
      allowPrivateLan?: true;
      chatPath?: string;
      apiKey?: string;
    } = {
      network: true,
      baseUrl: opts.baseUrl ?? resolveProviderBaseUrl(compat, env),
      ...(compat.allowLoopback === true ? { allowLoopback: true } : {}),
      ...(compat.allowPrivateLan === true ? { allowPrivateLan: true } : {}),
      ...(compat.chatPath !== undefined ? { chatPath: compat.chatPath } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
    return new OpenAiCompatEngine({ fetch: opts.fetch, grant }, OLLAMA_COMPAT_IDENTITY);
  }
  return new FakeProvider([]);
}
