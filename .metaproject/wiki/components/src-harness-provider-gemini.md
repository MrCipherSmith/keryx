---
Title: Module src/harness/provider/gemini
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/provider/gemini` groups 3 file(s). Depends on `src/harness/provider`, `src/harness/mutation`, `src/harness/provider/anthropic`. Exposes 6 public symbol(s)."
---

# Module src/harness/provider/gemini

## Summary

`src/harness/provider/gemini` is the Google Gemini adapter for the harness provider layer. Its `GeminiProvider` class implements `ProviderPort` as a thin `fetch` and SSE client over Google's legacy `generateContent` / `streamGenerateContent` REST endpoint, and it exposes the Gemini capability, dependency and descriptor types alongside it.

## Overview

`src/harness/provider/gemini` owns the translation between the harness's neutral provider contract and Google's Gemini API. `GeminiProvider` (in `gemini-provider.ts`) implements `ProviderPort`: `describe()` and `descriptorDocument()` advertise its capabilities and a pinned default model, and `stream()` performs one credential-guarded request and normalizes the server-sent events into `NormalizedEvent`s. The module takes no vendor SDK. It takes an injected `fetch`, requires an explicit network grant (`GeminiCapabilityGrant`) before it sends anything, and advertises that it stores nothing.

The module sits between the generic provider layer and Gemini's wire format. It follows the same template as the Anthropic provider, reuses `AnthropicSSEParser` from `src/harness/provider/anthropic` because Gemini's `alt=sse` framing matches it, and uses `isPrivateEgressHost` from `src/harness/mutation/guard` as its SSRF guard. Shared helpers for tool-call linking, retry-after handling and transport-failure detection come from `src/harness/provider`.

## Public API

| Symbol | Kind | Purpose |
| --- | --- | --- |
| `GeminiCapabilityGrant` | interface | Describes a capability grant associated with Gemini provider usage. |
| `GeminiProviderDeps` | interface | Declares dependencies required to construct or operate `GeminiProvider`. |
| `GeminiModelDescriptor` | interface | Describes a Gemini model at a level visible to the harness. |
| `GeminiProviderDescriptorDocument` | interface | Represents a descriptor document for Gemini provider capabilities or models. |
| `GeminiThoughtSignatureReplayData` | interface | Opaque `thoughtSignature` captured from a response part so the next request can replay it verbatim. |
| `GeminiProvider` | class | Concrete provider implementation for Gemini within the harness provider layer. |

The public API is intentionally narrow. Callers interact with this module through these exported symbols, while implementation details remain internal.

## How it works

### Request shaping

`stream()` posts to `{baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse` with the API key in the `x-goog-api-key` header. `toGeminiContents` converts the normalized messages into Gemini's `contents[]`. Gemini has no system role and no tool role, so the system prompt becomes a top-level `systemInstruction`, a tool result becomes a `role: "user"` part carrying a `functionResponse`, and assistant tool calls become `functionCall` parts on a `role: "model"` turn. Tool calls are serialized only when `linkToolCalls` pairs them with their results. A half-pair degrades to plain text.

Reasoning is configured by `buildThinkingConfig`. When `options.reasoning` requests an effort, `generationConfig.thinkingConfig` gets `includeThoughts: true` and a depth setting chosen by model id. `gemini-3*` models get `thinkingLevel` (low or high, with medium mapped to high). Every other id gets a `thinkingBudget` of 1024, 8192 or 24576 tokens. `clampGeminiEffort` first folds the effort string into low, medium or high. When no effort is requested, `thinkingConfig` is left out entirely.

### Response normalization

The body is read incrementally from `response.body.getReader()`, so events reach the caller as chunks arrive. `AnthropicSSEParser` splits the stream into records, and each record is one complete `GenerateContentResponse` JSON object. Each part maps as follows:

- Text with `thought: true` becomes `reasoning_delta`. Other text becomes `text_delta`.
- A `functionCall` becomes `tool_call_start` followed at once by `tool_call_end` carrying the full arguments. The adapter does not enable incremental argument streaming, so no deltas appear in between. A call without an `id` gets a `name#index` identifier so that repeated calls to the same tool stay distinct.
- A `thoughtSignature` on any part becomes a `reasoning_replay` event holding a `GeminiThoughtSignatureReplayData` item. This happens whether or not reasoning was requested.

Usage counters are folded across chunks into a single `usage_update`. Cached-content and thought token counts go into `unknownExtensions` under `gemini.*` keys. The stream stops at the first chunk that carries a `finishReason`, then emits `model_end`.

### Failure handling

Failures surface as typed `provider_error` events. `classifyGeminiError` maps the HTTP status and the RPC `status` enum onto the neutral error kinds (`authentication`, `rate_limit`, `unavailable`, `invalid_request`, and so on). An in-band `error` envelope inside a 200 stream goes through the same classifier. An abort yields one terminal `cancelled` error. A stream that ends with no `finishReason`, arrives empty, or is torn yields `malformed` with `incompleteStream` set. Every message passes through `redact`, which replaces the API key with `[redacted]`.

Two deadlines, `firstByteTimeoutMs` and `idleTimeoutMs` (120 seconds by default), are each raced against a read via `raceReadAgainstDeadline`. A timeout cancels the reader and yields one retryable `unavailable` error.

## Key concepts

- **Capability grant** (`GeminiCapabilityGrant`): the explicit permission to reach the network. It carries `network: true`, the `apiKey` and an optional `baseUrl`. Without a valid grant, `stream()` fails closed and never calls `fetch`.
- **Provider deps** (`GeminiProviderDeps`): the injected `fetch`, the optional grant, an optional `clock` used for retry-after handling, and the two stream deadlines. The global `fetch` is never used.
- **Descriptor document** (`GeminiProviderDescriptorDocument`): the durable description of the provider. It has a provider revision (`gemini-2026-08-20`), the pinned models, a capability set, and a `remoteState` block with storage, retention and continuation all set to `false`.
- **Model descriptor** (`GeminiModelDescriptor`): a `modelId` and `revision` pair. The one default model is `gemini-2.5-flash`.
- **Thought signature replay** (`GeminiThoughtSignatureReplayData`): an opaque `thoughtSignature` captured from a response part. Its `target` is `functionCall` or `text`, and a function-call index and/or call id point it back at the part it came from, so the next request can reattach it verbatim.
- **Normalized events**: the neutral vocabulary every provider emits, including `text_delta`, `reasoning_delta`, `tool_call_start`, `tool_call_end`, `reasoning_replay`, `usage_update`, `model_end` and `provider_error`.

## Main flows

1. **A turn with tool calls.** The caller passes a `NormalizedRequest`. `toGeminiContents` serializes it, and `stream()` posts it and reads the SSE. Each `functionCall` part becomes a start and end event pair. The caller's tool result returns on the next request as a `functionResponse` part, and any signature captured on the previous response is reattached to its matching `functionCall` part.
2. **A reasoning-enabled turn.** When `options.reasoning` requests an effort, `buildThinkingConfig` adds `thinkingConfig` to the request. Thought parts come back as `reasoning_delta`. The stream stops at `finishReason` and emits `usage_update` followed by `model_end`.
3. **The failure and guard path.** A missing grant, a private or loopback host, a non-2xx response, a stalled stream past its deadline, or an abort each end `stream()` with a single typed `provider_error` or `cancelled` event. The API key is redacted from any message before it leaves the module.

---

<!-- keryx:reference:begin v=1 hash=f0aeaf51322bd8264a7468b1196c971af6291911bee2d7998e46ac34dd81c9bb -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `GeminiCapabilityGrant`
- `GeminiProviderDeps`
- `GeminiModelDescriptor`
- `GeminiProviderDescriptorDocument`
- `GeminiThoughtSignatureReplayData`
- `GeminiProvider`

### Key files

- `src/harness/provider/gemini/gemini-provider.ts` - imported by 4, imports 5
- `src/harness/provider/gemini/gemini-provider.test.ts` - imported by 0, imports 3
- `src/harness/provider/gemini/gemini-streaming.test.ts` - imported by 0, imports 2

### Depends on

- `src/harness/provider` - 3 import(s)
- `src/harness/mutation` - 1 import(s)
- `src/harness/provider/anthropic` - 1 import(s)

### Depended on by

- `src/harness/provider` - 1 import(s)

### Dependency basis

- Production imports only: 4 import(s) from test file(s) (e.g. `src/harness/provider/gemini/gemini-provider.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 3
- Cross-module imports: 5
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/provider/anthropic](src-harness-provider-anthropic.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill. Hand-written data sections reconciled with the Reference block.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
