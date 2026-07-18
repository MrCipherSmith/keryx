# Flow Journal

- 2026-07-18T10:58:27.511Z - flow created
- 2026-07-18T10:58:27.629Z - frozen: 4 criteria; checksum recorded
- 2026-07-18T10:58:27.707Z - started
- 2026-07-18T10:58:27.784Z - task-done: T1: Collect remaining context
- 2026-07-18 - task-impl (044-T2): batch-2 metaproject tools delivered, mirroring flow 043 (additive, TDD).
  - DELIVERED 3 read-only operations (exceeds the AC1 minimum of two):
    - `graph_symbol` — backing: gdgraph in-process (`GdgraphService.loadGraph` + pure `querySymbol`). Symbol definitions + callers + callees over the tree-sitter symbol layer. Deterministic, no I/O beyond graph load.
    - `repomap` — backing: gdgraph in-process (`GdgraphService.repomap`). Ranked, token-budgeted repo map (PageRank). Note: the facade persists `artifacts/repomap.md` as a side effect on real runs; tests inject a fake so no file is written and no network/subprocess is touched.
    - `wiki_ask` — backing: gdwiki in-process (`wikiAsk` from src/wiki/ask.ts), injected via `MetaprojectAdapterDeps.wikiAsk` (same injectable pattern as `findRelatedTests`). Deterministic lexical Q&A over the project's own wiki + memory with citations. A clean in-process facade EXISTS, so wiki_ask was DELIVERED (not dropped).
  - DROPPED: none. All three candidate backings were cleanly available in-process.
  - Port: added OPTIONAL `graphSymbol?`/`repomap?`/`wikiAsk?` + content result types (GraphSymbolResult/RepomapResult/WikiAskResult). Optional ⇒ existing full-port fakes compile unchanged.
  - Adapter: implemented each over the facade, deterministic, never throws (backing error → structured error/empty). Extended `MetaprojectAdapterDeps` with an injectable `wikiAsk` (defaulted to the real facade) so existing tests compile.
  - Operations: 3 descriptors added (risk read, valid input/output JSON Schemas, `invoke` checks the OPTIONAL port method → "not available" when absent). EXPECTED_NAMES updated 8 → 11 (sorted).
  - Projections (toInteractiveTools/toToolDefinitions/toMcpTools) UNCHANGED; new tools auto-surface. MCP structured-invoke switch left unchanged (same as flow 043 for its new ops).
  - Verify: `tsc --noEmit` clean; `bun test src/harness/tool/ src/mcp/` 125 pass / 0 fail; full `bun test` 1445 pass / 3 skip / 0 fail (baseline 1436). `dependencies` remains `{}`. Existing 8 operations, projections, chat core, and policy engine untouched.

## Phase 3 — verification (orchestrator, independent)
- Worker (044-T2) STATUS: DONE. Delivered 3: graph_symbol (gdgraph loadGraph + querySymbol), repomap (gdgraph repomap), wiki_ask (gdwiki in-process facade src/wiki/ask). None dropped.
- Additive OPTIONAL port methods + adapter impl (injectable wikiAsk dep) + 3 descriptors + tests; EXPECTED_NAMES 8→11; auto-surfaced via the generic projections.
- Independent verify: `bunx tsc --noEmit` clean; `bun test` **1445 pass / 3 skip / 0 fail** (baseline 1436; +9). deps {}.
- KNOWN FOLLOW-UPS (out of flow 044 frozen scope; to schedule):
  1. MCP structured-invoke (src/mcp/metaproject-tools.ts `invokeStructured` switch) does NOT dispatch the new ops (flows 043 + 044) — they LIST via toMcpTools but MCP `callTool` returns "unknown metaproject operation". Fix: make invokeStructured generic (fall back to op.invoke) so all unified ops invoke via MCP.
  2. repomap's facade writes .metaproject/data/gdgraph/artifacts/repomap.md as a side effect on real runs — a benign artifact write under a tool classified `read`. Consider a read-only repomap path or reclassify.
- AC1–AC4 (frozen scope) satisfied.
- 2026-07-18T11:06:13.831Z - task-done: T2: Implement per plan
- 2026-07-18T11:06:13.929Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-18T11:06:14.031Z - task-done: T4: Self-review and prepare draft PR
