---
Title: Module src/harness/provider/anthropic
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/provider/anthropic` groups 5 file(s). Depends on `src/harness/provider`, `src/contracts`, `src/harness/mutation`. Exposes 7 public symbol(s)."
---
```markdown
---
Title: Module src/harness/provider/anthropic
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/provider/anthropic` groups 5 file(s). Depends on `src/harness/provider`, `src/contracts`, `src/harness/mutation`. Exposes 7 public symbol(s)."
---

# Module src/harness/provider/anthropic

## Overview

This module is the Anthropic implementation of the harness `ProviderPort`, the first real provider adapter in the harness provider layer. It is a thin adapter over the Anthropic Messages API (`POST /v1/messages` with `stream: true`). It uses the injected `fetch` and no Anthropic SDK, and it turns the API's wire events into the harness's neutral normalized events and errors.

It is gated, not open. Egress requires an explicit network capability grant (`AnthropicCapabilityGrant`, carrying an `apiKey`), and the module fails closed without one. Requests to private, loopback, link-local or metadata hosts are denied before any fetch, reusing the mutation guard's `isPrivateEgressHost`. The adapter is storage-off: its descriptor pins `remoteState` storage, retention and continuation to `false`, and it persists nothing. It sits beside the `compat`, `gemini` and `openai` provider modules within the same provider abstraction.

## Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `AnthropicProvider` | class | Central provider implementation for Anthropic |
| `AnthropicProviderDeps` | interface | Dependencies required to construct or configure the provider |
| `AnthropicModelDescriptor` | interface | Model metadata descriptor |
| `AnthropicProviderDescriptorDocument` | interface | Provider metadata descriptor |
| `AnthropicCapabilityGrant` | interface | Capability or permission information |
| `AnthropicSSEEvent` | interface | Structured Server-Sent Event type |
| `AnthropicSSEParser` | class | Parser for streaming SSE payloads |

## Key files

| File | Purpose | Import count |
|------|---------|--------------|
| `anthropic-provider.ts` | Primary provider implementation | 4 downstream, 5 upstream |
| `sse.ts` | SSE parsing and event types | 5 downstream, 0 upstream |
| `anthropic-provider.test.ts` | Provider behavior tests | 0 downstream, 4 upstream |
| `anthropic-negatives.hardening.test.ts` | Edge case and hardening tests | 0 downstream, 2 upstream |
| `sse.test.ts` | Streaming parser tests | 0 downstream, 1 upstream |

## How it works

The module is organized around one adapter class, a pure SSE parser and a set of request-shaping helpers:

- **`AnthropicProvider`** implements `ProviderPort`. Its `stream()` method is the whole request lifecycle: it checks the grant, runs the egress guard, builds the payload, calls `fetch`, and yields normalized events. `describe()` and `descriptorDocument()` advertise the capabilities (streaming, tools, parallel tool calls, reasoning metadata) and the revision `anthropic-2024-10-22`. The descriptor document lists only one pinned model, `claude-3-5-sonnet-20241022`.
- **`AnthropicProviderDeps`** carries the mandatory `fetch`, the optional `grant`, an injectable `clock`, and separate first-byte and idle stream deadlines, both defaulting to 120s.
- **`AnthropicModelDescriptor`** and **`AnthropicProviderDescriptorDocument`** are the metadata shapes for the model list and the provider descriptor.
- **`AnthropicCapabilityGrant`** is the network and credential authorization that gates egress.
- **`AnthropicSSEParser`** and **`AnthropicSSEEvent`** live in `sse.ts`. The parser is a deterministic, side-effect-free incremental parser: `push(chunk)` accepts text at any chunk boundary and returns each record once its blank-line terminator arrives, while `flush()` surfaces a torn trailing record at EOF so the adapter can report it as malformed.

Helpers in `anthropic-provider.ts` handle request shaping (`buildThinkingParams`, `toAnthropicMessages`, `withCacheBreakpoints`), model-family classification (`anthropicModelFamily`), and error mapping (`classifyHttpError`, `classifySseErrorType`). `mergeUsage` combines token counts for usage updates. The file depends on the provider base layer (`provider-port`, `types`, `tool-call-linking`) and the mutation guard. `sse.ts` has no internal dependencies.

## Key concepts

- **Provider port adaptation** — `AnthropicProvider` implements the harness `ProviderPort` and emits `NormalizedEvent` values: `model_start`, `text_delta`, `tool_call_start` / `tool_call_delta` / `tool_call_end`, `reasoning_delta`, `reasoning_replay`, `usage_update`, `model_end` and `provider_error`.
- **Capability grant** — `AnthropicCapabilityGrant` (`network: true`, `apiKey`, optional `baseUrl`). Without a valid grant, `stream()` yields an `authentication` error and never calls `fetch`. The API key is redacted from any message that leaves the module.
- **Thinking families** — `anthropicModelFamily` sorts model ids into a "budget" family (Claude 2 and 3, and the 4-5 generation), which uses `thinking: { type: "enabled", budget_tokens }`, and an "adaptive" family for everything else, which uses `thinking: { type: "adaptive" }` plus `output_config.effort`. Effort maps to budget tokens through `BUDGET_TOKENS_BY_EFFORT`, and `minimal` is clamped up to `low`.
- **Reasoning replay** — `thinking` blocks accumulate `thinking_delta` and `signature_delta` fragments and are emitted as a single `reasoning_replay`, tagged with `providerId: "anthropic"`, on `content_block_stop`. `redacted_thinking` blocks carry their opaque `data` the same way.
- **Descriptor and storage-off contract** — The descriptor document pins `remoteState` storage, retention and continuation to `false`, which matches the adapter's refusal to persist or continue remote state.
- **Provider descriptor** — `AnthropicProviderDescriptorDocument` and `AnthropicModelDescriptor` describe the provider and its model to the harness without exposing implementation details.

## Main flows

### Provider construction and metadata exposure

The harness constructs `AnthropicProvider` with `AnthropicProviderDeps`, where `fetch` is mandatory and never taken from the global. `describe()` returns the capability set the provider layer appears to use for selection, and `descriptorDocument()` returns the schema-shaped descriptor document. Neither method makes a network call.

### Request and error path

`stream()` checks the grant and then the egress host. Either failure yields a single `provider_error` and returns before `fetch` runs. The payload combines the thinking parameters (from `request.options.reasoning` and the output budget), the cache-breakpointed system prompt and messages, and any tools. It is sent as `POST {baseUrl}/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`. A fetch rejection becomes a retryable `unavailable` error, or `cancelled` if the signal was aborted. A non-2xx response is classified by `classifyHttpError`. Its message comes from the JSON error body when one is present, and `request_id` is kept as `providerRequestId`. The stream then ends with `provider_error` and no `model_end`.

### Streaming response parsing

On success the body is read incrementally from `response.body.getReader()`. Each chunk goes through `AnthropicSSEParser.push`, and the JSON `type` of each completed record drives a switch. `message_start` records input usage and emits `model_start`. `content_block_start`, `content_block_delta` and `content_block_stop` build per-index `BlockState` for tool, text, thinking and redacted-thinking blocks. `message_delta` emits `usage_update`, and `message_stop` emits `model_end`. Two deadlines guard the read: a first-byte deadline until a non-empty chunk arrives, then an idle deadline between chunks. A timeout cancels the reader and yields one retryable `unavailable` error. A record whose data is not valid JSON becomes a `malformed` error.

## Dependencies

### Direct imports

- `src/harness/provider` — 6 imports (provider base layer and contracts)
- `src/contracts` — 1 import (shared contract definitions)
- `src/harness/mutation` — 1 import (mutation-related types or helpers)

### Consumed by

- `src/harness/provider` — 2 imports (core provider layer)
- `src/harness/provider/compat` — 1 import
- `src/harness/provider/gemini` — 1 import
- `src/harness/provider/openai` — 1 import

## Related pages

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/contracts](src-contracts.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/provider/compat](src-harness-provider-compat.md)
- [Module src/harness/provider/gemini](src-harness-provider-gemini.md)
- [Module src/harness/provider/openai](src-harness-provider-openai.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```

