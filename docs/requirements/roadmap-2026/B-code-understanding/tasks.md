# Tasks: Block B — Code Understanding (`gdgraph` upgrades)

Version: 1.0.0
Atomic tasks T-B1..T-B14. **Kinds:** `chore` (infra/config), `feat` (behavior),
`test` (fixtures/tests), `docs`. Every task lists dependencies (incl. Block 0) and
the constraints it satisfies. Sequencing honors architecture §7: **B2/B3 are pure
early wins** (land before the grammar-asset path, `B-9`); **B1 is opt-in** and
layered on after.

Legend: `dep:` = must complete first. `Block0:*` = a deliverable of
`00-capability-seam/`.

---

## Phase B-0 — Pure early wins (no capability, no dep)

### T-B1 — Introduce `createGdgraphService()` facade
- **Kind:** chore
- **What:** Wrap the existing `build`/`query`/`affected` functions in a
  `GdgraphService` facade (the canonical in-process contract Block A will wrap).
  No behavior change.
- **Where:** `src/gdgraph/service.ts` (new), re-exporting from `build.ts`/`query.ts`.
- **dep:** none
- **Constraints:** `M-2` (thin-adapter target), `T-1`. **AC:** existing suite green.

### T-B2 — Config loader + defaults for gdgraph
- **Kind:** chore
- **What:** `DEFAULT_GDGRAPH_CONFIG` + deep-merge loader for
  `.metaproject/gdgraph.config.json` (`affected`, `repomap`, `treesitter` blocks),
  malformed JSON ⇒ defaults.
- **Where:** `src/gdgraph/config.ts` (new). Pattern: `mergeSecurityConfig`,
  `ctx.ts loadConfig`.
- **dep:** none
- **Constraints:** `C0-8`. **AC:** AC5.1 (config part), AC3.2 (budget source).

### T-B3 — Pure transitive `affected` (BFS/DFS closure + ranking)
- **Kind:** feat
- **What:** Implement N-hop closure over reverse-dependents with `depth`, `ranked`
  (hop/fanIn), operating on the in-memory graph. `getAffected` at depth 1 returns
  today's dependents set.
- **Where:** `src/gdgraph/affected.ts` (new) or extend `query.ts`; add to service.
- **dep:** T-B1, T-B2
- **Constraints:** `B-3`,`B-5`,`B-9`. **AC:** AC2.1, AC2.3, AC2.5.

### T-B4 — Wire `affected --depth/--ranked/--json` into CLI (back-compat renderer)
- **Kind:** feat
- **What:** Parse flags in `commands/gdgraph.ts`; default/`--depth 1` uses the
  **unchanged** stdout renderer (byte-identical). `--ranked`/`--json` = additive.
- **Where:** `src/commands/gdgraph.ts`.
- **dep:** T-B3
- **Constraints:** `B-3`. **AC:** AC2.2, AC2.4.

### T-B5 — `fixtures/transitive-closure/` + B2 tests
- **Kind:** test
- **What:** Graph with documented depth-1..k closures incl. a cycle; tests asserting
  exact closure per depth and byte-identical `--depth 1` output vs a captured snapshot.
- **Where:** `fixtures/transitive-closure/`, `src/gdgraph/affected.test.ts`.
- **dep:** T-B4, `Block0:fixture-harness`
- **Constraints:** `F-1`,`F-2`,`F-4`. **AC:** AC2.*.

### T-B6 — Pure personalized PageRank
- **Kind:** feat
- **What:** `personalizedPageRank(nodes, edges, damping, personalization, iterations,
  tolerance)` with edge weights (import/CALL/defines); fixed params ⇒ deterministic;
  total-order tie-break.
- **Where:** `src/gdgraph/pagerank.ts` (new).
- **dep:** T-B2
- **Constraints:** `B-4`,`B-5`,`B-7`. **AC:** AC3.1, AC3.4, AC3.5.

### T-B7 — Token-budgeted `repomap.md` renderer
- **Kind:** feat
- **What:** Rank via T-B6, render path + top symbols + signatures, enforce token
  budget (reuse gdctx budget idiom), stable omission marker; write
  `artifacts/repomap.md`.
- **Where:** `src/gdgraph/repomap.ts` (new); add `repomap` to service.
- **dep:** T-B6
- **Constraints:** `B-4`,`C0-8`. **AC:** AC3.2, AC3.4.

### T-B8 — Wire `gdgraph repomap [--budget] [--seed|--changed]` into CLI + manifest command
- **Kind:** feat
- **What:** CLI subcommand; add `"repomap"` to `modules.gdgraph.commands` in the
  init-emitted manifest.
- **Where:** `src/commands/gdgraph.ts`, init/manifest emission.
- **dep:** T-B7
- **Constraints:** `B-4`. **AC:** AC3.1, AC3.6.

### T-B9 — `fixtures/repomap/` + B3 tests
- **Kind:** test
- **What:** Graph with expected centrality ordering + declared budget; tests for
  budget bound, centrality order, and re-run byte-identity.
- **Where:** `fixtures/repomap/`, `src/gdgraph/repomap.test.ts`.
- **dep:** T-B8, `Block0:fixture-harness`
- **Constraints:** `F-1`,`F-2`,`F-4`. **AC:** AC3.*.

