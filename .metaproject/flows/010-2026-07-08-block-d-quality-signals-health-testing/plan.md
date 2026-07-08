# Implementation Plan

Status: ready

## Approach

Three deterministic, dependency-free signals, D1 first (pure early win, no Block-0 gate).
**D1:** a churn × complexity hotspot metric reusing `getChurn` + `analyzeSourceFiles`, folded
additively into `healthScore` (default weight 0 ⇒ every existing score identical) with additive/
nullable report fields behind a `schemaVersion` bump. **D2:** a coverage-map TIA — parse existing
lcov/V8 coverage into a deterministic `coverage-map.json`, wired as a Block 0 capability (config +
manifest + init flag + map-absent fallback), map-first selection unioned with the naming heuristic;
the static path stays byte-identical when no map. **D3:** an always-on smoke tier unioned into every
selection (composes, never suppresses; empty ⇒ no-op). Block-completion gate = the byte-identical
default + no-network sandbox test (AC15/AC16).

Single coherent implementer (shared single-writer files: health `scoring.ts`/`scopes.ts`/`report.ts`/
`config.ts`/`types.ts`, testing `service.ts`/`types.ts`, `commands/{health,testing,init}.ts`).

## Steps (grouped from spec T1–T16)

1. **D1 metric (T1).** `src/health/metrics/hotspot.ts` — `hotspotScore(churn, complexity)` +
   `rankHotspots(files, churn, sourceAnalysis)` (score = churn × complexity; sort desc, path tiebreak; pure).
2. **D1 config (T2).** `scoring.hotspotWeight` (default 0) + `metrics.hotspotThreshold` (default 0);
   `schemaVersion`→2; keep deep-merge.
3. **D1 score + scopes (T3).** `hotspotPenalty(fileHotspots, config)` folded additively into `healthScore()`
   (== 0 at weight 0); per-scope `hotspot` aggregate + project `hotspots[]` in `scopes.ts`. `computeGate` UNCHANGED.
4. **D1 report (T4).** additive hotspot ranking section + nullable `metrics[].hotspot`/`report.hotspots` in
   `latest.json`; optional `hotspot-findings` emission default OFF (byte-identical artifacts).
5. **D1 fixtures (T5).** `fixtures/churn-complexity/` (seeded git history + known complexity) + tests:
   ranking exactness (AC2), reproducibility (AC3), score/gate invariance at weight 0 (AC5), weighted escalation (AC6).
6. **D2 coverage-map (T6).** `src/testing/coverage-map.ts` — `buildCoverageMap`/`loadCoverageMap`(→null⇒fallback);
   lcov + V8/bun JSON parsers; deterministic normalized output; raw coverage log routed through `guardOutput`/`redactRaw`.
7. **D2 capability wiring (T7).** `init --testing-tia/--no-testing-tia`; manifest `capabilities:["coverageMap"]`
   (`isTestingCapabilityEnabled`); `testing.config.json` `coverageMap` block deep-merged (malformed⇒defaults).
8. **D2 selection (T8, T9).** `selectByCoverageMap(changedFiles, map)` (file/line intersection); `selectChangedTests`
   map-first when enabled AND map present, unioned with naming for map-absent files, record `"coverage-map"`; else static path unchanged.
9. **D2 fixtures (T10).** `fixtures/change-impacted-test/` + tests: coverage-map precision > static (AC8), map-absent
   fallback (AC9), no-map byte-identical == pre-D2 (AC11), availability true/false (T-3).
10. **D3 smoke (T11–T13).** `smoke.selectors` config (default `[]`); `resolveSmokeSet` unioned into every mode +
    `selection.smokeTests`; tests: inclusion across changed/scope/project (AC12), compose-not-suppress (AC13),
    empty-smoke byte-identical (AC14).
11. **Cross-cutting (T14, T15).** no-network sandbox (health run + testing run --changed open no socket, no new dep);
    byte-identical default suite (AC15); wire both corpora into the Block 0 harness (AC17).
12. **Docs (T16).** update roadmap-2026 README (reconcile `D-health-testing/` vs `D-quality-signals/` link + mark ✅ landed).
13. **Review + PR.** Adversarial review (score-invariance-at-weight-0 / static-selection-byte-identical / no-network / no-new-dep).

## Risks

- **Score invariance at weight 0 (top):** the hotspot term must be EXACTLY 0 at default weight — any float drift
  changes existing scores. Mitigation: multiply by weight before adding; AC5 test asserts every pre-D1 score/gate
  value identical (regression == 0) on the fixture.
- **Static selection byte-identity:** `selectChangedTests` must be byte-identical when no map / capability off
  (selectedTests/changedFiles/fallback/strategies). Mitigation: gate the map path on `enabled AND map-present`;
  AC11 test asserts equality to the pre-D2 selection; do not reorder the static strategies.
- **`computeGate` unchanged:** no new gate rule — hotspots reach the gate only via the existing score/regression path.
- **Determinism:** hotspot ranking + coverage-map key/array ordering must be stable (sorted); re-run diff empty.
- **No new dependency / no socket:** D is pure git + coverage-artifact parsing; the no-network sandbox test is the gate.
