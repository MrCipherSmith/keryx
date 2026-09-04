# Acceptance Criteria

Phase 2 of `docs/requirements/keryx-living-wiki-graph/` (specification 2.0.0).

- AC1: `wiki refresh` updates the managed block on a page with
  `Status: accepted`, and changes no byte outside the markers — verified by
  comparing the whole file, not the region. (package AC-8)

- AC2: `wiki refresh` makes zero provider calls, pinned by a test whose
  provider factory throws on any invocation. (package AC-10)

- AC3: A page whose managed block was hand-edited (recorded hash does not
  match current content) is refused with a named conflict and left untouched;
  `--force` overwrites it. (package AC-9)

- AC4: `wiki migrate-markers` is idempotent — a second run changes nothing —
  does NOT create a missing `## Reference` section, and refuses a page with a
  duplicated Reference heading. (package AC-25)

- AC5: On this repository's corpus, `migrate-markers` changes only marker
  lines: the diff contains no non-marker line, and the one component page with
  no Reference section is left alone.

- AC6: `wiki verify --page <p>` stamps `VerifiedAt` and `VerifiedScope` and
  changes nothing else, verified by diff.

- AC7: After verifying a page, `wiki freshness` reports it as `fresh` rather
  than `unknown`, and reports it as stale once a file in its describe-set
  changes. This is the end-to-end proof that phase 1's report becomes live.

- AC8: `wiki refresh` bumps only the patch component of `Version` and appends
  exactly one `## Changelog` line per refresh.

- AC9: A page whose block is already current is not rewritten at all — no
  version bump, no Changelog line, no provenance stamp. Stamping an untouched
  page would assert a verification that never happened.

- AC10: `wiki validate` fails on: a truncated managed block, a `describes`
  target that does not exist, and a Changelog whose versions decrease.
  (package AC-17)

- AC11: Markers carry a version (`v=1`) and an unknown marker version is
  refused rather than guessed at.

- AC12: `bun test` passes with no new failures relative to the merge-base,
  compared in a worktree rather than asserted.
