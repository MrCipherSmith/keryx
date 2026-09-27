---
Title: Module src/capability
Version: 1.1.1
Type: component
Status: accepted
VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:3aa22fbd42a057cbe5c7b058c4ea8e69231f1a10ff78179859c242daa2137847
Summary: "`src/capability` groups 10 file(s). Depends on `src/lib`, `src/commands`, `src/assets`. Exposes 10 public symbol(s)."
---

# Module src/capability

## Summary

`src/capability` groups 10 file(s). Depends on `src/lib`, `src/commands`, `src/assets`. Exposes 10 public symbol(s).

## Overview

`src/capability` is the project-wide opt-in capability seam. It provides a uniform substrate that lets every keryx block (A–E) wire optional, dependency- or asset-backed features into the CLI without coupling that logic to command code or breaking deterministic fallback paths. The module owns:

- The four-gate resolution pipeline (`resolveCapability`)
- The process-scoped degradation warning mechanism
- The `metaproject.json` manifest read/write side for capability entries
- The descriptor registry that `init`/`update` commands consume
- The **external-agents** capability — the first concrete descriptor built on the seam, covering config parsing and CLI/CI transport detection for external agent integrations

The module deliberately imports only shared libs, command entry points, and the asset resolver, keeping itself acyclic and free of any optional dependency at the top level.

## How it works

The module is structured in layers, from dependency-free primitives up to the command-facing wiring.

### Innermost layer: `warn-once.ts`

A dependency-free, process-scoped `Set` that ensures each degradation warning is emitted to stderr exactly once per CLI invocation. This prevents log spam when multiple call sites trigger the same unavailable capability.

### Core layer: `seam.ts`

Defines the public interfaces (`CapabilitySpec`, `CapabilityAdapter`, `CapabilityLoadContext`) and implements `resolveCapability` — a strict four-gate pipeline:

1. **Gate 1** – The capability must be listed as `{ enabled: true }` in `metaproject.json`.
2. **Gate 2** – Any declared `optionalDependency` must be lazily importable via `await import()`.
3. **Gate 3** – Any declared asset must resolve and pass SHA-256 verification through the asset resolver.
4. **Gate 4** – The built adapter's `isAvailable()` must return true.

Every gate failure maps to `null`. If the capability was enabled, a warn-once degradation notice is emitted. `runCapabilityOrFallback` wraps the call-site pattern so even a throwing `run()` degrades gracefully.

`golden-rule.test.ts` is the invariant suite for this layer: it pins down the gate ordering, the "no imports/no warnings on a disabled capability" guarantee, and the fallback behavior of `runCapabilityOrFallback` so that future descriptors cannot silently weaken the seam's contract.

### Concrete capability: `external-agents.ts`

The module's first real, user-facing capability, built entirely on the `seam.ts` contract:

- `EXTERNAL_AGENTS_CAPABILITY_ID` and `EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR` register it with the descriptor registry.
- `ExternalAgentConfig` / `ExternalAgentsConfig`, together with `DEFAULT_AGENT_CONFIG` and `EXTERNAL_AGENTS_DEFAULTS`, define the shape and defaults for per-agent configuration.
- `parseExternalAgentsConfig`, `loadExternalAgentsConfig`, and `agentConfig` load and normalize that configuration from the module config file, deep-merging over the defaults.
- `ExternalTransport`, `detectTransport`, `ENV_KERYX_TRANSPORT`, `LOCAL_TRANSPORT_MARKERS`, and `CI_ENV_VARS` determine, at runtime, whether the current process is running locally or inside CI/an external-agent transport, so the adapter can pick the right integration path.

This file demonstrates the intended pattern for future block A–E capabilities: a self-contained descriptor + config + environment-detection module that plugs into `seam.ts` and `registry.ts` without touching command code.

### Outer layer: `wiring.ts` and `registry.ts`

Handle the write side:

- **`wiring.ts`** provides pure functions for parsing `--<flag>` / `--no-<flag>` CLI args, deep-merging config defaults, and upserting enriched capability entries into a manifest object.
- **`registry.ts`** connects these to the `init` and `update` command entry points and maintains `CAPABILITY_REGISTRY`, which now includes the `external-agents` descriptor alongside space for future entries.

With `external-agents` registered, `init` and `update` are no longer pure no-ops: they actively provision and reconcile that capability's manifest entry and config, while the full substrate remains ready for blocks A–E to register further descriptors and gain the same uniform CLI wiring automatically.

## Key concepts

- **Floor vs. ceiling** – A capability entry in `metaproject.json` is a "floor" when it appears as a bare string (advertised but not opt-in) or a "ceiling" when it is an object with `{ enabled: true/false }`. `resolveCapability` only activates a ceiling; floors are never resolved. Ceilings default to off.

- **CapabilityDescriptor** – The static registration record that a block provides: an `id` (namespaced `module.feature`), a CLI `flag` stem, the owning `module` key, an optional `optionalDependency` module specifier, an optional `asset` id, and an optional `config` path with defaults. Descriptors live in `registry.ts`; `EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR` is the current concrete example.

- **CapabilitySpec** – The runtime counterpart to `CapabilityDescriptor`. It carries the `load` factory function that constructs a `CapabilityAdapter` from a resolved context. A spec is passed directly to `resolveCapability` at a command call site.

- **CapabilityAdapter** – The interface a resolved capability exposes: `id`, `isAvailable()`, and `run(input)`. Returned by `resolveCapability` only after all four gates pass; `null` otherwise.

- **CapabilityLoadContext** – The bundle passed to `spec.load()`: the lazily-imported optional-dependency module (or `undefined`) and the resolved+verified asset path (or `null`). Insulates adapters from the resolution mechanics.

