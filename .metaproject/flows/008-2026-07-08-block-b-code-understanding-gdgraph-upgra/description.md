# Implement Block B: Code Understanding (gdgraph upgrades) — B2/B3 pure early wins + B1 opt-in tree-sitter

Status: formalized
Source: docs/requirements/roadmap-2026/B-code-understanding/ (PRD/spec/AC1..AC5/tasks are the authoritative source)

## Problem

`gdgraph` is a file-level regex/scan import graph. Block B lifts it to a symbol-level
code-understanding layer WITHOUT ever losing the deterministic, zero-dependency floor.
Three work items: **B2** transitive N-hop `affected` (pure), **B3** ranked token-budgeted
`repomap.md` via personalized PageRank (pure), and **B1** an opt-in `web-tree-sitter`
(WASM) symbol graph (function/class/method nodes + CALL/import edges) behind the Block 0
Capability Seam, with the regex fallback staying the byte-identical deterministic default.

## Expected Outcome (Block B spec §§, tasks T-B1..T-B15)

- **B0 pure early wins (no dep):** `createGdgraphService()` facade (`src/gdgraph/service.ts`);
  `DEFAULT_GDGRAPH_CONFIG` + deep-merge loader (`config.ts`, malformed→defaults); transitive
  `affected` (`affected.ts`): N-hop BFS/DFS closure over reverse-dependents with `--depth`,
  `--ranked` (hop/fanIn), `--json`; **`--depth 1` / no-flag stdout byte-identical to today**;
  personalized PageRank (`pagerank.ts`, fixed damping/iterations/tolerance, total-order tie-break,
  edge weights import/CALL/defines); token-budgeted `repomap.md` renderer (`repomap.ts`,
  `chars/4` estimator, stable "… N omitted …" marker) + `gdgraph repomap [--budget] [--seed|--changed]`
  CLI + `"repomap"` in manifest commands.
- **B1 opt-in tree-sitter (needs Block 0 seam+assets):** additive `SymbolNode`/`CallEdge`/`SymbolLayer`
  in `types.ts`; `loadGraph` loads `symbols.jsonl`/`calls.jsonl` if present (missing⇒empty, never error);
  `web-tree-sitter` under `optionalDependencies` + grammar assets in `assets.lock.json` resolved via
  Block 0 `resolveAsset`; `src/gdgraph/treesitter/{grammars,adapter,extract}.ts` — a `gdgraph.treesitter`
  CapabilityAdapter (dep-import + grammar-resolve; never throws out); `build.ts` calls
  `resolveCapability("gdgraph.treesitter")` AFTER the unchanged file-level build → null ⇒ file-level only
  (byte-identical), else writes `symbols.jsonl`/`calls.jsonl` additively; `init --treesitter/--no-treesitter`
  + `capabilities` manifest entry + `gdgraph.config.json` `treesitter` block; warn-once + exit 0 when
  enabled-but-unavailable.
- **Fixtures:** `fixtures/transitive-closure/` (depth-1..k + cycle), `fixtures/repomap/` (centrality + budget),
  `fixtures/symbol-graph/` (hand-labeled expected symbols/calls) — all plug into the Block 0 harness.
- **Golden rule (B-1/C0-7/F-3):** with NO `web-tree-sitter` and no grammars, `gdgraph build` produces
  **byte-identical** `storage/nodes.jsonl`, `storage/edges.jsonl`, `artifacts/module-map.json`,
  `artifacts/summary.md` to today; symbol layer is additive files that only exist when the capability is
  active. `web-tree-sitter` imported ONLY via `await import()` in `treesitter/adapter.ts`; no top-level import.
  A no-network sandbox run of build/affected/repomap opens no socket. The pre-existing suite is unchanged.

## Out of Scope

- Any embedding/vector retrieval in repomap (NG-B2 — PageRank is pure deterministic).
- Cross-file type resolution beyond CALL/import edges; a semantic type-checker.
- Bundling/auto-downloading grammar WASM assets (they are XP3 assets via `assets pull`).
