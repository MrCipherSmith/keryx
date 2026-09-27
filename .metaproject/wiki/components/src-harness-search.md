---
Title: Module src/harness/search
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/search` groups the harness-side search provider API. It owns the contracts used to register search providers, the controller abstraction that coordinates search behavior, and a default controller factory. The module is consumed by command, TUI, web, and built-in tool modules when they need a shared way to access search functionality."
---

# Module src/harness/search

## Summary

`src/harness/search` groups the harness-side search provider API. It owns the contracts used to register search providers, the controller abstraction that coordinates search behavior, and a default controller factory. The module is consumed by command, TUI, web, and built-in tool modules when they need a shared way to access search functionality.

## Overview

This module provides the integration layer between the app's higher-level surfaces and pluggable search backends. It does not implement UI presentation, command-line argument parsing, or transport details; instead, it defines a narrow public surface for provider registration and controller-based search coordination.

`src/harness/search` depends on shared utilities from `src/lib` and on web-harness contracts from `src/harness/web`. Other modules depend on it when they need to wire search behavior into command flows, terminal UI flows, tool calls, or web-facing features.

## How it works

The module is organized around two main runtime abstractions: a provider registry and a search controller.

- **Provider registry**
  - `createSearchProviderRegistry` creates a registry.
  - `SearchProviderRegistry` represents the registry abstraction.
  - The registry is the place consumers register or look up available search providers.

- **Controller**
  - `SearchProviderController` describes the controller abstraction used to coordinate search requests.
  - `createDefaultSearchProviderController` provides a default controller implementation.
  - The controller sits between consumers and the provider layer, so callers can issue search operations without directly managing provider registration or lookup details.

- **Shared vocabulary**
  - `types.ts` defines shared type-level contracts.
  - Because it has no internal imports, it can be depended on broadly without pulling in runtime modules.

- **Public entry point**
  - `index.ts` re-exports the public API and is the recommended import path for consumers.
  - `connectedProviderIds` is part of that public surface and gives consumers a stable reference to provider identifiers that the module exposes.

- **Tests**
  - `search.test.ts` provides focused coverage for the module's public behavior.

## Key concepts

- **Search provider**: A pluggable component that can perform or participate in search behavior.
- **Provider registry**: A collection abstraction that manages registered search providers and makes them discoverable to consumers.
- **Search controller**: An orchestration object that turns caller intent into provider interaction. It is the primary abstraction used by app code that needs search behavior.
- **Default controller**: The module's ready-made controller implementation, exposed through `createDefaultSearchProviderController`.
- **Connected provider identifiers**: Public identifiers that identify providers treated as connected or available for use.

## Main flows

### Register and resolve providers

1. A consumer creates or receives a `SearchProviderRegistry`.
2. Search providers are registered with the registry.
3. Consumers use `connectedProviderIds` to refer to provider identities that the module makes available.
4. The registry is used to resolve which providers are available for later operations.

### Coordinate a search

1. A consumer obtains a `SearchProviderController`, typically through `createDefaultSearchProviderController`.
2. The consumer invokes search behavior through the controller.
3. The controller resolves the relevant provider or providers and coordinates the operation.
4. The consumer receives the result and presents or processes it.

### Wire default search behavior

1. The module entry point exposes `createDefaultSearchProviderController`.
2. App code calls that factory to get a controller implementation without needing to wire the pieces manually.
3. The resulting controller can then be passed into command handlers, tool implementations, or UI flows that require search support.

## Notes for maintainers

- Keep `index.ts` as the primary consumer-facing surface.
- Put new shared contracts in `types.ts` before moving them into runtime modules.
- If a new provider implementation is added, prefer exposing only the factory and type surface unless the provider needs to be part of the stable API.
- Treat `src/lib` and `src/harness/web` as the current external module dependency surface; avoid widening this module's dependencies without a clear need.

## Reference

### Public API

- `connectedProviderIds`
- `createSearchProviderRegistry`
- `SearchProviderRegistry`
- `SearchProviderController`
- `createDefaultSearchProviderController`

### Key files

| File | Imports | Importers |
|------|---------|-----------|
| `src/harness/search/index.ts` | 4 | 9 |
| `src/harness/search/default-controller.ts` | 5 | 1 |
| `src/harness/search/types.ts` | 0 | 6 |
| `src/harness/search/controller.ts` | 3 | 2 |
| `src/harness/search/registry.ts` | 1 | 3 |
| `src/harness/search/search.test.ts` | 1 | 0 |

### Module dependencies

**Depends on:**
- `src/lib` (2 imports)
- `src/harness/web` (2 imports)

**Depended on by:**
- `src/commands` (5 imports)
- `src/tui` (4 imports)
- `src/harness/tool/builtin` (1 import)
- `src/harness/web` (1 import)

### Entry points

- `src/harness/search/index.ts`

## Related pages

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/web](src-harness-web.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