## Phase B-1 — Opt-in tree-sitter symbol layer

### T-B10 — Extend schema with symbol/call types (additive)
- **Kind:** chore
- **What:** Add `SymbolNode`/`CallEdge`/`SymbolLayer` to `types.ts`; extend
  `loadGraph` to load `symbols.jsonl`/`calls.jsonl` **if present** (missing ⇒ empty
  layer, never error). File-level types untouched.
- **Where:** `src/gdgraph/types.ts`, `src/gdgraph/query.ts`.
- **dep:** T-B1
- **Constraints:** `B-5`,`C0-7`. **AC:** AC4.1 (no change to legacy types).

### T-B11 — `web-tree-sitter` as optionalDependency + grammar Asset resolution
- **Kind:** chore
- **What:** Add `web-tree-sitter` to `optionalDependencies`; register grammar asset
  ids in `assets.lock.json` (id/url/sha256/size); `grammars.ts` resolves via Block 0
  `resolveAsset`. No top-level import of the dep.
- **Where:** `package.json`, `assets.lock.json`, `src/gdgraph/treesitter/grammars.ts`.
- **dep:** `Block0:capability-seam`, `Block0:asset-resolver`
- **Constraints:** `C0-1`,`C0-2`,`C0-12`,`A-1`..`A-7`,`B-2`. **AC:** AC1.5, AC1.6, AC4.2.

### T-B12 — Tree-sitter adapter + extraction (symbols + CALL/import edges)
- **Kind:** feat
- **What:** `CapabilityAdapter` `gdgraph.treesitter` with `isAvailable()` (dep import
  + grammar resolved) and `run()` producing sorted, stable `SymbolLayer` via committed
  per-language queries; never throws out (catch → deterministic).
- **Where:** `src/gdgraph/treesitter/{adapter.ts,extract.ts}`.
- **dep:** T-B10, T-B11
- **Constraints:** `B-1`,`B-2`,`B-5`,`C0-2`,`C0-11`,`C0-14`,`NG-B4`. **AC:** AC1.1–AC1.4.

### T-B13 — Enrich `build` behind the capability + four-part opt-in wiring
- **Kind:** feat
- **What:** After the **unchanged** file-level build, call
  `resolveCapability("gdgraph.treesitter")`; `null` ⇒ file-level only (byte-identical);
  else write `symbols.jsonl`/`calls.jsonl` additively. Add `init --treesitter/
  --no-treesitter` flag + `capabilities` manifest entry. Warn-once + exit 0 when
  enabled-but-unavailable.
- **Where:** `src/gdgraph/build.ts`, `src/commands/init.ts`, manifest emission.
- **dep:** T-B12
- **Constraints:** `C0-3`,`C0-4`,`C0-5`,`C0-7`,`C0-9`,`B-1`. **AC:** AC1.1, AC4.*, AC5.1.

### T-B14 — `fixtures/symbol-graph/` + B1 tests (incl. byte-identical fallback + no-network)
- **Kind:** test
- **What:** Hand-labeled expected symbol/CALL graph; precision/recall assertions;
  availability-true (grammar stubbed) + availability-false (fallback) tests;
  byte-identical legacy-artifact snapshot with capability off; no-network sandbox test.
- **Where:** `fixtures/symbol-graph/`, `src/gdgraph/treesitter/adapter.test.ts`,
  `src/gdgraph/fallback.test.ts`.
- **dep:** T-B13, `Block0:fixture-harness`
- **Constraints:** `F-1`,`F-2`,`F-3`,`F-4`,`T-3`,`T-4`. **AC:** AC1.2, AC1.3, AC4.1–AC4.5, AC5.2.

## Phase B-2 — Docs

### T-B15 — Update roadmap + gdgraph module docs
- **Kind:** docs
- **What:** Cross-link this package from `roadmap-2026/README.md` and the base
  `docs/requirements/gdgraph/`; reconcile the `B-code-understanding/` vs `B-gdgraph/`
  directory name; note the RU→EN doc-language choice (`DOC-4`).
- **Where:** `docs/requirements/roadmap-2026/README.md`, `docs/requirements/gdgraph/`.
- **dep:** T-B14
- **Constraints:** `DOC-1`,`DOC-3`,`DOC-4`. **AC:** roadmap link resolves.

---

## Dependency graph (summary)

```
Block0:{seam, asset-resolver, fixture-harness}
        │
  T-B1 ─┼─ T-B2 ─┬─ T-B3 ─ T-B4 ─ T-B5            (B2: pure early win)
        │        └─ T-B6 ─ T-B7 ─ T-B8 ─ T-B9     (B3: pure early win)
        └─ T-B10 ─ T-B11 ─ T-B12 ─ T-B13 ─ T-B14  (B1: opt-in, needs Block 0 seam+assets)
                                                    │
                                                  T-B15 (docs)
```

**Critical rules:**
- T-B3..T-B9 (B2+B3) require **only** the fixture harness from Block 0 — they ship
  before any grammar-asset work (`B-9`).
- T-B11..T-B14 (B1) require the **full** Block 0 seam + Asset Resolver.
- No task may make `web-tree-sitter` load on the default path; the fallback snapshot
  test (T-B14) is the package-level gate for `C0-7`.
