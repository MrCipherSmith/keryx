# Implementation Plan

Status: ready

## Approach

Two phases, per architecture §7. **Phase B-0 (pure early wins, no dep):** a `createGdgraphService()`
facade + config loader, then the transitive `affected` closure and the PageRank `repomap` — both
pure algorithms over the in-memory graph, shipping before any grammar-asset work. **Phase B-1
(opt-in tree-sitter):** additive symbol/call schema, `web-tree-sitter` as an optionalDependency with
grammar WASM assets resolved through the Block 0 Asset Resolver, a `gdgraph.treesitter` CapabilityAdapter,
and `build` enrichment behind `resolveCapability` — the regex path stays the byte-identical default.
Block-completion gate = the fallback byte-identity snapshot + no-network sandbox test (AC4).

Single coherent implementer (shared single-writer files: `build.ts`, `query.ts`, `types.ts`,
`commands/gdgraph.ts`, `init.ts`, `package.json`, `assets.lock.json`).

## Steps (grouped from spec T-B1..T-B15)

1. **Facade + config (T-B1, T-B2).** `src/gdgraph/service.ts` wrapping build/query/affected;
   `src/gdgraph/config.ts` `DEFAULT_GDGRAPH_CONFIG` + deep-merge loader (malformed→defaults).
2. **B2 transitive affected (T-B3, T-B4).** `affected.ts`: N-hop BFS/DFS closure over reverse-dependents,
   `depth`/`ranked`(hop,fanIn); cycle-safe (visited set); wire `--depth/--ranked/--json` into
   `commands/gdgraph.ts` with the DEFAULT renderer byte-identical (depth-1 == today).
3. **B2 fixtures (T-B5).** `fixtures/transitive-closure/` (depth-1..k + cycle) + `affected.test.ts`
   (exact closure per depth; byte-identical `--depth 1` snapshot).
4. **B3 PageRank (T-B6).** `pagerank.ts`: `personalizedPageRank` fixed params, edge weights
   import/CALL/defines, total-order tie-break → deterministic.
5. **B3 repomap (T-B7, T-B8).** `repomap.ts`: rank + render path/top-symbols/signatures, `chars/4`
   token budget with stable omission marker → `artifacts/repomap.md`; `gdgraph repomap [--budget]
   [--seed|--changed]` CLI + `"repomap"` in manifest commands.
6. **B3 fixtures (T-B9).** `fixtures/repomap/` (centrality order + budget) + `repomap.test.ts`
   (budget bound, order, re-run byte-identity).
7. **B1 schema (T-B10).** additive `SymbolNode`/`CallEdge`/`SymbolLayer` in `types.ts`; `loadGraph`
   loads `symbols.jsonl`/`calls.jsonl` if present (missing⇒empty, never error). Legacy types untouched.
8. **B1 deps+assets (T-B11).** `web-tree-sitter` already in optionalDependencies; register grammar asset
   ids in `assets.lock.json`; `treesitter/grammars.ts` resolves via `resolveAsset`. No top-level import.
9. **B1 adapter (T-B12).** `treesitter/{adapter,extract}.ts`: `gdgraph.treesitter` CapabilityAdapter
   (`isAvailable` = dep-import + grammar-resolve; `run` → sorted/stable SymbolLayer via committed
   per-language queries); never throws out.
10. **B1 build wiring (T-B13).** After the UNCHANGED file-level build, `resolveCapability("gdgraph.treesitter")`;
    null ⇒ file-level only (byte-identical), else write symbols/calls additively; `init --treesitter/
    --no-treesitter` + capabilities entry + config `treesitter` block; warn-once + exit 0 when unavailable.
11. **B1 fixtures (T-B14).** `fixtures/symbol-graph/` (hand-labeled expected); precision≥0.9/recall≥0.85;
    availability-true (grammar stubbed) + availability-false (fallback) tests; byte-identical legacy snapshot;
    no-network sandbox test — THE block-completion gate.
12. **Docs (T-B15).** roadmap-2026 status + reconcile `B-code-understanding/` vs `B-gdgraph/` link + gdgraph docs.
13. **Review + PR.** Adversarial review (byte-identity / no-top-level-import / no-network / determinism).

## Risks

- **Byte-identity regression (top):** any change to the file-level build output breaks AC4/C0-7. Mitigation:
  capture a pre-block snapshot of the four artifacts; the fallback snapshot test is a hard gate; symbol layer
  is strictly additive files.
- **Determinism:** PageRank + symbol ids must be reproducible — fixed params, total-order tie-break, stable
  symbol id scheme `<path>#<Container>.<name>` (`@<startLine>` only on collision); re-run diff empty.
- **web-tree-sitter WASM in CI:** the dep/grammar may be absent in CI — availability-true tests skip gracefully;
  the fallback + no-network path is mandatory and always runs.
- **depth-1 back-compat:** `--depth 1`/no-flag stdout must exactly match the pre-block renderer (snapshot).
- **No top-level import of web-tree-sitter:** extend the Block 0 static guard.
