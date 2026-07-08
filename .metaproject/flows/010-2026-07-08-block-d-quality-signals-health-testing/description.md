# Implement Block D: Quality Signals (health + testing) — hotspot + coverage-map TIA + smoke tier

Status: formalized
Source: docs/requirements/roadmap-2026/D-quality-signals/ (PRD/spec/AC1..AC18/tasks are the authoritative source)

## Problem

Add two deterministic, local, **dependency-free** quality signals on top of the shipped
`health` and `testing` modules, without changing default behavior. D1: a CodeScene-style
churn × complexity hotspot signal (reusing `getChurn` + per-function complexity) as a new
additive input to the normalized health score. D2: an opt-in coverage-map Test Impact
Analysis so changed-scope selection matches which tests actually cover changed lines —
more precise than the static naming heuristic, which stays the deterministic default/fallback.
D3: an always-on smoke tier composed into every selection. Block D introduces NO optional
runtime dependency and does NOT use the Asset Resolver — D2's "opt-in" is only a config
toggle + presence of a locally-derived coverage map.

## Expected Outcome (Block D spec §§, tasks T1–T16)

- **D1 hotspot (pure early win, no Block 0 gate):** `src/health/metrics/hotspot.ts`
  (`hotspotScore(churn, complexity)`, `rankHotspots(...)` = churn × complexity, sort desc/path tiebreak,
  pure no-I/O); `scoring.hotspotWeight` (default **0**) + `metrics.hotspotThreshold` (default 0),
  `schemaVersion`→2; `hotspotPenalty` folded additively into `healthScore()` (== 0 at weight 0, no new
  gate rule — `computeGate` unchanged); per-scope `hotspot` aggregate + project `hotspots[]` ranking in
  `scopes.ts`/`report.ts`/`latest.json` (additive/nullable). Optional `hotspot-findings` emission default OFF.
- **D2 coverage-map TIA (Block 0 capability wiring):** `src/testing/coverage-map.ts`
  (`buildCoverageMap`, `loadCoverageMap`→null⇒fallback; lcov + V8/bun JSON parsers; deterministic
  normalized `coverage-map.json` `testFile → {coveredFiles[], coveredLines?}`; persisted raw coverage
  routed through `guardOutput`/`redactRaw`); capability wiring (four parts): `init --testing-tia/
  --no-testing-tia`, manifest `modules.testing.capabilities:["coverageMap"]` (`isTestingCapabilityEnabled`),
  `testing.config.json` `coverageMap` block deep-merged (malformed⇒defaults); `selectByCoverageMap`
  (file/line intersection → covering tests); `selectChangedTests` = map-first (when enabled AND map present)
  unioned with the naming heuristic for map-absent files, records `"coverage-map"` in `selection.strategies`;
  **else the current static path is byte-identical unchanged**.
- **D3 smoke tier:** `smoke.selectors` config (default `[]`); `resolveSmokeSet(...)` unioned into every
  selection mode + `selection.smokeTests` in the report; composes-not-suppresses (final ⊇ scoped);
  empty smoke ⇒ byte-identical.
- **Fixtures:** `fixtures/churn-complexity/` (seeded git history + known complexity) and
  `fixtures/change-impacted-test/` (change → true impacted-test map + coverage map), wired into the Block 0 harness.
- **Golden rule (AC15/C0-7):** with `hotspotWeight=0`, no `coverage-map.json`, and empty `smoke.selectors`,
  the full existing `health`+`testing` suites pass with unchanged score/gate/selection behavior (additive
  schema fields only), no new dependency loaded, no socket opened. `dependencies` AND `optionalDependencies`
  are NOT exercised by D. Static selection stays byte-identical when no map (`strategies=["runner","gdgraph","naming"]`).

## Out of Scope

- SaaS/hosted code-quality service (NG-D1); replacing the normalized multi-tool health score (NG-D2).
- Mandatory coverage instrumentation on the default path (NG-D3); a new/bespoke test runner (NG-D4).
