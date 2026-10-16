---
Title: Module src/gdgraph
Version: 1.0.3
Type: component
Status: accepted
Summary: The code-graph engine for keryx. Collects source files, resolves imports into a dependency graph, persists it as JSONL, and answers navigation queries such as affected files, orphans, and cycles. Optionally enriches the graph with tree-sitter symbol and call edges.
---
# Module src/gdgraph

VerifiedAt: 1675e43360b9d786d2916a9518ebe46bb3b7747c
VerifiedScope: sha256:d90e2218ba8f37d82ac41c5bcc31615c19feebb084dcce6d7cddf7c291cf8afe

## Summary

`src/gdgraph` builds and queries keryx’s code graph. Its pipeline collects source files, resolves imports, writes persistent graph data, and answers navigation queries. When the tree-sitter capability is available, an optional second pass adds symbols and call edges.

The module provides a transport-independent service facade used by `src/commands` and `src/mcp`.

## Overview

The module’s responsibilities fall into three core layers and an optional enrichment layer:

- **Configuration:** Loads user settings and merges them with defaults.
- **Build:** Walks source files, resolves imports, and writes graph artifacts.
- **Query:** Reads persisted graph data and answers structural questions.
- **Enrichment:** Adds tree-sitter-based symbols and call edges when the capability is available.

## How it works

### Configuration

`config.ts` loads `.metaproject/gdgraph.config.json` and merges it field by field over `DEFAULT_GDGRAPH_CONFIG`. Missing or malformed settings fall back individually, so they do not make configuration loading fatal.

Configuration controls the default affected-query depth, repomap token budget and PageRank parameters, and tree-sitter grammar set and grammar path.

### Build

`build.ts` builds the file-level graph by:

1. Recursively walking source files with `.ts`, `.tsx`, `.js`, and `.jsx` extensions.
2. Skipping generated and dependency directories.
3. Extracting import specifiers with Bun’s `scanImports`, or a regex fallback in non-Bun environments.
4. Resolving imports with `TsconfigResolver`, which honors `tsconfig.json` `paths` and `baseUrl` aliases.
5. Classifying edges as:
   - `imports` for resolved source-to-source imports
   - `asset` for resolved source-to-asset imports
   - `unresolved` for relative or alias imports that cannot be found on disk
6. Writing the graph and related artifacts:
   - `storage/nodes.jsonl`
   - `storage/edges.jsonl`
   - `artifacts/summary.md`
   - `artifacts/module-map.json`

After the file-level build, `build.ts` dynamically imports `enrich.ts` and calls `enrichBuildWithSymbols`. If the tree-sitter capability is available, the enrichment pass writes `storage/symbols.jsonl` and `storage/calls.jsonl`. If it is unavailable, the four primary build artifacts remain unchanged.

### Queries and service facade

`query.ts` and `service.ts` provide graph loading and query operations. `loadGraph` reads the JSONL data defensively; if the optional symbols or calls files are missing, it returns an empty optional layer.

The query operations include:

- **Affected files:** Finds direct dependencies and dependents of a target file.
- **Orphans:** Finds file nodes with no inbound or outbound resolved edges.
- **Cycles:** Finds cycles over import edges and deduplicates them by canonical form.

`createGdgraphService` combines configuration loading, graph loading, and graph operations behind a transport-independent facade.

## Key concepts

| Concept | Description |
|---------|-------------|
| **GraphNode** | A project-relative path representing a source file (`kind: "file"`) or a non-source import target (`kind: "asset"`). |
| **GraphEdge** | A directed edge between nodes, classified as `imports`, `asset`, or `unresolved`. Queries use resolved edges. |
| **GraphData** | The in-memory graph, containing nodes and edges, with optional symbol and call arrays from enrichment. |
| **SymbolNode** | A named declaration in a file, supplied by tree-sitter enrichment. |
| **CallEdge** | A call relationship between symbols, supplied by tree-sitter enrichment. |
| **GdgraphConfig** | Typed configuration for affected-query depth, repomap settings, and tree-sitter settings. |
| **TsconfigResolver** | Resolves import aliases to project-relative paths using `tsconfig.json` `paths` and `baseUrl`. |
| **Capability seam** | The integration point with `src/capability` for resolving a tree-sitter adapter at runtime. Enrichment is skipped when unavailable. |
| **GdgraphService** | A transport-independent facade for graph operations, including build, query, affected-file, repomap, and graph-loading operations. |

