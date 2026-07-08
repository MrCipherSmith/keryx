# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

Maps the block spec's T1–T16 (docs/requirements/roadmap-2026/D-quality-signals/tasks.md)
onto flow task units. D1 (T2–T3) is a pure early win; D2 (T4–T5) needs Block 0 capability wiring; D3 (T6).

| ID | Kind | Title | Spec tasks | Satisfies |
|----|------|-------|-----------|-----------|
| T1 | context | Study health/testing seams + Block 0 capability wiring (done Phase 1) | — | — |
| T2 | implement | D1 hotspot: `health/metrics/hotspot.ts` (churn×complexity, pure) + config (hotspotWeight 0, threshold, schemaVersion→2) | T1, T2 | AC1 |
| T3 | implement | D1 score+scopes+report: hotspotPenalty additive in healthScore (==0 at weight 0, computeGate unchanged) + per-scope hotspot + project hotspots[] (additive/nullable) | T3, T4 | AC3, AC4, AC5 |
| T4 | implement | D2 coverage-map: `testing/coverage-map.ts` (build/load→null⇒fallback, lcov+V8 parsers, deterministic, guardOutput for raw log) | T6 | AC6, AC12 |
| T5 | implement | D2 capability wiring + selection: init --testing-tia + manifest capability + config block; selectByCoverageMap + selectChangedTests map-first (else static byte-identical) | T7, T8, T9 | AC7, AC8, AC9 |
| T6 | implement | D3 smoke tier: smoke.selectors config + resolveSmokeSet unioned into every mode + selection.smokeTests (compose not suppress) | T11, T12 | AC10 |
| T7 | test | Fixtures + tests: churn-complexity/ + change-impacted-test/; ranking exactness, reproducibility, score/gate invariance@0, weighted escalation, coverage precision>static, map-absent fallback, no-map byte-identical, smoke inclusion/compose, no-network sandbox, byte-identical default | T5, T10, T13, T14, T15 | AC2, AC5, AC7, AC9, AC10, AC11, AC12 |
| T8 | docs | roadmap-2026 README: reconcile D-quality-signals link + mark ✅ landed | T16 | AC12 |
| T9 | review | Adversarial review (score-invariance@0 / static-selection byte-identical / no-network / no-new-dep) + draft PR | — | AC11, AC12 |

## Notes
- **Golden rule is the block-completion gate:** T7's byte-identical default (hotspotWeight=0, no map, empty smoke) + no-network sandbox tests (AC11) must be green.
- D1 (T2–T3) is a pure early win — no capability, no dep, no asset.
- Block D introduces NO optional dependency and does NOT use the Asset Resolver; `dependencies` AND `optionalDependencies` stay unchanged.
- `computeGate` is UNCHANGED; hotspots reach the gate only via the existing score/regression path.
- Static `selectChangedTests` stays byte-identical when no map/capability off (`strategies=["runner","gdgraph","naming"]`).
