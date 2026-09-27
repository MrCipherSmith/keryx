---
Title: Module src/harness/provider/openai
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/provider/openai` groups 2 file(s). Depends on `src/harness/provider`, `src/harness/mutation`, `src/harness/provider/anthropic`. Exposes 5 public symbol(s)."
---
# Module src/harness/provider/openai

## Summary

Provides the OpenAI-specific provider layer within the harness system. This module exposes interfaces for describing OpenAI providers, their models, capabilities, and dependency requirements, enabling the broader harness to work with OpenAI provider metadata while maintaining separation from OpenAI-specific implementation details.

## Overview

The `src/harness/provider/openai` module encapsulates OpenAI provider concerns behind a clean public interface. It provides abstractions that allow the harness to describe, configure, and reason about OpenAI-backed providers using shared provider and mutation concepts from dependent modules.

The module is intentionally narrow in scope—focusing on provider modeling rather than actual API calls—making it a bridge between OpenAI-specific configuration and the generic provider abstraction used throughout the harness.

## How it Works

The module comprises two files:

| File | Purpose |
|------|---------|
| `openai-provider.ts` | Defines the public provider interfaces and `OpenAiProvider` class |
| `openai-provider.test.ts` | Validates the module's public contract and exported symbols |

**Dependency relationships:**
- Imports from `src/harness/provider` for generic provider contracts and types
- Imports from `src/harness/mutation` for mutation-related abstractions
- Imports from `src/harness/provider/anthropic` for shared provider modeling conventions

The module exports 5 public symbols that collectively define OpenAI provider configuration, model metadata, capability authorization, and runtime provider behavior.

## Key Concepts

- **`OpenAiProvider`**  
  The concrete class representing an OpenAI-backed provider within the harness. Implements the provider contract and exposes OpenAI-specific runtime behavior.

- **`OpenAiProviderDeps`**  
  Interface describing runtime and configuration dependencies required by the OpenAI provider layer (e.g., API credentials, endpoint configuration).

- **`OpenAiModelDescriptor`**  
  Interface for OpenAI model metadata—captures model identifiers, capabilities, context limits, and other model-level provider information.

- **`OpenAiProviderDescriptorDocument`**  
  Represents a document-style description of an OpenAI provider's configuration, capability surface, or service definition.

- **`OpenAiCapabilityGrant`**  
  Interface representing an authorized capability or permission grant related to OpenAI provider usage (e.g., rate limits, feature access).

## Integration Flows

### Provider Integration Flow

1. The parent `src/harness/provider` module imports from this module to obtain OpenAI-specific provider abstractions.
2. OpenAI provider instances are instantiated with their declared dependencies (`OpenAiProviderDeps`).
3. The provider is registered with the shared provider layer, allowing harness components to interact with OpenAI resources through the generic provider interface.

### Descriptor and Metadata Flow

1. Model descriptors (`OpenAiModelDescriptor`) are created to enumerate available OpenAI models.
2. Capability grants (`OpenAiCapabilityGrant`) define authorized operations and limits.
3. Provider descriptor documents (`OpenAiProviderDescriptorDocument`) aggregate this information into a portable, introspectable format.
4. External systems or harness tooling consume these descriptors to reason about provider capabilities without direct OpenAI API dependencies.

### Validation Flow

1. The test file (`openai-provider.test.ts`) exercises the public API surface.
2. Tests validate contract behavior for exported interfaces and the `OpenAiProvider` class.
3. Integration with imported provider and mutation abstractions is verified.

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

- 0.1.0 — Initial draft generated by `keryx wiki collect` (2026-09-16)
