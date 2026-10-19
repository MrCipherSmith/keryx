---
Title: Module src/harness/context
Version: 1.0.1
Type: component
Status: accepted
Summary: "`src/harness/context` groups 2 file(s). Depends on `src/contracts`. Exposes 12 public symbol(s)."
---

# Module src/harness/context

## Summary

`src/harness/context` owns the Release 0 trusted-context manifest: a bounded, deterministic record of which context sources were loaded for a run, how each one is fingerprinted, and whether it may be trusted as policy. Its single builder, `buildContextManifest`, turns caller-supplied source descriptions into a `ContextManifest` object that can be inspected and validated.

## Overview

`src/harness/context` centers on a single implementation file:

- `src/harness/context/manifest.ts`

The module owns the manifest types, the source and scope shapes, the `MAX_CONTEXT_BYTES` and `MAX_CONTEXT_TOKENS` constants, and the `buildContextManifest` builder. Its companion test file (`src/harness/context/manifest.test.ts`) checks the output against the frozen manifest schema through `src/contracts/validator`. It is a declarative record of context state; it does not load files, call the network, or orchestrate anything itself.

## How it works

The builder is a pure function of its inputs plus one injected clock. It runs in a short pipeline inside `buildContextManifest`:

1. **Normalize.** `normalizeSource` coerces each entry of the opaque `sources` array into a `ContextSourceInput`. Anything malformed falls back to safe defaults (`kind` becomes `"unknown"`, `available` becomes `false` unless it is exactly `true`), so bad input cannot silently count as loaded.
2. **Map each source.** `mapSource` produces a `ContextManifestSource`. The two branches are the core trust rule. An available source is fingerprinted with a sha256 of its content, graded `reliability: "exact"`, and marked `trustedAsPolicy: true`. An unavailable source is kept, not dropped. It gets a fingerprint derived from its kind and path, takes the caller's `skipReason` as its summary, and is graded `reliability: "unknown"` with `trustedAsPolicy: false`.
3. **Scope.** Distinct non-empty source paths become `scope.paths`, and `scope.scopeHash` is a sha256 of that list.
4. **Limits.** `actualBytes` sums the UTF-8 byte length of available content. `estimatedTokens` is that byte count divided by four, rounded up. The `maxBytes` and `maxTokens` values are echoed from the caller's `limits` argument. The builder does not compare them against the constants, so enforcing the ceilings is left to callers.
5. **Hash and stamp.** `contextHash` is a sha256 over `projectRoot`, scope, sources and limits, with no timestamp in it. `createdAt` comes from `deps.clock()`. Two builds over identical input and clock output are byte-identical, which makes the manifest suitable for comparison and caching.

The file imports only `node:crypto`. Keeping time behind `deps.clock` and avoiding filesystem access keeps the builder deterministic and easy to test.

## Key concepts

- **ContextManifest** is the output: `schemaVersion`, `contextHash`, `projectRoot`, `createdAt`, `scope`, `sources` and `limits`. Two optional fields, `worktree` and `freshness`, are declared but this builder never sets them.
- **ContextSourceInput** is the raw, caller-facing description of one source. It is either `available` with `content`, or unavailable with a `skipReason`.
- **ContextManifestSource** is the normalized form. Its trust is expressed by the pair `reliability` (`SourceReliability`: `exact`, `estimated`, `unknown`) and `trustedAsPolicy`. Only the `exact` and `unknown` grades are produced here; `estimated` is in the type but never assigned.
- **SourceRedaction** (`not-needed`, `applied`, `failed-safe`) is declared on the source type, but this file never assigns it.
- **ContextManifestScope** names the paths the context covers, plus a `scopeHash`. `base` and `head` are optional and not set by the builder.
- **ContextManifestLimits** pairs the caller's ceilings with the measured `actualBytes` and `estimatedTokens`.
- **Dependency injection.** `BuildContextManifestDeps` supplies only `clock`. The module's constants (`MAX_CONTEXT_BYTES`, 2 MiB, and `MAX_CONTEXT_TOKENS`, 200,000) are documented Release 0 ceilings; they are exported for callers and are not read by the builder.

## Main flows

### Build a manifest from loaded and skipped sources

1. A caller passes a `BuildContextManifestInput` (`projectRoot`, `sources`, `limits`) and a `BuildContextManifestDeps` with a `clock`.
2. `buildContextManifest` normalizes and maps every entry. Loaded sources come out trusted, and skipped optional artifacts come out recorded and untrusted.
3. The builder computes the scope, limits and `contextHash`, then returns the manifest with `createdAt` from the clock.

### Record an unavailable optional artifact

1. A source arrives with `available: false` and a `skipReason`.
2. `mapSource` emits it with `trustedAsPolicy: false`, `reliability: "unknown"`, and the skip reason as `summary`. It still counts in `scope.paths` and the hash, so a skipped artifact is visible in the record rather than missing from it.

### Verify the output against the contract

1. `manifest.test.ts` builds manifests from fixtures and checks them with `validateAgainstSchema` from `src/contracts/validator`. This is the only place the module touches `src/contracts` at runtime. The production file has no such import.
2. Other code in `src/` refers to `ContextManifestSource` and `mapSource` only in comments and tests, such as `src/harness/policy/types.ts` and `src/harness/budget/reconcile.test.ts`. The consumer relationship with `src/harness/budget` is described in the Dependents section below; in the source read for this page it appears to rely on those types rather than on imports from this file.

## Dependencies

- **Depends on:** `src/contracts` (1 import)

## Dependents

- `src/harness/budget` — 2 imports
- `src/harness` — 1 import

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

## Related Pages

- [Wiki Index](../index.md)
- [Module src/contracts](src-contracts.md)
- [Module src/harness/budget](src-harness-budget.md)
- [Module src/harness](src-harness.md)

<!-- keryx:reference:begin v=1 hash=99d82061cab80e466c31935a12c0077c25bbc31e1916cc0bc98c2e9b4105bbc8 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `MAX_CONTEXT_BYTES`
- `MAX_CONTEXT_TOKENS`
- `SourceReliability`
- `SourceRedaction`
- `ContextManifestSource`
- `ContextManifestScope`
- `ContextManifestLimits`
- `ContextManifest`
- `ContextSourceInput`
- `BuildContextManifestInput`
- `BuildContextManifestDeps`
- `buildContextManifest`

### Key files

- `src/harness/context/manifest.ts` - imported by 5, imports 0
- `src/harness/context/manifest.test.ts` - imported by 0, imports 2

### Depended on by

- `src/harness/budget` - 1 import(s)
- `src/harness/hooks` - 1 import(s)
- `src/harness` - 1 import(s)

### Dependency basis

- Production imports only: 2 import(s) from test file(s) (e.g. `src/harness/budget/reconcile.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 2
- Cross-module imports: 0
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/budget](src-harness-budget.md)
- [Module src/harness/hooks](src-harness-hooks.md)
- [Module src/harness](src-harness.md)

## Changelog

- 1.0.1 - Reference and Related Wiki added from the code graph (the page predated them).
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