- **warn-once** – A process-scoped deduplication guard ensuring that a degradation warning for a given capability id reaches stderr at most once per CLI process, preventing log spam when multiple modules hit the same unavailable capability.

- **Transport detection** – `detectTransport` classifies the current execution context (local shell, CI, or an external-agent transport) using `ENV_KERYX_TRANSPORT`, `LOCAL_TRANSPORT_MARKERS`, and the known `CI_ENV_VARS`. The `external-agents` capability uses this to select correct behavior without hard dependencies on any specific CI system.

## Main flows

### 1. Runtime capability resolution (seam.ts → warn-once.ts → assets)

A command calls `resolveCapability(cwd, spec)` in `seam.ts`:

- **Gate 1** reads `metaproject.json` via `isCapabilityEnabled` and returns `null` immediately if the entry is absent or `enabled: false` — no imports, no warnings.
- **Gate 2** lazily runs `await import(spec.optionalDependency)` inside a try/catch; failure calls `warnCapabilityDegraded` in `warn-once.ts` and returns `null`.
- **Gate 3** loads the assets lock, builds a registry, and calls `resolveAsset`; a missing or checksum-failing asset also triggers `warnCapabilityDegraded`.
- **Gate 4** runs `adapter.isAvailable()`, catching throws.

Only when all four gates pass is the adapter returned to the caller, which then calls `runCapabilityOrFallback` to execute `adapter.run()` with a deterministic fallback for any throw. `golden-rule.test.ts` exercises each gate transition to guard against regressions.

### 2. Capability opt-in at `keryx init` (registry.ts → wiring.ts)

The `init` command passes raw CLI args to `registerCapabilitiesFromArgs` in `registry.ts`. That function calls `parseCapabilitySelections` in `wiring.ts`, which walks the `CAPABILITY_REGISTRY` (including `external-agents`) and emits a `CapabilitySelection` for each descriptor whose `--<flag>` or `--no-<flag>` appears in args (`--no-` wins ties). `applyCapabilitySelections` then calls `reconcileManifestCapability` for each selection, upserting the enriched manifest entry into the owning module's `capabilities[]` array in `metaproject.json`. If the descriptor carries a `config` path — as `external-agents` does — `renderCapabilityConfig` writes the module config file (deep-merged over `EXTERNAL_AGENTS_DEFAULTS` or another descriptor's defaults). The manifest is rewritten atomically only when something changed.

### 3. Capability reconciliation at `keryx update` (registry.ts → wiring.ts)

`reconcileCapabilitiesOnUpdate` walks the registry, reads the current enabled state of each descriptor from the manifest (preserving operator intent via `capabilityCurrentlyEnabled`), and calls `reconcileManifestCapability` to ensure every registered capability has an up-to-date enriched entry. If a descriptor declares a `config` path and the file does not yet exist on disk, `loadCapabilityConfig` materialises it by deep-merging the defaults with any existing on-disk content — for `external-agents` this means `loadExternalAgentsConfig` producing a normalized `ExternalAgentsConfig` on first run.

Because `external-agents` is now part of the shipped registry, `init` and `update` actively provision and maintain its manifest entry and config; other, still-unregistered block A–E capabilities remain no-ops until they are added to `CAPABILITY_REGISTRY`.

---

<!-- keryx:reference:begin v=1 hash=8e635475d486a0eaffc75e8a0270ab6ddbff94b6a45dd748897d34ba9549ecab -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `CapabilityAdapter` (interface)
- `CapabilityLoadContext` (interface)
- `CapabilitySpec` (interface)
- `isCapabilityEnabled` (function)
- `resolveCapability` (function)
- `runCapabilityOrFallback` (function)
- `EXTERNAL_AGENTS_CAPABILITY_ID`
- `EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR`
- `ExternalAgentConfig` (interface)
- `ExternalAgentsConfig` (interface)
- `DEFAULT_AGENT_CONFIG`
- `EXTERNAL_AGENTS_DEFAULTS`
- `parseExternalAgentsConfig` (function)
- `loadExternalAgentsConfig` (function)
- `agentConfig` (function)
- `ExternalTransport`
- `ENV_KERYX_TRANSPORT`
- `LOCAL_TRANSPORT_MARKERS`
- `detectTransport` (function)
- `CI_ENV_VARS`

### Key files

- `src/capability/seam.ts` - imported by 15, imports 5
- `src/capability/external-agents.ts` - imported by 11, imports 4
- `src/capability/warn-once.ts` - imported by 14, imports 0
- `src/capability/registry.ts` - imported by 5, imports 4
- `src/capability/golden-rule.test.ts` - imported by 0, imports 7
- `src/capability/wiring.ts` - imported by 3, imports 2

### Depends on

- `src/lib` - 9 import(s)
- `src/assets` - 2 import(s)

### Depended on by

- `src/commands` - 4 import(s)
- `src/gdgraph/treesitter` - 2 import(s)
- `src/bus` - 1 import(s)
- `src/gdgraph` - 1 import(s)
- `src/harness/external` - 1 import(s)
- `src/harness` - 1 import(s)

### Dependency basis

- Production imports only: 19 import(s) from test file(s) (e.g. `src/capability/golden-rule.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 14
- Cross-module imports: 11
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/assets](src-assets.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/memory/embedding](src-memory-embedding.md)
- [Module src/memory](src-memory.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/security/detect/injection](src-security-detect-injection.md)

## Changelog

- 1.1.1 - Reference refreshed from the code graph (4e80355f).
- 1.1.0 - Prose expanded to cover `external-agents.ts` (the first concrete capability) and `golden-rule.test.ts` (seam invariant tests); flows updated to reflect a non-empty registry.
- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 1.0.0 - Prose sections enriched by gdwiki agent; Status set to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
