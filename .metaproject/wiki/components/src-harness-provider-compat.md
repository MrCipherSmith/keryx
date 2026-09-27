---
Title: Module src/harness/provider/compat
Version: 0.1.0
Type: component
Status: draft
Summary: OpenAI-compatible provider support module for the harness. Groups three files, exposes six public symbols, and depends on `src/harness/provider`, `src/security`, and `src/harness/mutation`.
---
# Module src/harness/provider/compat

## Summary

`src/harness/provider/compat` provides an OpenAI-compatible provider abstraction within the harness system. The module groups three files and exposes six public symbols used by consumers in `src/harness/provider` and `src/harness/provider/ollama`.

## Overview

This module owns the compatibility layer that bridges OpenAI-style provider integrations with the harness provider architecture. Its public API defines contracts for:

- The provider engine itself
- Provider dependencies and identity
- Model and provider metadata descriptors
- Capability grants for security boundaries

By expressing these contracts through existing harness abstractions (via `src/security` and `src/harness/mutation`), the module avoids duplicating lower-level concerns. This design allows `src/harness/provider` and `src/harness/provider/ollama` to consume OpenAI-compatible functionality without coupling to OpenAI-specific implementation details.

## Architecture

### Core file

- `openai-compat-provider.ts` — Contains the `OpenAiCompatEngine` class, which is the primary entry point for provider operations.

### Test files

- `openai-compat-provider.test.ts` — Unit tests for provider behavior.
- `openai-compat-provider.privatelan.test.ts` — Scenario-oriented tests.

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

- **OpenAI-compatible provider**: A provider exposed through OpenAI-style contracts while leveraging harness-wide abstractions for security and mutation handling.
- **Provider engine**: The `OpenAiCompatEngine` class coordinates behavior and exposes the module's capabilities.
- **Capability grant**: A security boundary defined via `src/security` that governs allowed provider operations.
- **Descriptor documents**: Metadata contracts that decouple provider details from consumer code.

## Integration patterns

### Provider initialization

1. Consumer imports `OpenAiCompatEngine` and related interfaces from the module.
2. Dependencies are assembled into `OpenAiCompatProviderDeps`.
3. Identity is provided via `OpenAiCompatIdentity`.
4. The engine is instantiated with these inputs.

### Metadata consumption

1. `OpenAiCompatProviderDescriptorDocument` provides provider-level metadata.
2. `OpenAiCompatModelDescriptor` provides per-model metadata.
3. `OpenAiCompatCapabilityGrant` expresses security boundaries for the provider.

This separation allows consumers to inspect, validate, and integrate the provider without binding to implementation specifics.

### Shared compatibility

`src/harness/provider/ollama` reuses this module's contracts to share OpenAI-compatible behavior while maintaining its own provider-specific positioning in the harness.

---

## Reference

### Public API

- `OpenAiCompatCapabilityGrant` (interface)
- `OpenAiCompatProviderDeps` (interface)
- `OpenAiCompatModelDescriptor` (interface)
- `OpenAiCompatProviderDescriptorDocument` (interface)
- `OpenAiCompatIdentity` (interface)
- `OpenAiCompatEngine` (class)

### Key files

- `src/harness/provider/compat/openai-compat-provider.ts` — 5 importers, 6 imports
- `src/harness/provider/compat/openai-compat-provider.privatelan.test.ts` — 0 importers, 2 imports
- `src/harness/provider/compat/openai-compat-provider.test.ts` — 0 importers, 2 imports

### Dependencies

- `src/harness/provider` — 5 import(s)
- `src/security` — 1 import(s)
- `src/harness/mutation` — 1 import(s)
- `src/harness/provider/anthropic` — 1 import(s)

### Dependents

- `src/harness/provider` — 2 import(s)
- `src/harness/provider/ollama` — 1 import(s)

### Graph signals

- Files: 3
- Cross-module imports: 8

## Related

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/security](src-security.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/provider/anthropic](src-harness-provider-anthropic.md)
- [Module src/harness/provider/ollama](src-harness-provider-ollama.md)

## Changelog

- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched for gdwiki workflow.
