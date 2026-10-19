---
Title: Module src/harness/provider/ollama
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/provider/ollama` is the Ollama provider adapter: a thin `OllamaProvider` that pins Ollama's identity (local base URL, provider id, default model) over the shared OpenAI-compatible engine in `src/harness/provider/compat`. Exposes 5 public symbol(s)."
---
# Module src/harness/provider/ollama

## Overview

`src/harness/provider/ollama` makes a local or gateway-hosted Ollama server usable as a harness provider. Its only real code is `ollama-provider.ts`, which defines `OllamaProvider` as a thin wrapper: it supplies Ollama's identity and re-exports the public types that callers import. The wire logic (streaming, SSE parsing, tool-call accumulation, egress guard) lives in the shared `OpenAiCompatEngine` in `src/harness/provider/compat`.

**Dependencies:**
- `src/harness/provider` — provider-layer abstractions (`ProviderPort`, normalized request and event types)
- `src/contracts` — shared harness contracts, including the schema validator used by the descriptor tests
- `src/harness/provider/compat` — the OpenAI-compatible engine that does the actual work

**Consumers:**
- `src/harness/provider` — uses the module for provider discovery and metadata resolution
- `src/harness/mutation` — uses provider-related metadata and capability grants

## How it works

`OllamaProvider` implements `ProviderPort`. Its constructor builds an `OpenAiCompatEngine` with fixed Ollama values: default base URL `http://localhost:11434`, provider revision `ollama-2024-10-22`, provider id `"ollama"`, label `"Ollama"`, and default model `llama3.1:latest`. The three port methods (`describe`, `descriptorDocument`, `stream`) are one-line delegations to that engine.

The file header describes the security posture: egress is denied fail-closed for private, loopback, link-local and metadata hosts unless the destination is loopback and the grant explicitly sets `allowLoopback`. The file says this lives in the extracted engine, so this module does not enforce it itself. `fetch` is always injected through `deps.fetch`, and nothing is persisted.

The supporting types are aliases of the compat types. They describe three things the harness reasons about:

- **Descriptors** (`OllamaModelDescriptor`, `OllamaProviderDescriptorDocument`) describe models and the provider document, which is schema-checked with storage, retention and continuation pinned to `false`.
- **Capability grants** (`OllamaCapabilityGrant`) carry the network opt-in, base URL, `allowLoopback`, an optional `apiKey` and optional extra headers.
- **Dependencies** (`OllamaProviderDeps`) carry the injected `fetch` and the grant.

## Key concepts

- **OllamaProvider** — the `ProviderPort` implementation for Ollama. Holds a private `OpenAiCompatEngine`.
- **OpenAiCompatEngine** (in `src/harness/provider/compat`) — the shared engine that performs the request and normalization. Ollama's behavior is configured entirely through its constructor options.
- **OllamaProviderDeps** — injected `fetch` (mandatory, never the global one) plus the capability `grant`.
- **OllamaCapabilityGrant** — the explicit permission to reach the network. A keyless grant (local Ollama) sends no `Authorization` header. A grant with `apiKey` sends `Authorization: Bearer <key>`, and extra grant headers are forwarded alongside it.
- **Normalized events** — `stream()` yields `model_start`, `text_delta`, `reasoning_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `usage_update` and `model_end`, or ends with a `provider_error`.
- **Error kinds** — failures map onto the harness taxonomy (`invalid_request`, `unavailable`, `malformed`, `cancelled`), each with a retryable flag.

## Main flows

### Streaming a request

1. The caller invokes `OllamaProvider.stream(request, opts)`, which delegates to the engine.
2. The engine sends `POST {baseUrl}/v1/chat/completions` with `stream: true`, the model id, the messages and, when present, the tools and `max_tokens`. The test suite pins this shape.
3. Each SSE chunk is normalized in order. Non-empty `delta.content` becomes `text_delta`, and `delta.reasoning` or `delta.reasoning_content` becomes `reasoning_delta`, which comes before the answer text. Tool-call argument fragments are accumulated by index or id, and `tool_call_end` is emitted once with the full JSON input string.
4. The trailing usage chunk becomes `usage_update`, and the stream closes with `model_end`. Every event carries the caller's `attemptId` and a monotonic `sequence` starting at 0.

### Failure mapping

1. HTTP 404 (model not found) becomes a terminal `provider_error` with kind `invalid_request`, not retryable.
2. HTTP 500 or a thrown fetch (for example connection refused) becomes `unavailable`, retryable. Fetch is attempted once.
3. A torn or malformed SSE body becomes `malformed`, not retryable. Events already emitted are kept, and no `model_end` is sent.
4. An aborted `opts.signal`, including one aborted before the stream starts, becomes `cancelled`, not retryable.

### Message shaping for tool results

Before sending, the engine rewrites the conversation for OpenAI-compatible servers. A tool result that is linked to an assistant tool call is sent as a `role: "tool"` message with `tool_call_id`. An orphaned tool result, such as one whose pair was cut by compaction, is re-framed as a user message prefixed with `Tool result:`. An assistant turn that has no text and an unanswered tool call is dropped. These rules are pinned by the test suite.

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `OllamaCapabilityGrant`
- `OllamaProviderDeps`
- `OllamaModelDescriptor`
- `OllamaProviderDescriptorDocument`
- `OllamaProvider`

### Key files

- `src/harness/provider/ollama/ollama-provider.ts` - imported by 5, imports 2
- `src/harness/provider/ollama/ollama-provider.test.ts` - imported by 0, imports 4

### Depends on

- `src/harness/provider/compat` - 1 import(s)
- `src/harness/provider` - 1 import(s)

### Depended on by

- `src/harness/provider` - 1 import(s)

### Dependency basis

- Production imports only: 6 import(s) from test file(s) (e.g. `src/commands/acp.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 2
- Cross-module imports: 2

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/provider/compat](src-harness-provider-compat.md)
- [Module src/harness/provider](src-harness-provider.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z
