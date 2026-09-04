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

- AC6: The `post-commit` hook appends one schema-valid line, and its own cost
  is at most **2× the platform floor** — the cost of a hook that does nothing
  but `exit 0` — measured over at least 100 runs.

  *Amended after measurement.* The original text said "under 50 ms at p95",
  a number chosen before anything was measured. The floor turned out to be
  ~16 ms on Apple-silicon macOS: that is what a git commit pays for an EMPTY
  hook, before the script does anything, and no implementation can go below
  it. Each additional subprocess costs roughly 24 ms, and the hook needs at
  minimum one `git` call plus escaping. A fixed 50 ms was therefore an
  arbitrary line drawn just above an unknown floor, not a requirement.

  Measured after optimisation (120 runs, 20 changed files, hook timed in
  isolation rather than through `git commit`): **median 40.9 ms, p95 50.7 ms,
  max 61.4 ms** — 2.5× the floor, against 7.6× for the first working version
  (~121 ms added). Rejected as not worth it: folding the `sed`+`paste`
  escaping into one `awk` to save ~10 ms. Two escaping bugs have already been
  found in this hook, and a fourth level of quoting is where the third would
  hide. (package AC-12)

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
