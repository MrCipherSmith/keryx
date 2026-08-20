// Ollama OpenAI-compatible provider adapter (flow 020, T6 / AC1-AC3).
//
// A THIN WRAPPER (flow 183, T5 / AC3) pinning Ollama's specific identity
// (`DEFAULT_BASE_URL`, `PROVIDER_REVISION`, `DEFAULT_MODEL`, `providerId:
// "ollama"`) over the generic OpenAI-Chat-Completions-compatible engine at
// `../compat/openai-compat-provider.ts`. All wire logic (SSE parsing via
// `AnthropicSSEParser`, the SSRF/egress guard, `linkToolCalls` request-side
// tool-result linking, the tool-call accumulation-by-index/id state machine,
// the whole `stream()` body) lives in {@link OpenAiCompatEngine} — this
// class now ONLY supplies identity + re-exports the public types every
// existing caller (`select.ts`, `make-provider.ts`, `ollama-provider.test.ts`,
// `guard.loopback.test.ts`, …) already imports from this module.
//
// SECURITY (AC2 / flow 183 AC4): egress is DENIED fail-closed for any
// private/loopback/link-local/metadata host UNLESS the destination is
// loopback AND the grant carries the explicit `allowLoopback` opt-in — this
// behavior lives in the extracted engine and is unchanged by this wrapper.
//
// Determinism / offline: unchanged — `fetch` is always injected via
// `deps.fetch`, nothing is ever persisted (storage-off).

import {
  OpenAiCompatEngine,
  type OpenAiCompatCapabilityGrant,
  type OpenAiCompatModelDescriptor,
  type OpenAiCompatProviderDeps,
  type OpenAiCompatProviderDescriptorDocument,
} from "../compat/openai-compat-provider";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription, ProviderPort, StreamOptions } from "../types";

/** Explicit capability grant authorizing this adapter to reach the network. */
export type OllamaCapabilityGrant = OpenAiCompatCapabilityGrant;

/** Injected dependencies. `fetch` is mandatory (never the global); `grant` gates egress. */
export type OllamaProviderDeps = OpenAiCompatProviderDeps;

/** One model advertised by {@link OllamaProvider.descriptorDocument}. */
export type OllamaModelDescriptor = OpenAiCompatModelDescriptor;

/**
 * The durable, schema-validating descriptor document for the Ollama provider.
 * Validates against the frozen `provider-descriptor.schema.json` with
 * storage/retention/continuation pinned to `false` (storage-off contract).
 */
export type OllamaProviderDescriptorDocument = OpenAiCompatProviderDescriptorDocument;

/** Default local Ollama base URL used when the grant supplies none. */
const DEFAULT_BASE_URL = "http://localhost:11434";
/** Stable provider revision advertised by `describe()` / `descriptorDocument()`. */
const PROVIDER_REVISION = "ollama-2024-10-22";
/** The single model this adapter fixture pins. */
const DEFAULT_MODEL: OllamaModelDescriptor = {
  modelId: "llama3.1:latest",
  revision: "latest",
};

/**
 * Thin Ollama OpenAI-compatible {@link ProviderPort}. Constructed with an
 * injected `fetch` and an optional explicit capability `grant`; delegates all
 * streaming/normalization logic to the extracted {@link OpenAiCompatEngine}
 * engine, pinned to Ollama's identity (loopback default base URL, `"ollama"`
 * provider id).
 */
export class OllamaProvider implements ProviderPort {
  private readonly engine: OpenAiCompatEngine;

  constructor(deps: OllamaProviderDeps) {
    this.engine = new OpenAiCompatEngine(deps, {
      defaultBaseUrl: DEFAULT_BASE_URL,
      providerRevision: PROVIDER_REVISION,
      providerId: "ollama",
      providerLabel: "Ollama",
      defaultModel: DEFAULT_MODEL,
    });
  }

  describe(): ProviderDescription {
    return this.engine.describe();
  }

  descriptorDocument(): OllamaProviderDescriptorDocument {
    return this.engine.descriptorDocument();
  }

  stream(request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    return this.engine.stream(request, opts);
  }
}
