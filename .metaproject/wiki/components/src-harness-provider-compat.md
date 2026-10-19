---
Title: Module src/harness/provider/compat
Version: 1.0.0
Type: component
Status: accepted
Summary: OpenAI-compatible provider engine for the harness. `OpenAiCompatEngine` implements the provider port over a streaming Chat Completions endpoint, behind an explicit network grant and an egress guard, and depends on `src/harness/provider`, `src/security`, and `src/harness/mutation`.
---
# Module src/harness/provider/compat

## Summary

`src/harness/provider/compat` is the generic OpenAI Chat Completions engine behind the harness provider port. `OpenAiCompatEngine` POSTs a streamed chat request, normalizes the SSE response into `NormalizedEvent`s, and classifies failures into the neutral error taxonomy. Gateways differ only by identity, so `src/harness/provider/ollama` and the other OpenAI-compatible gateways are built from this same engine with their own defaults.

## Overview

This module owns the OpenAI-compatible wire adapter for the harness. It is a thin `fetch` and SSE adapter: every network call goes through the injected `OpenAiCompatProviderDeps.fetch`, and the global `fetch` is never touched. The only per-gateway variation is `OpenAiCompatIdentity` (provider id, revision, default base URL and model). `OllamaProvider` is a wrapper that builds this engine with Ollama's loopback defaults, which is why the engine is kept free of vendor details.

Rather than copy lower-level code, the module reuses shared harness pieces: SSE framing from `src/harness/provider/anthropic`, the egress predicates from `src/harness/mutation`, secret redaction from `src/security`, and the retry and transport helpers from `src/harness/provider`.

## How it works

The engine is one class, `OpenAiCompatEngine`, in `openai-compat-provider.ts`, with two pure helpers beside it. `stream()` runs in three layers:

- **Gate and request build.** `stream()` first checks the capability grant. Without `network: true` it yields an `invalid_request` error and never calls `fetch`. It then resolves the target host against the egress rule: private, loopback, link-local and metadata hosts are denied unless the grant opts in. `allowLoopback` re-permits loopback only, and `allowPrivateLan` re-permits RFC1918 and CGNAT hosts only. Metadata and link-local addresses stay denied under both flags. The body is built from `NormalizedRequest`: tool-call pairs are linked by `linkToolCalls`, reasoning replay is attached per `grant.reasoning.replay`, and `grant.reasoning.requestParams` is merged last.
- **Transport and errors.** One `fetch` runs per attempt. A non-2xx response is read once and classified by `classifyHttpError`: 401 and 403 become `authentication`, 429 `rate_limit`, a 400 with `context_length_exceeded` `context_overflow`, and 5xx `unavailable`; other 4xx are `invalid_request`. The server's reason is read from several JSON error shapes, redacted and capped at 300 characters. `gatewayOperatorHint` appends a remedy for free-tier and no-credit refusals.
- **Stream normalization.** The success body is read incrementally. Each SSE record from `AnthropicSSEParser` becomes `model_start`, `text_delta`, `reasoning_delta`, tool-call start and end, `usage_update` or `model_end` events. Two deadlines guard the read: `firstByteTimeoutMs` before the first chunk and `idleTimeoutMs` between chunks, both defaulting to 120 seconds. An abort yields one terminal `cancelled` error. An in-band `error` envelope inside the stream is classified the same way as an HTTP error.

### Public API

| Symbol | Type | Purpose |
|--------|------|---------|
| `OpenAiCompatEngine` | class | Exported entry point for OpenAI-compatible provider operations |
| `OpenAiCompatCapabilityGrant` | interface | Represents the permission or capability boundary for provider actions |
| `OpenAiCompatProviderDeps` | interface | Defines collaborators and configuration required by the engine |
| `OpenAiCompatIdentity` | interface | Provider identity information for context qualification |
| `OpenAiCompatModelDescriptor` | interface | Metadata describing an individual model |
| `OpenAiCompatProviderDescriptorDocument` | interface | Metadata describing the provider as a whole |

## Dependencies

### Required dependencies

- `src/harness/provider` — Core harness provider abstractions
- `src/security` — Security contracts used by capability grants
- `src/harness/mutation` — Mutation-aware behavior integrated into provider operations

### Inherited patterns

- `src/harness/provider/anthropic` — Provides descriptor and capability patterns reused by this module

## Consumers

This module is imported by:

- `src/harness/provider` (2 imports) — Primary consumer using engine and descriptor contracts
- `src/harness/provider/ollama` (1 import) — Reuses OpenAI-compatible contracts for Ollama integration

