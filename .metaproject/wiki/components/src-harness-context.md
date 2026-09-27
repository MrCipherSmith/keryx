---
Title: Module src/harness/context
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/context` groups 2 file(s). Depends on `src/contracts`. Exposes 12 public symbol(s)."
---
```markdown
---
Title: Module src/harness/context
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/harness/context` groups 2 file(s). Depends on `src/contracts`. Exposes 12 public symbol(s)."
---

# Module src/harness/context

## Summary

`src/harness/context` owns the typed model of a harness context manifest. It defines the public shapes used to describe context sources, their scope, and the limits that apply to them.

The module provides a `buildContextManifest` entry point for assembling inputs into a manifest object. This gives the harness and budget layers a shared, inspectable representation of tracked context material.

It depends on `src/contracts`, positioning it near a stable boundary between harness components and shared application contracts.

## Overview

`src/harness/context` centers on a single implementation file:

- `src/harness/context/manifest.ts`

That file defines:

- Manifest interfaces
- Source-related types
- Context limits
- A builder function

A companion test file (`src/harness/context/manifest.test.ts`) covers this behavior.

Conceptually, the module acts as a declarative definition of context state rather than a runtime subsystem that performs orchestration. Other modules consume it to make decisions about context accounting, sourcing, and constraints.

## Public API

### Constants

- `MAX_CONTEXT_BYTES` — global byte cap for context representation
- `MAX_CONTEXT_TOKENS` — global token cap for context representation

### Interfaces

- `ContextManifest` — primary output; normalized representation of context state
- `ContextManifestSource` — manifest-facing form of a context source
- `ContextManifestScope` — describes what context applies to
- `ContextManifestLimits` — describes capacity boundaries
- `ContextSourceInput` — raw source data provided to the builder
- `BuildContextManifestInput` — full input accepted by the builder
- `BuildContextManifestDeps` — dependency-injected dependencies for the builder

### Supporting Types

- `SourceReliability` — classifies trust or confidence level of source material
- `SourceRedaction` — classifies whether source content is sanitized or restricted

### Functions

- `buildContextManifest` — assembles a `BuildContextManifestInput` into a `ContextManifest`

## Key Concepts

### ContextManifest

The primary output of this module. A normalized representation of context state that includes involved sources and applicable limits. Consumers can inspect this object directly rather than re-deriving context boundaries.

### Input vs. Manifest Representation

The module separates raw input from manifest representation:

| Input Type | Manifest Type | Purpose |
|------------|---------------|---------|
| `ContextSourceInput` | `ContextManifestSource` | Transforms user-provided source data into a standardized form |

The builder performs this transform, returning manifest-shaped objects that are easier for consumers to read and reason about.

### Scope and Limits

Two supporting abstractions constrain how context is interpreted:

- `ContextManifestScope` — describes what context applies to (e.g., function, file, or module level)
- `ContextManifestLimits` — describes capacity boundaries, aligned with exported byte and token caps

### Dependency Injection

`BuildContextManifestDeps` keeps the builder dependency-injected rather than hard-wired to side-effecting services. This design keeps manifest construction testable and portable across environments.

## Main Flows

### Build a Context Manifest

1. A caller from the harness or budget layer invokes `buildContextManifest`.
2. The call supplies a `BuildContextManifestInput`.
3. That input includes source data via `ContextSourceInput` and dependencies via `BuildContextManifestDeps`.
4. The builder produces a `ContextManifest`.
5. Consumers inspect the manifest for sources, scope, and limits.

### Apply Context Limits

1. The builder references `MAX_CONTEXT_BYTES` and `MAX_CONTEXT_TOKENS`.
2. These constants provide shared ceilings for context representation.
3. Downstream modules (especially `src/harness/budget`) use those limits as part of their own accounting logic.

### Consume the Manifest

1. `src/harness/budget` imports from this module and uses its exports.
2. `src/harness` also imports from it as part of the broader harness surface.
3. The manifest serves as a shared contract for how context state is represented across harness subsystems.

## Dependencies

- **Depends on:** `src/contracts` (1 import)

## Dependents

- `src/harness/budget` — 2 imports
- `src/harness` — 1 import

## Related Pages

- [Wiki Index](../index.md)
- [Module src/contracts](src-contracts.md)
- [Module src/harness/budget](src-harness-budget.md)
- [Module src/harness](src-harness.md)
```
