# Acceptance Criteria

Phase 1 of `docs/requirements/keryx-living-wiki-graph/` (specification 2.0.0).
Each row names the package criterion it implements.

- AC1: A commit touching only formatting and comments classifies as
  `cosmetic` and produces an empty backlog — zero pages, not "zero
  must-refresh". (package AC-5)

- AC2: Changing an exported symbol's signature yields `stale-reference` for
  the pages describing its module, and `stale-prose` for pages whose prose
  names that symbol. (package AC-6)

- AC3: Every entry in the report carries a non-empty reason chain naming the
  source path, the change class and the edges traversed. An entry with no
  traceable cause fails the suite. (package AC-7)

- AC4: With the symbol layer unavailable, classification returns `body` for
  substantive changes and never `signature`, and the report declares
  `symbol-layer-unavailable` in `limitations`. (specification §5)

- AC5: `keryx wiki freshness` writes nothing outside
  `.metaproject/data/wiki/freshness/` and exits 0 regardless of findings.
  (package AC-11)

- AC6: The `post-commit` hook appends one schema-valid line and completes
  under 50 ms at p95 over 100 commits on this repository. (package AC-12)

- AC7: `--json` output validates against
  `schemas/freshness-report.schema.json`, including `pagesUndecidable` and a
  populated `limitations` array. (package AC-13)

- AC8: With `validModuleNames()` undefined, the report has an empty `pages`
  list, declares `graph-stale`, and emits no `orphan` or `undocumented`
  entry. (package AC-24)

- AC9: A page with an empty describe-set is excluded from `pages` and from
  the freshness ratio, and is declared via `page-without-describes`.
  (package AC-26)

- AC10: The `orphan` category is produced from `wikiPruneOrphans` /
  `validModuleNames`; a test stubbing `validModuleNames` changes the report's
  orphan set, proving no second derivation. (package AC-27)

- AC11: In a repository with no git, the report is built from `VerifiedScope`,
  declares `not-a-git-repository`, and caps every derived finding at
  `review-suggested`. (package AC-21)

- AC12: A `VerifiedAt` naming a revision absent from history falls back to the
  `VerifiedScope` path instead of erroring. (package AC-22)

- AC13: Report entries are ordered by descending commits-behind. Measured
  distribution on this repository is median 6 / max 228, so an unordered
  report hides the whole debt in its tail. (specification §8)

- AC14: A corrupt line in the queue is skipped with a recorded limitation;
  the drain never fails because of it.

- AC15: `bun test` passes with no new failures relative to the merge-base,
  compared in a worktree rather than asserted.