## Key concepts

- **Identity** (`OpenAiCompatIdentity`): the provider id, revision, default base URL and default model that distinguish one gateway from another. `providerLabel` only affects error wording.
- **Capability grant** (`OpenAiCompatCapabilityGrant`): the explicit network permission. It carries `baseUrl`, `apiKey` (sent as a bearer token), `headers`, `chatPath`, `streamUsage` (asks for `stream_options.include_usage`) and the loopback and private-LAN opt-ins.
- **Reasoning format**: `grant.reasoning.format` decides where reasoning arrives. `field` (the default) reads `reasoning` or `reasoning_content`; `inline-tags` routes `delta.content` through `ThinkTagParser`; `split` leaves content unchanged and expects reasoning out of band. `requestParams` can add payload keys but never overrides `model`, `messages`, `stream` or `tools`.
- **Replay**: `grant.reasoning.replay` (`deepseek`, `minimax` or `none`) selects what a round stores and echoes back on later requests. Replay items are stamped with the `openai-compat` provider id, so items written by other adapters are ignored.
- **Descriptor document**: `descriptorDocument()` pins storage, retention and continuation to `false`, so nothing is persisted.

## Main flows

### 1. A streamed request

A consumer builds an `OpenAiCompatEngine` from `OpenAiCompatProviderDeps` and an `OpenAiCompatIdentity`, then calls `stream(request, opts)`. The engine runs the gate, egress check, payload build and `fetch` described under How it works. A successful stream ends with `model_end` on the `[DONE]` sentinel. If `opts.timeoutMs` is set, it is combined with `opts.signal` so either one aborts the in-flight request.

### 2. Inline reasoning in `delta.content`

When the grant sets `format: "inline-tags"`, each `delta.content` string is pushed into `ThinkTagParser.push()`, which returns ordered `reasoning` and `text` segments. A tag split across chunks is held back until the next push completes or disproves it. Leading newlines are trimmed after `<think>` and after `</think>`. `flush()` runs only on a normal end, so an abort discards held text.

### 3. Literal tags inside a reasoning field

For `field` and `split` formats, reasoning text passes through `FieldThinkTagStripper`, which removes stray `<think>` and `</think>` tags along with the newline next to them. In `split` mode a second stripper filters `delta.content`. Replay accumulation receives the raw, unstripped text, so replayed reasoning stays byte-exact.

---

<!-- keryx:reference:begin v=1 hash=1307c6160ad0d924d1a5e65fdd051f88b6838df7ca73c613644f5bfa8f37dd17 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `OpenAiCompatCapabilityGrant`
- `OpenAiCompatProviderDeps`
- `OpenAiCompatModelDescriptor`
- `OpenAiCompatProviderDescriptorDocument`
- `OpenAiCompatIdentity`
- `gatewayOperatorHint`
- `OpenAiCompatEngine`
- `ThinkTagSegmentKind`
- `ThinkTagSegment`
- `partialTagSuffixLength`
- `ThinkTagParser`

### Key files

- `src/harness/provider/compat/openai-compat-provider.ts` - imported by 10, imports 8
- `src/harness/provider/compat/think-tag-parser.ts` - imported by 3, imports 0
- `src/harness/provider/compat/think-tag-stripper.ts` - imported by 2, imports 1
- `src/harness/provider/compat/openai-compat-provider.privatelan.test.ts` - imported by 0, imports 2
- `src/harness/provider/compat/openai-compat-provider.test.ts` - imported by 0, imports 2
- `src/harness/provider/compat/openai-compat-provider.timeout.test.ts` - imported by 0, imports 2

### Depends on

- `src/harness/provider` - 3 import(s)
- `src/security` - 1 import(s)
- `src/harness/mutation` - 1 import(s)
- `src/harness/provider/anthropic` - 1 import(s)

### Depended on by

- `src/harness/provider` - 1 import(s)
- `src/harness/provider/ollama` - 1 import(s)

### Dependency basis

- Production imports only: 8 import(s) from test file(s) (e.g. `src/harness/provider/compat/openai-compat-provider.privatelan.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 11
- Cross-module imports: 6
<!-- keryx:reference:end -->

## Related

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/security](src-security.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/provider/anthropic](src-harness-provider-anthropic.md)
- [Module src/harness/provider/ollama](src-harness-provider-ollama.md)

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/security](src-security.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/provider/anthropic](src-harness-provider-anthropic.md)
- [Module src/harness/provider/ollama](src-harness-provider-ollama.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched for gdwiki workflow.
