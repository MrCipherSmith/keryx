# Tasks: Block D — Quality Signals (`health` + `testing`)

Version: 1.0.0
Atomic tasks T1..Tn with **kind**, **deps**, and the AC(s)/US they satisfy. Kinds:
`chore` (fixtures/config/docs), `feat` (new behavior), `edit` (modify shipped code), `test`.

**Block-0 dependency (hard):** only D2's capability wiring (T7) and both fixture corpora's use of
the acceptance harness (T5, T10, T15) require **Block 0 — Capability Seam** to have landed. **D1
(T1–T5) is a pure early win and does NOT depend on Block 0** — it introduces no capability, no dep,
no asset, and can start immediately.

---

## Phase 1 — D1: hotspot signal (pure early win; independent of Block 0)

- [ ] **T1 · feat** — `src/health/metrics/hotspot.ts`: `hotspotScore(churn, complexity)` and
  `rankHotspots(files, churn, sourceAnalysis)` (score = churn × complexity; sort desc, path tiebreak).
  Pure, no I/O. **Deps:** none. **Satisfies:** AC1, US-D101.
- [ ] **T2 · edit** — `src/health/config.ts` + `types.ts`: add `scoring.hotspotWeight` (default **0**)
  and `metrics.hotspotThreshold` (default 0); bump `schemaVersion` to 2; keep deep-merge over
  defaults. **Deps:** none. **Satisfies:** AC5, C0-8.
- [ ] **T3 · edit** — `src/health/scoring.ts`: add `hotspotPenalty(fileHotspots, config)` and include
  it additively in `healthScore()` (== 0 when weight 0). `src/health/scopes.ts`: compute per-scope
  `hotspot` aggregate + carry the project `hotspots[]` ranking. **Deps:** T1, T2.
  **Satisfies:** AC4, AC5, AC6, US-D102.
- [ ] **T4 · edit** — `src/health/report.ts`: render the additive hotspot ranking section; wire
  `hotspots`/`hotspot` (nullable) into `latest.json`. Optional `hotspot-findings.ts` emission stays
  **default off** to preserve byte-identical artifacts. **Deps:** T3. **Satisfies:** AC5, AC15.
- [ ] **T5 · chore+test** — `fixtures/churn-complexity/` (seeded git history + known complexity) and
  tests: ranking exactness (AC2), reproducibility (AC3), score/gate invariance at weight 0 (AC5),
  weighted escalation (AC6). **Deps:** T1–T4. **Satisfies:** AC2, AC3, AC5, AC6, AC17.

## Phase 2 — D2: coverage-map TIA (needs Block 0 for capability wiring)

- [ ] **T6 · feat** — `src/testing/coverage-map.ts`: `buildCoverageMap` (run-with-coverage or import),
  `loadCoverageMap` (→ `null` ⇒ fallback), lcov + V8/bun JSON parsers; deterministic normalized
  output; reuse `guardOutput`/`redactRaw` for any persisted raw coverage log. **Deps:** none (parser
  is pure). **Satisfies:** AC7, AC18, US-D201.
- [ ] **T7 · edit** — capability wiring (`C0-3`): `init --testing-tia/--no-testing-tia`, manifest
  `modules.testing.capabilities:["coverageMap"]` read (`isTestingCapabilityEnabled`, mirror
  `isSecurityEnabled`), `testing.config.json` `coverageMap` block deep-merged over defaults.
  **Deps:** T6, **Block 0**. **Satisfies:** AC10, US-D201.
- [ ] **T8 · feat** — `selectByCoverageMap(changedFiles, map)`: file/line intersection → covering
  tests. **Deps:** T6. **Satisfies:** AC8, US-D202.
- [ ] **T9 · edit** — `src/testing/service.ts` `selectChangedTests`: map-first selection when
  capability enabled AND map present, unioned with the static naming heuristic for map-absent files;
  **else the current static path unchanged**. Record `"coverage-map"` in `selection.strategies`.
  **Deps:** T7, T8. **Satisfies:** AC8, AC9, AC11, US-D202, US-D203.
- [ ] **T10 · chore+test** — `fixtures/change-impacted-test/` (change → true impacted-test map +
  coverage map) and tests: coverage-map precision > static (AC8), map-absent files fall back (AC9),
  no-map byte-identical static fallback == pre-D2 selection (AC11), availability true/false pair
  (T-3). **Deps:** T6–T9, **Block 0** (harness). **Satisfies:** AC8, AC9, AC11, AC16, AC17.

## Phase 3 — D3: always-on smoke tier

- [ ] **T11 · edit** — `testing.config.json` + `types.ts`: add `smoke.selectors` (default `[]`).
  **Deps:** none. **Satisfies:** AC14, C0-8.
- [ ] **T12 · feat** — `resolveSmokeSet(cfg.smoke, context.testFiles)` (globs/tags/paths → list) and
  union it into every selection mode; add `selection.smokeTests` to the report. **Deps:** T11.
  **Satisfies:** AC12, AC13, US-D301.
- [ ] **T13 · test** — integration: smoke inclusion across changed/scope/project modes (AC12),
  compose-not-suppress (AC13), empty-smoke byte-identical default (AC14). **Deps:** T12.
  **Satisfies:** AC12, AC13, AC14.

## Phase 4 — cross-cutting acceptance & docs

- [ ] **T14 · test** — no-network sandbox test: `health run` + `testing run --changed` open no socket
  and load no new dependency (`T-4`, XP1); byte-identical default suite (AC15). **Deps:** T5, T10, T13.
  **Satisfies:** AC15, AC16.
- [ ] **T15 · chore** — wire both corpora into Block 0's fixture-corpora acceptance harness; ensure
  they are the named `flow` acceptance gate (F-1). **Deps:** T5, T10, **Block 0**. **Satisfies:** AC17.
- [ ] **T16 · chore** — docs: update `docs/requirements/roadmap-2026/README.md` (the Block-D row/link
  currently points at `D-health-testing/`; reconcile with this package's `D-quality-signals/` path),
  version this package, keep DOC-1 layout. **Deps:** T1–T15. **Satisfies:** DOC-1.

---

## Dependency graph (summary)

```
Block 0 ────────────────┐ (only T7, T10, T15)
                        ▼
D1:  T1 → T2 → T3 → T4 → T5                (independent of Block 0)
D2:  T6 → T7(+B0) → T8 → T9 → T10(+B0)
D3:  T11 → T12 → T13
All: (T5,T10,T13) → T14 ; (T5,T10,+B0) → T15 ; everything → T16
```

**Ordering rules:** D1 first (pure early win, no Block-0 gate). D2/D3 proceed once Block 0 exists;
D2 and D3 are independent of each other. T14/T16 close the block.
