# Acceptance Criteria

Phase 5 of `docs/requirements/keryx-living-wiki-graph/` (specification 2.0.0).

- AC1: `HealthReport` carries an optional `wikiFreshness` block; a report
  produced without one loads and renders unchanged.

- AC2: With a freshness report present, health reports `pagesTotal`,
  `pagesFresh`, `pagesUndecidable`, the actionable count, and a ratio.

- AC3: With NO freshness report, the metric is absent and the artifact says
  why. It never renders as 0 stale, 100% fresh, or any number at all.

- AC4: The ratio's denominator excludes undecidable pages, and the
  undecidable count is reported alongside it, so the figure cannot flatter
  itself by hiding pages it cannot judge.

- AC5: A freshness report older than a configurable window is reported as
  stale-evidence, with its age, rather than presented as current.

- AC6: A damaged or unparseable `latest.json` is treated as absent, with a
  reason — never as a partial number.

- AC7: The health gate verdict is identical with and without the metric
  present, proven by a test that runs the gate both ways.

- AC8: `health run` performs no graph traversal and no wiki page reads for
  this metric — it reads one JSON file.

- AC9: A CI workflow runs `wiki validate` as blocking and `wiki freshness` as
  reporting, and treats an empty finding list as clean only when
  `limitations` is also empty.

- AC10: `bun test` passes with no new failures relative to the merge-base,
  compared in a worktree rather than asserted.
