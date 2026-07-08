# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

Maps the block spec's T-B1..T-B15 (docs/requirements/roadmap-2026/B-code-understanding/tasks.md)
onto flow task units. Phase B-0 (T2–T5) = pure early wins (no dep); Phase B-1 (T6–T9) = opt-in tree-sitter.

| ID | Kind | Title | Spec tasks | Satisfies |
|----|------|-------|-----------|-----------|
| T1 | context | Study gdgraph build/query/types + Block 0 seam/assets/harness (done Phase 1) | — | — |
| T2 | implement | Facade `createGdgraphService()` + config loader (`service.ts`, `config.ts`, deep-merge+fallback) | T-B1, T-B2 | AC5 |
| T3 | implement | B2: transitive `affected` closure (`affected.ts`, N-hop, depth/ranked/fanIn, cycle-safe) + CLI `--depth/--ranked/--json` (default renderer byte-identical) | T-B3, T-B4 | AC2 |
| T4 | implement | B3: personalized PageRank (`pagerank.ts`, fixed params, edge weights, total-order tie-break) | T-B6 | AC3 |
| T5 | implement | B3: token-budgeted `repomap.md` (`repomap.ts`, chars/4 budget + omission marker) + `gdgraph repomap [--budget][--seed|--changed]` CLI + manifest command | T-B7, T-B8 | AC3 |
| T6 | implement | B1 schema: additive `SymbolNode`/`CallEdge`/`SymbolLayer` in types.ts; `loadGraph` loads symbols/calls if present (missing⇒empty) | T-B10 | AC1, AC4 |
| T7 | implement | B1 deps+assets: grammar asset ids in `assets.lock.json`; `treesitter/grammars.ts` via resolveAsset; extend no-top-level-import guard for web-tree-sitter | T-B11 | AC1, AC4, AC5 |
| T8 | implement | B1 adapter: `treesitter/{adapter,extract}.ts` `gdgraph.treesitter` CapabilityAdapter (dep-import+grammar-resolve; never throws) → sorted stable SymbolLayer | T-B12 | AC1 |
| T9 | implement | B1 build wiring: build enrichment behind resolveCapability (null⇒byte-identical file-level); `init --treesitter/--no-treesitter` + capabilities entry + config block; warn-once exit 0 | T-B13 | AC1, AC4, AC5 |
| T10 | test | Fixtures + tests: `transitive-closure/`, `repomap/`, `symbol-graph/`; precision/recall, byte-identical fallback snapshot, availability true/false, no-network sandbox, in-process unit tests | T-B5, T-B9, T-B14 | AC1, AC2, AC3, AC4, AC5 |
| T11 | docs | roadmap-2026 status + reconcile `B-code-understanding/` link + gdgraph module docs | T-B15 | AC6 |
| T12 | review | Adversarial review (byte-identity / no-top-level-import / no-network / determinism) + draft PR | — | AC4, AC6 |

## Notes
- **Golden rule is the block-completion gate:** T10's byte-identical legacy-artifact fallback snapshot + no-network sandbox test (AC4) must be green; capture the pre-block snapshot of the four file-level artifacts first.
- B2/B3 (T3–T5) are pure early wins with NO dep — they operate on whatever graph is present; land before the grammar-asset path.
- `web-tree-sitter` is already in optionalDependencies (Block 0). No top-level import — only `await import` in `treesitter/adapter.ts`; extend the static guard.
- `affected --depth 1`/no-flag and the default text renderer stay byte-identical to today (snapshot-tested).
