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
