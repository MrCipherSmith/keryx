# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

These consolidate Block D's AC1..AC18 (docs/requirements/roadmap-2026/D-quality-signals/acceptance-criteria.md).

## Criteria

- AC1: `hotspot.ts` computes `score(file) = churn(file) × complexity(file)` where churn comes from the existing `getChurn(cwd, churnWindowDays)` and complexity is the Σ per-function cyclomatic complexity from `analyzeSourceFiles`; no new `dependencies`/`optionalDependencies` and no socket are added (verified by the no-network sandbox). [AC1]
- AC2: On `fixtures/churn-complexity/` (seeded git history + known complexity) the top-N ranked hotspots equal the expected set exactly, sorted by score desc then path asc; re-running `health run` twice yields an identical ranking and identical artifacts (reproducible). [AC2, AC3]
- AC3: The hotspot signal enters `healthScore()` additively via `hotspotPenalty` through the same per-LOC normalization as existing penalties and adds no new gate rule — `computeGate` is unchanged; hotspots affect the gate only through the existing score/regression path. [AC4]
- AC4: With default config (`scoring.hotspotWeight = 0`), every scope's `health_score`, `regression_score`, and the gate `status` are identical to the pre-D1 values on the fixture (regression == 0); the added report fields (`metrics[].hotspot`, `report.hotspots`) are additive/nullable behind a `schemaVersion` bump and no existing score value changes. [AC5]
- AC5: Setting `scoring.hotspotWeight > 0` measurably lowers the score for scopes containing fixture hotspots and can escalate the existing gate via the regression path (proving the signal is a live additive input). [AC6]
- AC6: `testing coverage-map build` writes a deterministic `coverage-map.json` (`testFile → {coveredFiles[], coveredLines?}`) parsed from existing lcov and/or V8/bun JSON coverage with no bespoke instrumentation on the default path and no new dependency; key/array ordering is stable and a re-build on the fixture yields an identical file. [AC7]
- AC7: On `fixtures/change-impacted-test/` with its coverage map present, `testing run --changed` selects the tests whose coverage intersects the changed files/lines and the selected set's precision is strictly higher than the static changed-file selection on the same change; `selection.strategies` records `"coverage-map"`. Changed files absent from the map still fall back to the naming/directory heuristic, unioned with the map-based set — no changed file is silently dropped. [AC8, AC9]
- AC8: The `coverageMap` capability wires all four coordinated parts (`init --testing-tia/--no-testing-tia`, a `metaproject.json` manifest capability entry, a `testing.config.json` toggle deep-merged over defaults with malformed JSON ⇒ defaults, and the map-absent fallback contract); a missing manifest ⇒ capability off. [AC10]
- AC9: With the capability disabled OR no `coverage-map.json` present, `selectChangedTests` returns output byte-identical to today's static selection on the same fixture (identical `selectedTests`, `changedFiles`, `fallback`, and `strategies = ["runner","gdgraph","naming"]`); no map is read and no coverage command runs; a test asserts equality to the pre-D2 selection. [AC11]
- AC10: When `smoke.selectors` is non-empty the smoke set is unioned into every invocation (changed, scope, project modes) and recorded in `report.selection.smokeTests`; the union composes with, never suppresses, scoped selection (final ⊇ scoped for every mode); with no `smoke` block configured (default) the selected set is byte-identical to today (empty smoke ⇒ no-op union). [AC12, AC13, AC14]
- AC11: Byte-identical default (package gate): with `hotspotWeight=0`, no `coverage-map.json`, and empty `smoke.selectors`, the full existing `health`+`testing` suites pass with unchanged score/gate/selection behavior (additive schema fields only), no new dependency loaded, no socket opened; each opt-in path has both an availability-true and an availability-false test; a no-network sandbox test confirms `health run` and `testing run --changed` open no socket. [AC15, AC16]
- AC12: Both fixture corpora (`fixtures/churn-complexity/`, `fixtures/change-impacted-test/`) are deterministic and git-committed with capability metrics measured against them; any raw coverage output persisted by `coverage-map build` passes through `guardOutput`/`redactRaw` and `coverage-map.json` contains only file paths and line numbers. `bun run check` passes with the 293 pre-existing tests unchanged; `dependencies` and `optionalDependencies` are not extended by D; roadmap-2026 status updated. [AC17, AC18 + suite]
