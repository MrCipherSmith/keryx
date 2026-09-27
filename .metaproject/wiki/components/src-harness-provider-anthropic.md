---
Title: Module src/harness/provider/anthropic
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/provider/anthropic` groups 5 file(s). Depends on `src/harness/provider`, `src/contracts`, `src/harness/mutation`. Exposes 7 public symbol(s)."
---
```markdown
---
Title: Module src/harness/provider/anthropic
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/harness/provider/anthropic` groups 5 file(s). Depends on `src/harness/provider`, `src/contracts`, `src/harness/mutation`. Exposes 7 public symbol(s)."
---

# Module src/harness/provider/anthropic

## Overview

This module owns the Anthropic-specific provider integration within the harness provider layer. It packages the implementation, model metadata, capability information, and streaming-event handling needed for the harness to interact with Anthropic as one of its available providers.

The module bridges shared provider contracts and harness mutation concepts with Anthropic-facing provider behavior. By sitting alongside other provider modules such as `src/harness/provider/compat`, `src/harness/provider/gemini`, and `src/harness/provider/openai`, it participates in a provider abstraction rather than acting as a direct application entry point.

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

The module is organized around a provider implementation and supporting abstractions:

- **`AnthropicProvider`** is the central class exposed by the module. It implements or participates in the harness provider interface.
- **`AnthropicProviderDeps`** represents the dependencies required to construct or configure the provider.
- **`AnthropicModelDescriptor`** and **`AnthropicProviderDescriptorDocument`** describe model and provider metadata used by the harness layer.
- **`AnthropicCapabilityGrant`** represents capability or permission information associated with provider behavior.
- **`AnthropicSSEParser`** and **`AnthropicSSEEvent`** handle Server-Sent Event data, converting raw streaming transport content into structured events.

Internally, `anthropic-provider.ts` connects provider behavior with the harness provider base layer, contracts, and mutation-related types. The `sse.ts` file focuses specifically on parsing SSE payloads and exposing structured event types.

## Key concepts

- **Provider integration** — Adapts Anthropic-specific provider behavior to the shared harness provider abstraction.
- **Provider descriptor** — Model and provider metadata are represented through descriptor interfaces, enabling the harness to reason about configuration without depending on implementation details.
- **Capability grant** — Provider behavior may be constrained or expanded by capability information via `AnthropicCapabilityGrant`.
- **Dependency container** — `AnthropicProviderDeps` captures what the provider needs from its environment or other harness modules.
- **Streaming events** — `AnthropicSSEEvent` and `AnthropicSSEParser` process streamed provider responses into structured data.

## Main flows

### Provider construction and metadata exposure

The harness constructs `AnthropicProvider` using `AnthropicProviderDeps`. The provider then exposes Anthropic-specific capabilities and configuration to the broader provider layer through model descriptor and provider descriptor types.

### Provider execution through the harness

When a request is routed through the harness provider layer, the Anthropic provider participates in provider selection and execution. It works with shared contracts and harness mutation concepts to keep Anthropic-specific behavior compatible with the common provider model.

### Streaming response parsing

For streaming interactions, raw Server-Sent Event content is parsed by `AnthropicSSEParser`. The parser emits `AnthropicSSEEvent` values, allowing the provider to process individual streamed events rather than handling raw transport text directly.

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

- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
```
