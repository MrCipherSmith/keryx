---
Title: Module src/harness/provider/openai
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/provider/openai` groups 2 file(s). Depends on `src/harness/provider`, `src/harness/mutation`, `src/harness/provider/anthropic`. Exposes 5 public symbol(s)."
---
# Module src/harness/provider/openai

## Summary

`src/harness/provider/openai` is the native OpenAI provider adapter. It is a thin `fetch` and SSE client for the OpenAI Responses API that implements the harness `ProviderPort` and normalizes streamed output into `NormalizedEvent`s. Egress requires an explicit network capability grant, and no vendor SDK is imported.

## Overview

The `src/harness/provider/openai` module owns everything that talks to OpenAI on the harness side: building the request, sending it, classifying failures and turning the streamed reply into the neutral event sequence. It targets the Responses API (`POST /v1/responses`, `stream: true`), not the older Chat Completions shape. The adapter is deliberately thin: `fetch` is injected, the global is never touched, and nothing is persisted (storage-off).

## How it works

`OpenAiProvider` is constructed from an `OpenAiProviderDeps` bag. The mandatory `fetch` is injected, which keeps the adapter deterministic and testable offline. The class exposes three public methods. `describe()` returns the capability matrix, with streaming, tool calls, reasoning metadata and prompt caching advertised and vision, token counting and model listing declared `false`. `descriptorDocument()` returns a descriptor with storage, retention and continuation pinned to `false`. `stream()` performs one guarded attempt and yields normalized events.

Inside `stream()`, the work is split across module-private helpers. `toResponsesInput` serializes the normalized conversation into the flat Responses `input` array, pairing tool calls and outputs by `call_id` and degrading unpaired results to plain messages. `ownedReasoningItems` returns only the reasoning items this adapter itself produced. `classifyHttpError` maps non-2xx statuses into the neutral error taxonomy. The SSE body is read incrementally: `AnthropicSSEParser` (reused from `src/harness/provider/anthropic/sse`) frames the records, and `raceReadAgainstDeadline` races each read against a first-byte or idle timer.

Two wire branches share this code. The native branch posts to `<baseUrl>/v1/responses` (default `https://api.openai.com`) with the API key as a bearer token and sends `max_output_tokens`. The Codex branch, selected when `deps.codex` is set, posts to `https://chatgpt.com/backend-api/codex/responses` with account and session headers and `store: false`. It omits `max_output_tokens`, which the comments record that endpoint rejects. Reasoning is opt-in: `reasoning` is sent only for an effort other than `off`, `xhigh` and `max` are clamped to `high`, and `temperature` is dropped whenever reasoning is requested, because the API rejects that combination. The egress check reuses `isPrivateEgressHost` from `src/harness/mutation/guard`, and the tool-call pairing reuses `linkToolCalls` from `src/harness/provider/tool-call-linking`.

## Key concepts

- **`OpenAiProvider`**  
  The `ProviderPort` implementation. It stamps every yielded event with a per-attempt `sequence` and the `attemptId`, and it scrubs the API key from any message that leaves the module.

- **`OpenAiProviderDeps`**  
  The injected dependencies: a mandatory `fetch`, an optional `grant`, an optional `codex: { accountId }` that switches to the subscription transport, an injectable `clock` for retry-after dates, and the `firstByteTimeoutMs` and `idleTimeoutMs` deadlines (120 s each by default).

- **`OpenAiCapabilityGrant`**  
  The explicit network authorization: `network: true`, an `apiKey` and an optional `baseUrl`. Without a valid grant, `stream()` yields an `authentication` error and never calls `fetch`.

- **`OpenAiModelDescriptor`**  
  A `modelId` and `revision` pair. `descriptorDocument()` advertises `gpt-4.1` on the native branch and `gpt-5.4` on the Codex branch.

- **`OpenAiProviderDescriptorDocument`**  
  The durable descriptor: `schemaVersion`, `providerId`, `providerRevision`, models, capabilities and a `remoteState` block pinned to `false`. The file comment says it is meant to validate against a frozen descriptor schema; that validation is not performed in this module.

- **Reasoning replay item**  
  A `ProviderReplayItem` with `kind: "reasoning_item"`, stamped with the adapter's own `providerId`. It carries the raw reasoning output item so a later round can resend it. Items stamped by another provider are skipped.

## Main flows

1. **Guarded attempt.** `stream()` fails closed in order. A missing grant or empty `apiKey` yields an `authentication` error. A host that `isPrivateEgressHost` flags (loopback, private, link-local or metadata) yields `invalid_request`. Both happen before `fetch`. The header wait has its own deadline, and the caller's abort signal is forwarded to it: a header timeout yields a retryable `unavailable`, and an abort yields `cancelled`.

2. **Error responses.** A non-2xx response is parsed as JSON when possible and classified. 401 becomes `authentication`, 429 `rate_limit`, and 400 becomes `context_overflow` when the code is `context_length_exceeded`, otherwise `invalid_request`. A 5xx becomes `unavailable`. A 403 whose message is the exact overload text becomes a retryable `overloaded`. `withRetryAfter` applies the retry hint, and the message is credential-redacted before it is yielded.

3. **Streaming normalization.** Each complete SSE record is parsed as JSON and switched on its `type`. `response.output_text.delta` becomes `text_delta`, and `response.reasoning_summary_text.delta` becomes `reasoning_delta`. A function-call item becomes `tool_call_start`, `tool_call_delta` and `tool_call_end`, keyed on `call_id` rather than the item's own `id`. `response.completed` yields `usage_update` (with `cacheReadTokens` from `cached_tokens` and reasoning tokens under `openai.reasoning_tokens`) and then `model_end`. The terminal `error`, `response.failed` and `response.incomplete` events each produce a single `provider_error`. A stream that ends without `response.completed` is `malformed` and gets no `model_end`.

4. **Reasoning round trip.** On `response.output_item.done` for a reasoning item, the adapter emits a single redacted `reasoning_delta` only when no visible summary text arrived and encrypted content exists, then emits `reasoning_replay`. On the next turn, `toResponsesInput` places the owned reasoning items before that turn's message and `function_call` items, so reasoning survives a tool-call round trip.

## Reference

### Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `OpenAiCapabilityGrant` | interface | Authorized capability or grant for OpenAI provider usage |
| `OpenAiProviderDeps` | interface | Dependencies required by the OpenAI provider layer |
| `OpenAiModelDescriptor` | interface | OpenAI model metadata or provider information |
| `OpenAiProviderDescriptorDocument` | interface | Document-style provider configuration description |
| `OpenAiProvider` | class | Concrete OpenAI provider implementation |

### Key Files

| File | Imports In | Imports From |
|------|-----------|--------------|
| `src/harness/provider/openai/openai-provider.ts` | 3 | 5 |
| `src/harness/provider/openai/openai-provider.test.ts` | 0 | 2 |

### Dependency Graph

**Depends on:**
- `src/harness/provider` — 4 imports (generic provider contracts)
- `src/harness/mutation` — 1 import (mutation abstractions)
- `src/harness/provider/anthropic` — 1 import (shared modeling conventions)

**Depended on by:**
- `src/harness/provider` — 2 imports

### Statistics
- Source files: 2
- Cross-module imports: 6

## Related Pages

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/provider/anthropic](src-harness-provider-anthropic.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Initial draft generated by `keryx wiki collect` (2026-09-16)
