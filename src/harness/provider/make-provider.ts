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
import { providerByName } from "../../commands/providers";
import { AnthropicProvider } from "./anthropic/anthropic-provider";
import { FakeProvider } from "./fake-provider";
import { OllamaProvider } from "./ollama/ollama-provider";
import type { ProviderPort } from "./types";

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
 *   - `"ollama"` -> `OllamaProvider` (loopback grant, optional `baseUrl`).
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
  if (name === "ollama") {
    return new OllamaProvider({
      fetch: opts.fetch,
      grant: { network: true, allowLoopback: true, ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}) },
    });
  }
  // Any registered OpenAI-compatible provider (OpenRouter, DeepSeek, Z.AI GLM,
  // Cerebras, Groq, Moonshot, …) — reuse the OpenAI-compat adapter with a bearer
  // credential read from its `envKey`. Fail-closed without a key (never fetches).
  const compat = providerByName(name);
  if (compat !== undefined) {
    const apiKey = env[compat.envKey];
    if (apiKey === undefined || apiKey.length === 0) {
      return new FakeProvider([]);
    }
    return new OllamaProvider({
      fetch: opts.fetch,
      grant: {
        network: true,
        baseUrl: opts.baseUrl ?? compat.baseUrl,
        apiKey,
        ...(compat.chatPath !== undefined ? { chatPath: compat.chatPath } : {}),
      },
    });
  }
  return new FakeProvider([]);
}
