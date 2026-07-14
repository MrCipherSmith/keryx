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
import { AnthropicProvider } from "./anthropic/anthropic-provider";
import { FakeProvider } from "./fake-provider";
import { OllamaProvider } from "./ollama/ollama-provider";
import type { ProviderPort } from "./types";

/** Injected construction inputs (fetch is passed through to the network providers). */
export interface MakeProviderOpts {
  fetch: typeof fetch;
  /** Credential/config source; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
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
  const env = opts.env ?? process.env;
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
  return new FakeProvider([]);
}
