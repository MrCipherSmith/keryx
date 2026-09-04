# Flow Journal

- 2026-09-03T20:55:59.785Z - flow created
- 2026-09-03T20:57:58.058Z - task-done: T1: Collect remaining context
- 2026-09-03T20:57:58.145Z - task-added: T5: Extend GraphNode/GraphEdge types: wiki-page kind, describes edge, contentHash/mtimeMs (AC1,AC2,AC7)
- 2026-09-03T20:57:58.226Z - task-added: T6: Resolve a page describe-set with frontmatter>related-code>key-files precedence (AC4)
- 2026-09-03T20:57:58.303Z - task-added: T7: Emit wiki-page nodes and describes edges during build, incl. graph-unavailable guard (AC1,AC5,AC6)
- 2026-09-03T20:57:58.383Z - task-added: T8: Page provenance: parse/write VerifiedAt+Describes, compute VerifiedScope over full describe-set (AC8,AC9)
- 2026-09-03T20:57:58.465Z - task-added: T9: Reverse query: pages describing file X, over existing incoming-edge index (AC3)
- 2026-09-03T20:57:58.552Z - task-added: T10: Undecidable pages: empty describe-set is neither fresh nor orphan (AC10)
- 2026-09-03T20:57:58.662Z - task-added: T11: Tests per AC incl. back-compat fixture and no-.git worktree (AC2,AC11)
- 2026-09-03T20:57:58.762Z - task-added: T12: Measure graph build time delta from hashing and record in journal (AC12)
- 2026-09-03T20:58:02.125Z - frozen: 12 criteria; checksum recorded
- 2026-09-03T20:58:02.220Z - started
- 2026-09-03T21:01:18.221Z - task-done: T5: Extend GraphNode/GraphEdge types: wiki-page kind, describes edge, contentHash/mtimeMs (AC1,AC2,AC7)
- 2026-09-03T21:01:18.324Z - task-done: T6: Resolve a page describe-set with frontmatter>related-code>key-files precedence (AC4)
- 2026-09-03T21:30:44.567Z - ac-updated: Design corrected during T7: wiki layer must be its own storage files, not new kinds inside nodes.jsonl/edges.jsonl. Five production call sites (wiki/service.ts:365,412; wiki/collect.ts:97; commands/update.ts:869) treat every non-asset node as a source file, so a wiki-page node would be grouped by moduleNameFromProjectPath into a fabricated module and would corrupt validModuleNames — the exact module set wikiPruneOrphans and sac/lifecycle-flag.ts rely on. AC1/AC2/AC7 restated against the layer files and a build manifest; AC13 added to pin the no-regression guarantee

## 2026-09-03 — phase 0 implemented

### Design reversed mid-flight

The package specification (1.4.0) said to add `kind: "wiki-page"` to
`GraphNode` and `kind: "describes"` to `GraphEdge`, i.e. put wiki records
into `nodes.jsonl` / `edges.jsonl`. Implementing it surfaced that this is a
regression, not a preference: five production call sites treat every node
that is not `asset` as a source file — `validModuleNames` and
`collectGraphWikiCandidates` (`src/wiki/service.ts:365,412`),
`computeModuleKeyFiles` (`src/wiki/collect.ts:97`) and
`src/commands/update.ts:869`. A page node there would be grouped by
`moduleNameFromProjectPath` into a fabricated module
(`.metaproject/wiki/components`) and would corrupt the module set
`wikiPruneOrphans` and `src/sac/lifecycle-flag.ts` use to decide what is
orphaned.

The codebase already had the answer: `build.ts` adds the tree-sitter symbol
layer after the unchanged file-level build, into its own storage files. The
wiki layer now follows that precedent — `wiki-pages.jsonl`,
`describes.jsonl`, and `build-manifest.json` for the fingerprints. Frozen ACs
were re-cut through `keryx flow ac update`; AC13 was added to pin the
guarantee. Package specification bumped to 2.0.0 (the storage contract is the
part that changed).

### AC12 — measured cost, on this repository

`buildGraph` over the real tree, warm cache, after the change:

- 1120 file nodes, 3406 edges, 1120 files hashed
- 50 wiki pages, 373 `describes` edges
- full build including the layer: **2335 ms**
- wiki layer + manifest alone: **37 ms — 2% of the build**

Hashing is effectively free because `buildGraph` already holds every file's
content in `fileRecords`; the only added I/O is one `stat` per file for
`mtimeMs`. No fallback to lazy hashing is needed, and the plan's stated risk
("hashing every file adds build time — measure") is closed as not material.

Reported whichever way it came out: it came out cheap.

### Two things worth carrying into phase 1

`collectPages` walks only the folders listed in `WIKI_PAGE_TYPES`, so the
`testing/` and `templates/` directories that exist on disk are invisible to
it — 50 pages collected, not the 53 on disk. They are not mistyped, they are
unseen. Phase 1 has to decide whether that stays.

