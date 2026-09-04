# Module src/gdgraph

Version: 1.0.1
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:64c7fd8efbc21f3e00697ccd7c62c6f1e9b0ff0237d000401b23032f4efc63c1

## Summary

`src/gdgraph` groups 24 file(s). Depends on `src/lib`, `src/capability`, `src/gdgraph/treesitter`. Exposes 10 public symbol(s).

## Overview

`src/gdgraph` is the code-graph engine for keryx. It owns the full pipeline from collecting source files and resolving their imports, through writing a persistent JSONL graph, to answering navigation queries (affected files, orphans, cycles). An optional second pass enriches the file-level graph with a tree-sitter symbol layer (symbols and call edges) when the tree-sitter capability is available. The module is consumed by `src/commands` (CLI) and `src/mcp` (MCP tools) through a transport-independent service facade.

## How it works

The module is organized in three layers that flow from configuration, through build, to query.

**Configuration layer (`config.ts`)** loads `.metaproject/gdgraph.config.json` and deep-merges it over `DEFAULT_GDGRAPH_CONFIG`, field by field. Each numeric or typed field falls back individually so a missing or malformed file is never fatal. The config controls the affected-query default depth, repomap token budget and PageRank parameters, and the tree-sitter grammar set and grammar path.

**Build layer (`build.ts`, `enrich.ts`)** drives graph construction. `buildGraph` recursively walks source files (`.ts`, `.tsx`, `.js`, `.jsx`), skipping a fixed set of generated and dependency directories. For each file it extracts import specifiers — first via the Bun transpiler's `scanImports`, with a regex fallback for non-Bun environments — then resolves each specifier to a project-relative path using a `TsconfigResolver` that honours `tsconfig.json` `paths` and `baseUrl` aliases. Resolved edges get `kind: "imports"`, asset imports get `kind: "asset"`, and relative or alias imports that cannot be resolved on disk become `kind: "unresolved"`. The resulting `GraphNode[]` and `GraphEdge[]` are serialised to `storage/nodes.jsonl` and `storage/edges.jsonl`, and a human-readable summary is written to `artifacts/summary.md` and `artifacts/module-map.json`. After this unchanged file-level step, `build.ts` dynamically imports `enrich.ts` inside a `try/catch`. `enrichBuildWithSymbols` resolves the tree-sitter capability seam (from `src/capability`), and if available runs it to produce `storage/symbols.jsonl` and `storage/calls.jsonl`; if the seam or grammar is absent the four legacy files are left byte-identical.

**Query layer (`query.ts`, `service.ts`)** reads the persisted JSONL graph and answers structural questions. `loadGraph` reads all four JSONL files defensively — a missing symbols or calls file produces an empty optional layer rather than an error. `getOrphans` returns files that appear in neither the inbound nor outbound set of resolved edges. `getAffected` finds the direct dependencies and dependents of a target file. `getCycles` runs a DFS over import edges, deduplicating cycles by canonical form. `createGdgraphService` in `service.ts` composes config loading, graph loading, and the query/build functions into a single transport-independent facade object that both the CLI commands layer and the MCP tools layer depend on.

## Key concepts

- **GraphNode** — a project-relative file path with a `kind` of `"file"` (source) or `"asset"` (imported non-source). Nodes are the vertices of the dependency graph.
- **GraphEdge** — a directed edge between two `GraphNode` paths with a `kind` of `"imports"` (resolved source-to-source), `"asset"` (resolved source-to-asset), or `"unresolved"` (a relative or alias import that could not be matched on disk). Only resolved edges participate in graph queries.
- **GraphData** — the in-memory graph: `{ nodes, edges }` plus optional `symbols` and `calls` arrays added by the enrichment pass.
- **SymbolNode / CallEdge** — the symbol layer produced by the tree-sitter enrichment. `SymbolNode` represents a named declaration within a file; `CallEdge` represents a call relationship between symbols.
- **GdgraphConfig** — the typed configuration object with three sections: `affected` (default query depth), `repomap` (token budget and PageRank parameters), and `treesitter` (grammar set and optional grammar directory path).
- **TsconfigResolver** — an internal abstraction created from `tsconfig.json` `paths` and `baseUrl`. It maps alias specifiers to candidate project-relative paths, enabling alias-aware import resolution without a full TypeScript compiler.
- **Capability seam** — the integration point (`src/capability`) through which the optional tree-sitter adapter is resolved at runtime. When the adapter is unavailable the build degrades deterministically to file-level output.
- **GdgraphService** — the transport-independent facade (from `service.ts`) that wraps build, query, affected, repomap, and loadGraph operations. Both CLI command handlers and MCP tools depend on this interface, keeping transport logic out of the core graph implementation.