## Main flows

### Build a graph

```text
CLI: keryx gdgraph build
  → GdgraphService.build(cwd)
    → buildGraph(cwd)
      - Walk source files
      - Extract imports with Bun's transpiler or the regex fallback
      - Resolve imports with TsconfigResolver
      - Write nodes.jsonl, edges.jsonl, summary.md, and module-map.json
    → enrichBuildWithSymbols (when tree-sitter is available)
      - Write symbols.jsonl and calls.jsonl
```

### Query affected files

```text
CLI: keryx gdgraph affected <file>
  → GdgraphService.affected(cwd, target)
    → Load config to get the default depth
    → Load the persisted graph
    → Compute affected files for the target and depth
```

### Find cycles or orphans

```text
CLI: keryx gdgraph query cycles|orphans
  → GdgraphService.query(cwd, "cycles"|"orphans")
    → Load the persisted graph
    → Run getCycles or getOrphans
```

Cycle detection uses depth-first search over import edges and deduplicates cycles by their lexicographically smallest rotation. Orphan detection considers file nodes and resolved edges, returning files with no inbound or outbound connections.

---

<!-- keryx:reference:begin v=1 hash=d9ac0ee6f040eb18ff50b097cd8d2b0a35842c7ba73714961c0618d735bb7cbc -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `GraphNode`
- `TranspilerImportKind`
- `UNKNOWN_IMPORT_KIND`
- `TYPE_ONLY_IMPORT_KIND`
- `ImportKind`
- `GraphEdge`
- `GraphData`
- `SymbolKind`
- `SymbolNode`
- `CallEdge`
- `SymbolLayer`
- `DescribesOrigin`
- `WikiPageNode`
- `DescribesEdge`
- `WikiLayer`
- `FileFingerprint`
- `loadGraph` (function)
- `getPagesDescribing` (function)
- `getFilesDescribedBy` (function)
- `getOrphans` (function)

### Key files

- `src/gdgraph/types.ts` - imported by 63, imports 0
- `src/gdgraph/query.ts` - imported by 26, imports 3
- `src/gdgraph/build.ts` - imported by 16, imports 4
- `src/gdgraph/service.ts` - imported by 7, imports 8
- `src/gdgraph/repomap.ts` - imported by 9, imports 5
- `src/gdgraph/staleness.ts` - imported by 12, imports 2

### Depends on

- `src/lib` - 5 import(s)
- `src/wiki` - 4 import(s)
- `src/gdgraph/treesitter` - 2 import(s)
- `src/forgetting` - 1 import(s)
- `src/capability` - 1 import(s)
- `src/ctx` - 1 import(s)

### Depended on by

- `src/commands` - 18 import(s)
- `src/wiki` - 14 import(s)
- `src/harness/tool` - 9 import(s)
- `src/review` - 7 import(s)
- `src/wiki/freshness` - 7 import(s)
- `src/forgetting` - 5 import(s)

### Dependency basis

- Production imports only: 47 import(s) from test file(s) (e.g. `src/commands/gdgraph-freshness.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 44
- Cross-module imports: 15
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived — regenerated by `keryx wiki collect --force`. Only pages that exist are linked.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/capability](src-capability.md)
- [Module src/gdgraph/treesitter](src-gdgraph-treesitter.md)
- [Module src/commands](src-commands.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- 1.0.3 - Reference refreshed from the code graph (1675e433).
- 1.0.2 - Reference refreshed from the code graph (4e80355f).
- **1.0.1** — Reference refreshed from the code graph (5886c474)
- **1.0.0** — Prose sections enriched by gdwiki enrich workflow
- **0.1.0** — Generated by `keryx wiki collect`
