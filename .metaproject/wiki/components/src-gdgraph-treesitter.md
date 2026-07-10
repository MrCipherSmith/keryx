# Module src/gdgraph/treesitter

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/gdgraph/treesitter` groups 7 file(s). Depends on `src/assets`, `src/gdgraph`. Exposes 8 public symbol(s).

## Overview

`src/gdgraph/treesitter` owns the optional symbol-enrichment layer of the code graph: it parses TypeScript and JavaScript source files with `web-tree-sitter`, extracts typed symbol nodes (functions, methods, classes, interfaces), and records call edges between them. The module is deliberately isolated behind a capability seam so the rest of the graph builder remains dependency-free and deterministic even when `web-tree-sitter` is not installed. It is the sole place in `src/` that may load the `web-tree-sitter` runtime, and it absorbs every parse failure gracefully rather than propagating errors outward.

## How it works

The module is split into two distinct layers that never cross-import in the wrong direction. `adapter.ts` is the only file that touches `web-tree-sitter`; it implements the `CapabilityAdapter<BuildInput, SymbolLayer>` contract by loading resolved grammar WASM assets, creating one parser instance per language, and driving the per-file parse loop. Because `web-tree-sitter` ships two incompatible API shapes (0.22 exports a default Parser class; 0.25 exports named `Parser` and `Language`), the adapter normalises both variants at runtime through a version-tolerant `normalizeParserApi` wrapper before use.

`extract.ts` is intentionally dependency-free: it accepts the root syntax node through the minimal `TsNode` interface and performs a pure recursive walk, collecting `SymbolNode` records (functions, arrow functions, methods, classes, interfaces) and raw `CallEdge` candidates. Within a single file the extractor resolves call targets whose callee name matches a symbol defined in the same file; all remaining calls are left as `unresolved-call` edges. After all files are processed the adapter calls `resolveCrossFileCalls`, which does a global name-uniqueness pass and upgrades unambiguous `unresolved-call` edges to proper `calls` edges, deliberately leaving any name that resolves to more than one symbol as unresolved to avoid false graph edges. `defines` edges (file → symbol) are also emitted during per-file extraction so the graph can answer containment queries without a separate pass.

## Key concepts

**SymbolNode** — the core graph vertex produced by this layer. Each node carries a stable `id` of the form `<filePath>#[Container.]<name>` (with an `@<startLine>` suffix added only when the same base id appears more than once in a file), plus kind, path, line range, language, and a rendered signature string.

**CallEdge** — a directed edge between two graph nodes with kind `defines`, `calls`, or `unresolved-call`. `defines` edges link a file path to each symbol it contains; `calls` edges link a symbol to the symbol it calls; `unresolved-call` edges preserve call sites whose target could not be matched to a unique known symbol.

**Grammar assets** — language-specific WASM grammar files (one per language) resolved at runtime by `grammars.ts` through the Asset Resolver. Their presence is the operative gate for `isAvailable()`: the adapter returns `false` and the capability is skipped silently when no grammar resolves successfully.

**Capability seam** — `adapter.ts` registers itself via `createTreesitterSpec`, which returns a `CapabilitySpec` consumed by the graph builder's `resolveCapability` function. This seam means the entire tree-sitter enrichment path is opt-in: the graph builder calls `isAvailable()` first, and if it returns `false`, the symbol layer is simply absent from the output rather than causing an error.

## Main flows

**Parse a file and produce symbols and calls.** The adapter iterates over input files sorted by path. For each file it picks the parser for the matching language, calls `parser.parse(file.content)`, and passes `tree.rootNode` into `extractSymbolLayer`. The extractor walks the syntax tree recursively, tracking the nearest enclosing class or interface as `container` and the nearest enclosing symbol id as `enclosingSymbolId`. On each node it checks whether it is a declaration (function, method, class, interface, or `const`/`let` arrow-function holder) and emits a `SymbolNode`, or whether it is a `call_expression`/`new_expression` and emits a raw `CallEdge`. The extractor then performs same-file call resolution against the file's own symbol name map, emits `defines` edges, deduplicates, sorts, and returns a `SymbolLayer`.

**Cross-file call resolution.** After all per-file `extractSymbolLayer` calls complete, the adapter aggregates every symbol and every call edge across the entire file set. It then calls `resolveCrossFileCalls`, which builds a name-to-id index and a name-occurrence counter over all symbols. Any `unresolved-call` edge whose callee last-segment maps to exactly one symbol id is promoted to a resolved `calls` edge; edges with an ambiguous or unknown callee remain as `unresolved-call`. Self-edges (from === to) are dropped. The resulting call array is sorted and returned as part of the final `SymbolLayer`.

**Capability availability check.** Before the graph builder invokes `run()`, it calls `isAvailable()` on the `TreesitterAdapter`. The adapter attempts to load `web-tree-sitter` (injected as an optional dependency via the capability seam) and then calls `resolveGrammars` to locate WASM grammar files for the configured languages. If the dependency is absent or no grammar resolves, `isAvailable()` returns `false` and the graph builder proceeds without the symbol layer, preserving full determinism for environments that do not have `web-tree-sitter` installed.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `FileRecord` (interface)
- `BuildInput` (interface)
- `TreesitterAdapterConfig` (interface)
- `createTreesitterSpec` (function)
- `vs`
- `TsNode` (interface)
- `extractSymbolLayer` (function)
- `resolveCrossFileCalls` (function)

### Key files

- `src/gdgraph/treesitter/adapter.ts` - imported by 2, imports 2
- `src/gdgraph/treesitter/extract.ts` - imported by 3, imports 0
- `src/gdgraph/treesitter/grammars.ts` - imported by 1, imports 2
- `src/gdgraph/treesitter/adapter.test.ts` - imported by 0, imports 2
- `src/gdgraph/treesitter/extract.test.ts` - imported by 0, imports 1
- `src/gdgraph/treesitter/resolve-calls.test.ts` - imported by 0, imports 1

### Depends on

- `src/assets` - 2 import(s)
- `src/gdgraph` - 1 import(s)

### Depended on by

- `src/gdgraph` - 1 import(s)

### Graph signals

- Files: 7
- Cross-module imports: 3

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/assets](src-assets.md)
- [Module src/gdgraph](src-gdgraph.md)

## Changelog

- 1.0.0 - Prose enriched: Overview, How it works, Key concepts, Main flows written from extract.ts and adapter.ts. Status set to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
