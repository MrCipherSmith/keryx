# Context

Collected deterministically by `gd-metapro flow init` at 2026-07-08T06:48:06.158Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `gd-metapro gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-07T13:53:28.505Z)
- refresh: `gd-metapro health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Authoritative source (read first)
- docs/requirements/roadmap-2026/D-quality-signals/{prd,specification,acceptance-criteria,tasks}.md — spec is the contract; AC1..AC18 are fixture-backed gates.

### Existing seams to reuse (verified present — do NOT reinvent)
- `src/health/metrics/churn.ts:getChurn(cwd, churnWindowDays)` (L4) — git log --numstat churn.
- `src/health/source-analysis.ts:analyzeSourceFiles(...)` (L12) — per-function cyclomatic complexity (Σ = file complexity).
- `src/health/scoring.ts:healthScore(...)` (L36) — fold `hotspotPenalty` additively here (== 0 at weight 0).
- `src/health/gate.ts:computeGate(...)` (L12) — MUST stay unchanged (no new gate rule; hotspots affect the gate only via the existing score/regression path).
- `src/health/scopes.ts` (`computeMetrics`), `src/health/report.ts`, `src/health/config.ts`, `src/health/types.ts` — add per-scope `hotspot` + project `hotspots[]` (additive/nullable), `scoring.hotspotWeight` default 0, `metrics.hotspotThreshold` default 0, `schemaVersion`→2.
- `src/testing/service.ts` — `selectChangedTests` is a PRIVATE fn (L461); the public entry is at L101. Add map-first selection when the capability is enabled AND a map is present; else the current static path is byte-identical (`strategies=["runner","gdgraph","naming"]`).
- `src/testing/types.ts`, `.metaproject/testing.config.json` — add `coverageMap` + `smoke` config blocks (deep-merge, malformed⇒defaults).
- `src/security/guard.ts` — `guardOutput`/`redactRaw` for any persisted raw coverage log (AC18 leak-safety).

### Block 0 seam (only D2 capability wiring T7 + harness T5/T10/T15)
- `src/capability/seam.ts` / `src/capability/registry.ts` — capability wiring (`init --testing-tia/--no-testing-tia`, manifest `capabilities` entry, config toggle, map-absent fallback). Mirror how Block A wired `--mcp` and Block B wired `--treesitter`. `isTestingCapabilityEnabled` mirrors `isSecurityEnabled`.
- `src/harness/` — `runCorpus`/`gateCorpus` for the two fixture corpora.
- **D introduces NO optional dependency and does NOT use the Asset Resolver** — the coverage map is a locally-derived artifact, not a downloaded asset. `optionalDependencies` is NOT exercised.

### Hard invariants (AC15 / C0-7 golden rule)
- With `hotspotWeight=0` + no `coverage-map.json` + empty `smoke.selectors`: full existing health+testing suites pass with unchanged score/gate/selection behavior (additive schema fields only); no new dep loaded; no socket opened.
- `computeGate` unchanged; `healthScore` hotspot term == 0 at weight 0 (every existing score value identical, regression == 0).
- Static `selectChangedTests` byte-identical when no map (identical selectedTests/changedFiles/fallback/strategies); no map read, no coverage command run on the default path.
- Smoke union composes, never suppresses (final ⊇ scoped); empty smoke ⇒ no-op.

### Baseline
- main @ 640d2e6; `bun run check` green (293 tests); Blocks 0, A, B, C landed.