The layer reads its module set through `validModuleNames`, which re-reads
`nodes.jsonl` from disk rather than using the in-memory graph. That is a
deliberate cost: AC5 requires a single source of module grouping, and
re-deriving it in memory would be the second implementation that
`validModuleNames` was extracted to prevent.
- 2026-09-03T21:40:24.459Z - task-done: T7: Emit wiki-page nodes and describes edges during build, incl. graph-unavailable guard (AC1,AC5,AC6)
- 2026-09-03T21:40:24.629Z - task-done: T8: Page provenance: parse/write VerifiedAt+Describes, compute VerifiedScope over full describe-set (AC8,AC9)
- 2026-09-03T21:40:24.757Z - task-done: T9: Reverse query: pages describing file X, over existing incoming-edge index (AC3)
- 2026-09-03T21:40:24.919Z - task-done: T10: Undecidable pages: empty describe-set is neither fresh nor orphan (AC10)
- 2026-09-03T21:40:25.154Z - task-done: T11: Tests per AC incl. back-compat fixture and no-.git worktree (AC2,AC11)
- 2026-09-03T21:40:25.362Z - task-done: T12: Measure graph build time delta from hashing and record in journal (AC12)
- 2026-09-04T05:34:49.745Z - ac-confirmed: AC1: wiki-layer.test.ts 'AC1: emits a page node per page and describes edges'; e2e build produces wiki-pages.jsonl + describes.jsonl; real repo: 50 pages, 373 describes edges
- 2026-09-04T05:34:49.827Z - ac-confirmed: AC2: wiki-layer.test.ts 'a graph with no layer files loads with the fields simply absent'; loadGraph omits wikiPages/describes, 231 gdgraph+wiki tests green
- 2026-09-04T05:34:49.911Z - ac-confirmed: AC3: wiki-layer.test.ts reverse queries: getPagesDescribing returns both pages for a shared file and nothing else; getFilesDescribedBy covers the forward direction
- 2026-09-04T05:34:50.007Z - ac-confirmed: AC4: describes.test.ts 'resolveDescribeSet precedence' — frontmatter replaces, related-code beats key-files, key-files is the fallback
- 2026-09-04T05:34:50.089Z - ac-confirmed: AC5: wiki-layer.test.ts 'the module set drives the layer — a stubbed set changes the output'; layer reads validModuleNames, never re-derives grouping
- 2026-09-04T05:34:50.177Z - ac-confirmed: AC6: wiki-layer.test.ts 'an unbuilt graph yields an EMPTY layer, not a layer of orphans' — validModules undefined returns {pages:[],describes:[]}
- 2026-09-04T05:34:50.261Z - ac-confirmed: AC7: wiki-layer.test.ts computeFingerprints: content-derived, stable across runs, sorted; e2e asserts build-manifest.json rows with sha256 + mtimeMs
- 2026-09-04T05:34:50.343Z - ac-confirmed: AC8: provenance.test.ts upsertFrontmatterField: insert leaves every original line intact and lands inside frontmatter; replace changes no other byte; parse/write round-trip is a no-op
- 2026-09-04T05:34:50.435Z - ac-confirmed: AC9: provenance.test.ts 'the SEVENTH file changes the scope' — computeVerifiedScope over the full describe-set, not top-6
- 2026-09-04T05:34:50.535Z - ac-confirmed: AC10: wiki-layer.test.ts 'a page describing nothing is undecidable and emits no edges', run against an architecture-type page
- 2026-09-04T05:34:50.622Z - ac-confirmed: AC11: wiki-layer-no-git.test.ts: full phase-0 path (build, layer, scope, provenance round-trip) on a tree with no .git; asserts none is created
- 2026-09-04T05:34:50.707Z - ac-confirmed: AC12: Measured on the real repo: 1120 files, 2335ms full build, 37ms layer+manifest = 2% ; recorded in journal.md. Full suite 48 fail before and 48 after (worktree at 94998d9a) — zero regressions, +125 passing tests
- 2026-09-04T05:34:50.799Z - ac-confirmed: AC13: wiki-layer.test.ts 'nodes.jsonl/edges.jsonl stay byte-identical': build without a wiki, then with one, byte-compare both legacy artifacts
- 2026-09-04T05:34:58.874Z - ac-confirmed: AC13: wiki-layer.test.ts 'nodes.jsonl/edges.jsonl stay byte-identical': build without a wiki, then with one, byte-compare both legacy artifacts
- 2026-09-04T05:44:53.627Z - task-done: T2: Implement per plan
- 2026-09-04T05:44:53.712Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-04T05:44:53.798Z - task-done: T4: Self-review and prepare draft PR
