# Acceptance Criteria: Block D — Quality Signals (`health` + `testing`)

Version: 1.0.0
Each AC is **hard** (inviolable) and testable against a committed fixture or a deterministic
assertion. Fixtures per `F-1`/`F-2`; measured, not prose (`F-4`). These are the `flow` completion
gate for Block D.

Legend: **[D1]** hotspot · **[D2]** coverage-map TIA · **[D3]** smoke tier · **[X]** cross-cutting.

---

## D1 — Git-churn × complexity hotspot signal

- [ ] **AC1 [D1]** `hotspot.ts` computes `score(file) = churn(file) × complexity(file)`, where
  `churn` comes from the existing `getChurn(cwd, churnWindowDays)` and `complexity` is the Σ of
  per-function cyclomatic complexity from `analyzeSourceFiles` — **no new dependency, no network
  call** is added (verified: no new `dependencies`/`optionalDependencies`; no socket in the
  no-network sandbox). _(D-1, XP1)_
- [ ] **AC2 [D1]** On `fixtures/churn-complexity/` (seeded git history + known complexity), the
  top-N ranked hotspots equal the expected set **exactly**, and the ranking is stable (sorted by
  score desc, then path asc). _(G-D1, F-4)_
- [ ] **AC3 [D1]** Re-running `health run` twice on the fixture produces an **identical** hotspot
  ranking and identical artifacts (reproducible). _(XP4, F-2)_
- [ ] **AC4 [D1]** The hotspot signal enters `healthScore()` **additively** via `hotspotPenalty`
  through the same per-LOC normalization as the existing penalties, and adds **no new gate rule**;
  `computeGate` is unchanged (hotspots affect the gate only through the existing score/regression
  path). _(D-1, D-4, NG-D2)_
- [ ] **AC5 [D1] (hotspot signal added WITHOUT breaking existing score)** With default config
  (`scoring.hotspotWeight = 0`), every scope's `health_score`, `regression_score`, and the gate
  `status` are **identical to the pre-D1 values** on the fixture (regression == 0). The added
  report fields (`metrics[].hotspot`, `report.hotspots`) are additive/nullable behind a
  `schemaVersion` bump; no existing score value changes. _(D-1, NG-D2, C0-7)_
- [ ] **AC6 [D1]** Setting `scoring.hotspotWeight > 0` measurably **lowers** the score for scopes
  containing fixture hotspots and can escalate the existing gate via the regression path — proving
  the signal is a live, additive input. _(G-D1)_

---

## D2 — Dynamic (coverage-map) Test Impact Analysis

- [ ] **AC7 [D2]** `testing coverage-map build` writes a deterministic `coverage-map.json`
  (`testFile → { coveredFiles[], coveredLines? }`), parsed from **existing** coverage output
  (lcov and/or V8/bun JSON) with **no bespoke instrumentation on the default path and no new
  dependency**. Stable key/array ordering; re-build on the fixture yields an identical file.
  _(D-2, D-6, NG-D3, NG-D4, XP4, F-2)_
- [ ] **AC8 [D2] (TIA selects the covering tests on a fixture repo with a coverage map)** On
  `fixtures/change-impacted-test/` with its coverage map present, `testing run --changed` selects
  the tests whose coverage **intersects the changed files/lines**, and the selected set's
  **precision is strictly higher** than the static changed-file selection's precision on the same
  change. `selection.strategies` records `"coverage-map"`. _(G-D2, D-2, F-4)_
- [ ] **AC9 [D2]** Changed files **absent** from the map (e.g. new files) still fall back to the
  naming/directory heuristic, unioned with the map-based set — no changed file is silently dropped.
  _(D-2)_
- [ ] **AC10 [D2]** The `coverageMap` capability wires all four coordinated parts (`C0-3`): `init`
  flag `--testing-tia`/`--no-testing-tia`, a `metaproject.json` manifest capability entry, a
  `testing.config.json` toggle deep-merged over defaults (malformed JSON ⇒ defaults), and the
  map-absent fallback contract. A missing manifest ⇒ capability off. _(C0-3, C0-8, C0-9)_
- [ ] **AC11 [D2] (static changed-file fallback UNCHANGED when no map)** With the capability disabled
  OR no `coverage-map.json` present, `selectChangedTests` returns output **byte-identical** to
  today's static selection on the same fixture (identical `selectedTests`, `changedFiles`,
  `fallback`, and `strategies = ["runner","gdgraph","naming"]`); no map is read and no coverage
  command runs. A test asserts equality to the pre-D2 selection. _(D-2, C0-4, C0-5, C0-7, F-3)_

---

## D3 — Always-on smoke tier

- [ ] **AC12 [D3]** When `testing.config.json` `smoke.selectors` is non-empty, the smoke set is
  **unioned into every** invocation (changed, scope, and project modes) and recorded in
  `report.selection.smokeTests`. An integration test asserts smoke inclusion across all three scope
  modes. _(G-D3, D-3)_
- [ ] **AC13 [D3]** The smoke union **composes with, never suppresses** scoped selection: the final
  set ⊇ the scoped/changed selection for every mode. _(D-3)_
- [ ] **AC14 [D3]** With **no** `smoke` block configured (default), the selected set is
  **byte-identical** to today (empty smoke ⇒ no-op union). _(C0-7)_

---

## Cross-cutting (package gate)

- [ ] **AC15 [X]** **Byte-identical default**: with `hotspotWeight = 0`, no `coverage-map.json`, and
  empty `smoke.selectors`, the full existing `health` and `testing` test suites pass with unchanged
  score/gate/selection **behavior** (additive schema fields only), no new dependency loaded, and no
  socket opened. This is the package-wide gate. _(C0-7, XP1, XP2)_
- [ ] **AC16 [X]** Each opt-in path has both an availability-true test (map/smoke present) and an
  availability-false fallback test (`T-3`); a no-network sandbox test confirms `health run` and
  `testing run --changed` open no socket (`T-4`).
- [ ] **AC17 [X]** Both fixture corpora (`fixtures/churn-complexity/`, `fixtures/change-impacted-test/`)
  are deterministic, git-committed, and named as the acceptance gate; capability metrics
  (ranking exactness, selection precision) are measured against them, not asserted in prose.
  _(F-1, F-2, F-4)_
- [ ] **AC18 [X]** Leak-safety preserved: any raw coverage output persisted by `coverage-map build`
  passes through the existing `guardOutput`/`redactRaw` write seam; `coverage-map.json` contains
  only file paths and line numbers. _(XP4)_
