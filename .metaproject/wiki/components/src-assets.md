# Module src/assets

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/assets` groups 8 file(s). Depends on `src/lib`. Exposes 13 public symbol(s).

## Overview

`src/assets` owns the entire asset lifecycle for keryx: pinned provenance via a committed lockfile, local resolution with sha256 verification, on-demand network pull, and seeding of well-known grammar entries. It surfaces a single shared subcommand (`assets list | verify | pull`) that any opt-in module mounts on its own CLI surface. The module is designed around a hard separation between local-only reads and the single network path, so the default code path never opens a socket and all behavior is deterministic and fully testable.

## How it works

The module is organized in four distinct layers that enforce a strict no-network-by-default policy. The lockfile layer (`lock.ts`) is the foundation: it reads and normalizes `.metaproject/assets.lock.json`, which is a committed, pinned provenance record holding one entry per asset id with version, URL, sha256, and byte size. `normalizeLock` coerces any malformed input into a safe default (never throws), and `registryFromLock` projects the lock into a runtime `AssetRegistry` that the resolver reads, optionally applying per-id user path overrides (tier T1). Above that sits the resolver layer (`resolver.ts`), which walks three candidate tiers in order — a user-configured local path (T1), the well-known pulled cache (T2), and the user's `~/.cache/keryx/assets` directory (T3) — and verifies the sha256 of every candidate on every load, returning `null` on any mismatch so the caller falls back to its deterministic alternative. The pull layer (`pull.ts`) is the sole network path in the entire codebase: it fetches the pinned URL, verifies the downloaded bytes' sha256 before writing anything to disk, and throws hard on any mismatch — a tampered download is refused and never persisted. The seeding layer (`seed.ts`) handles a specialized bootstrap concern: it merges well-known tree-sitter grammar wasm entries into `assets.lock.json` when `keryx gdgraph symbols enable` is run, doing so in a merge-safe, additive-only way that preserves any existing user-pinned or model-asset entries. The command entry point (`command.ts`) ties these layers together as a pure function of `(cwd, module, args)` returning an exit code plus rendered output lines, making it fully testable without a network.

## Key concepts

- **Asset id**: a `^[a-z0-9-]+$` string that uniquely identifies an asset across the lock, registry, cache, and CLI surface.
- **`assets.lock.json`**: the committed provenance record stored at `.metaproject/assets.lock.json`; every resolvable asset must appear here with its pinned sha256, url, version, and byte size.
- **`AssetLockEntry` / `AssetsLock`**: the on-disk lockfile types — what is committed and shared. `normalizeLock` coerces unknown JSON into this shape safely.
- **`AssetRegistryEntry` / `AssetRegistry`**: the in-memory runtime projection of the lock used by the resolver; adds an optional `path` field for tier T1 user overrides.
- **Resolution tiers (T1/T2/T3)**: the ordered lookup strategy — user config path first, then the pulled cache, then the global user cache — with sha256 verification at every tier. A `null` return means "use your deterministic fallback."
- **`ResolvedAsset`**: the resolver's return type carrying the on-disk path, the verified sha256, and a `verified: true` flag.
- **`AssetFetcher`**: the injectable fetch abstraction in `pull.ts` that decouples the network contract from the verify/write logic, enabling deterministic tests without a real socket.
- **Grammar seed**: the set of pre-pinned tree-sitter wasm entries (`tree-sitter-typescript`, `tree-sitter-tsx`, `tree-sitter-javascript`) that `seedAssetsLock` merges into the lockfile during gdgraph symbol setup.

## Main flows

**`assets list` — enumerate and spot-check all declared assets.** `runAssetsSubcommand` calls `loadAssetsLock` to read and normalize the lockfile, then `registryFromLock` to build the runtime registry. For each asset id in sorted order it calls `resolveAsset`, which walks the T1/T2/T3 candidate paths and verifies the sha256 of any file found; the result is printed as `[resolved]` or `[missing]` and the command returns exit code 0.

**`assets pull <id>` — download, verify, and cache a pinned asset.** `runAssetsSubcommand` delegates to `pullAsset` in `pull.ts` with the full `AssetsLock`. `pullAsset` looks up the entry, calls the (optionally injected) fetcher for the pinned URL, computes the sha256 of the downloaded bytes, and throws if it does not match — refusing to write. On a match it persists the bytes to the asset cache directory (overridable via `KERYX_ASSET_CACHE`) and returns a `ResolvedAsset`. This is the only place in keryx that opens a network socket.

**Grammar seeding during gdgraph setup.** When `keryx gdgraph symbols enable` runs, it calls `seedAssetsLock` with the `.metaproject/` root. `seedAssetsLock` reads and parses the existing lockfile (treating malformed input as empty), then calls `mergeGrammarAssets` to add any missing entries from `GRAMMAR_ASSETS` while preserving all existing entries unchanged. If the merge produces a change, the updated lock is written back atomically. After seeding, the user can run `keryx gdgraph assets pull` to fetch and verify each grammar wasm via the standard pull flow.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `AssetsCommandOptions` (interface)
- `AssetsCommandResult` (interface)
- `runAssetsSubcommand` (function)
- `AssetLockEntry` (interface)
- `AssetsLock` (interface)
- `AssetRegistryEntry` (interface)
- `AssetRegistry` (interface)
- `EMPTY_LOCK`
- `lockPath` (function)
- `normalizeLock` (function)
- `loadAssetsLock` (function)
- `registryFromLock` (function)
- `validateAssetsLock` (function)

### Key files

- `src/assets/command.ts` - imported by 3, imports 3
- `src/assets/lock.ts` - imported by 4, imports 2
- `src/assets/resolver.ts` - imported by 5, imports 1
- `src/assets/seed.ts` - imported by 3, imports 1
- `src/assets/pull.ts` - imported by 2, imports 1
- `src/assets/resolver.test.ts` - imported by 0, imports 3

### Depends on

- `src/lib` - 4 import(s)

### Depended on by

- `src/commands` - 4 import(s)
- `src/capability` - 2 import(s)
- `src/gdgraph/treesitter` - 2 import(s)

### Graph signals

- Files: 8
- Cross-module imports: 4

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/capability](src-capability.md)
- [Module src/gdgraph/treesitter](src-gdgraph-treesitter.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (Overview, How it works, Key concepts, Main flows).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