<!-- keryx:reference:begin v=1 hash=94a927ee2a628ff4dbfe2b60f3e677e5d44567ddd2f2d4acd816b0b5df9a41f5 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `AnthropicCapabilityGrant`
- `AnthropicProviderDeps`
- `AnthropicModelDescriptor`
- `AnthropicProviderDescriptorDocument`
- `AnthropicModelFamily`
- `anthropicModelFamily`
- `toAnthropicMessages`
- `withCacheBreakpoints`
- `AnthropicProvider`
- `AnthropicSSEEvent`
- `AnthropicSSEParser`

### Key files

- `src/harness/provider/anthropic/anthropic-provider.ts` - imported by 7, imports 5
- `src/harness/provider/anthropic/sse.ts` - imported by 5, imports 0
- `src/harness/provider/anthropic/anthropic-provider.test.ts` - imported by 0, imports 4
- `src/harness/provider/anthropic/anthropic-negatives.hardening.test.ts` - imported by 0, imports 2
- `src/harness/provider/anthropic/anthropic-reasoning.test.ts` - imported by 0, imports 2
- `src/harness/provider/anthropic/anthropic-streaming.test.ts` - imported by 0, imports 2

### Depends on

- `src/harness/provider` - 3 import(s)
- `src/harness/mutation` - 1 import(s)

### Depended on by

- `src/harness/provider/compat` - 1 import(s)
- `src/harness/provider/gemini` - 1 import(s)
- `src/harness/provider` - 1 import(s)
- `src/harness/provider/openai` - 1 import(s)

### Dependency basis

- Production imports only: 8 import(s) from test file(s) (e.g. `src/harness/provider/anthropic/anthropic-negatives.hardening.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 7
- Cross-module imports: 4
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/provider/compat](src-harness-provider-compat.md)
- [Module src/harness/provider/gemini](src-harness-provider-gemini.md)
- [Module src/harness/provider/openai](src-harness-provider-openai.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