## Main flows

**Flow 1 — Graph build (`keryx gdgraph build`)**
A CLI command calls `GdgraphService.build(cwd)` → `buildGraph(cwd)` in `build.ts`. The build walks source files, extracts import specifiers via the Bun transpiler (with regex fallback), resolves each against the `TsconfigResolver`, and classifies edges. Nodes and edges are written to `storage/nodes.jsonl` and `storage/edges.jsonl`; a summary and module-map are written to `artifacts/`. After this, `build.ts` dynamically imports `enrich.ts` and calls `enrichBuildWithSymbols`. If the tree-sitter capability seam resolves successfully, symbol and call edge files are written additively; if not, the four primary artifacts remain unchanged.

**Flow 2 — Affected-file query (`keryx gdgraph affected <file>`)**
A CLI command calls `GdgraphService.affected(cwd, target)`. The service first calls `loadGdgraphConfig(cwd)` (`config.ts`) to determine the default depth, then `loadGraph(cwd)` (`query.ts`) to deserialise the JSONL files from storage into a `GraphData` object. It calls `computeAffected(graph, target, { depth })` (in `affected.ts`, not a key file but called by `service.ts`) which traverses the adjacency structure up to the configured depth and returns the set of dependent files that would be affected by a change to the target.

**Flow 3 — Cycle and orphan detection (`keryx gdgraph query cycles|orphans`)**
A CLI command calls `GdgraphService.query(cwd, "cycles")` or `GdgraphService.query(cwd, "orphans")`. The service loads the graph from JSONL, then dispatches to either `getCycles` or `getOrphans` in `query.ts`. `getCycles` builds an adjacency map over import-kind edges only, runs a depth-first search with a path stack to detect back edges, and deduplicates cycles by choosing the lexicographically smallest rotation. `getOrphans` filters to resolved edges and returns any file node that appears in neither the inbound nor outbound edge sets.

---

<!-- keryx:reference:begin v=1 hash=dc63070325c87284e083376723665541e32d2ac3ce752bae96dcf0f14e7dafc2 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `GraphNode`
- `TranspilerImportKind`
- `UNKNOWN_IMPORT_KIND`
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
- `getAffected` (function)

### Key files

- `src/gdgraph/types.ts` - imported by 38, imports 0
- `src/gdgraph/query.ts` - imported by 17, imports 2
- `src/gdgraph/build.ts` - imported by 10, imports 3
- `src/gdgraph/config.ts` - imported by 9, imports 2
- `src/gdgraph/repomap.ts` - imported by 8, imports 3
- `src/gdgraph/affected.ts` - imported by 7, imports 2

### Depends on

- `src/lib` - 6 import(s)
- `src/wiki` - 4 import(s)
- `src/capability` - 2 import(s)
- `src/gdgraph/treesitter` - 1 import(s)

### Depended on by

- `src/wiki` - 17 import(s)
- `src/commands` - 14 import(s)
- `src/harness/tool` - 9 import(s)
- `src/gdgraph/treesitter` - 7 import(s)
- `src/mcp` - 3 import(s)
- `src/review` - 3 import(s)

### Graph signals

- Files: 33
- Cross-module imports: 13
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/capability](src-capability.md)
- [Module src/gdgraph/treesitter](src-gdgraph-treesitter.md)
- [Module src/commands](src-commands.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 1.0.0 - Prose sections enriched by gdwiki enrich workflow. Overview, How it works, Key concepts, and Main flows written from code reads of config.ts, query.ts, build.ts, enrich.ts, service.ts.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
