# Specification: Block D — Quality Signals (`health` + `testing`)

Version: 1.0.0
Date: 2026-07-07
Mode: `task_in_project` — extends shipped `health` + `testing`; invents no new architecture/tech.
Section order per `tech-bestpractices.md` DOC-3.

---

## 1. Purpose

Two deterministic, dependency-free signals:
- **D1** — a git-churn × complexity **hotspot** metric added as a new **additive input** to the
  normalized health score and the `flow` health gate.
- **D2/D3** — an opt-in **coverage-map Test Impact Analysis** for `testing` plus an **always-on
  smoke tier**, with the current static changed-file selection preserved as the byte-identical
  **default/fallback**.

Binding rules (from `tech-bestpractices.md` §5, §0): `D-1`, `D-2`, `D-3`, `D-4`, `D-5`, `D-6`,
`D-7`, `C0-3`, `C0-4`, `C0-5`, `C0-6`, `C0-7`, `C0-8`, `C0-9`, `F-1..F-4`, `T-3`, `T-4`.

---

## 2. Module Identity

| | D1 (hotspot) | D2 (coverage-map TIA) | D3 (smoke tier) |
|---|---|---|---|
| Host module | `src/health/` | `src/testing/` | `src/testing/` |
| Kind | pure additive metric (no capability seam) | opt-in capability (config + map presence) | pure orchestration (config) |
| New runtime dep | **none** | **none** (parses existing coverage output) | **none** |
| Asset Resolver | not used | not used (map is a local derived artifact) | not used |
| Default behavior | score/gate **byte-identical** (weight 0) | static fallback **byte-identical** (no map) | byte-identical (empty smoke set) |

> D introduces **no** `optionalDependency` (architecture §5). Its "opt-in" is purely a config
> toggle plus the presence of a locally-derived coverage map — no lazy `import()`, no download.

---

## 3. Structure (new/changed files)

```
src/health/
  metrics/
    hotspot.ts            (NEW)  pure: hotspotScore(file), rankHotspots(files,...)
    hotspot.test.ts       (NEW)
    hotspot-findings.ts   (NEW, optional emit; default off) mirrors complexity-findings.ts
  scoring.ts              (EDIT) + hotspotPenalty(); healthScore() consumes it additively
  scopes.ts               (EDIT) build() computes per-scope hotspot aggregate + ranking
  report.ts               (EDIT) render the hotspot ranking section (additive)
  config.ts / types.ts    (EDIT) + scoring.hotspotWeight (0), metrics.hotspotThreshold; schemaVersion++

src/testing/
  coverage-map.ts         (NEW)  build/import + parse (lcov, V8/bun JSON) → CoverageMap
  coverage-map.test.ts    (NEW)
  selection.ts            (NEW, or extend service.ts) coverage-map intersection + smoke union
  service.ts              (EDIT) selectChangedTests wires map-first → static fallback; smoke union
  types.ts                (EDIT) + CoverageMap, TestingConfig.coverageMap, .smoke; selection.smokeTests
  templates.ts / config   (EDIT) default testing.config.json gains coverageMap + smoke blocks

fixtures/
  churn-complexity/        (NEW, D1 acceptance corpus)
  change-impacted-test/    (NEW, D2 acceptance corpus)
```

Dependency direction unchanged (`cli → command → service → lib`); all new modules are pure and
sit beside their service.

---

## 4. Manifest Entry (`.metaproject/metaproject.json`)

- **D1** requires **no** manifest capability entry (it is a deterministic always-computed metric;
  its gate contribution is governed only by config weight). `health` enablement is read as today.
- **D2** wires the capability per `C0-3`/`C0-9` (missing manifest ⇒ capability off ⇒ static
  fallback):

```json
{
  "modules": {
    "testing": {
      "enabled": true,
      "capabilities": ["coverageMap"]
    }
  }
}
```

`isTestingCapabilityEnabled(cwd, "coverageMap")` mirrors `isSecurityEnabled` (read from the
manifest; absent ⇒ false ⇒ static selection).

- **D3** smoke tier needs no capability entry; it is driven by `testing.config.json` `smoke`.

---

## 5. Config

### 5.1 `health.config.json` (D1) — additive, deep-merged over defaults (`C0-8`)

```jsonc
{
  "schemaVersion": 2,                 // bumped: additive fields only
  "metrics": {
    "churnWindowDays": 90,            // existing, reused by hotspot
    "hotspotThreshold": 0             // NEW: files with hotspot > threshold are "hot"; inert while weight 0
  },
  "scoring": {
    "hotspotWeight": 0                 // NEW: DEFAULT 0 ⇒ score byte-identical to pre-D1
  }
}
```

- `hotspotWeight: 0` is the guarantee behind AC "hotspot added without breaking existing score".
- A **documented recommended preset** (e.g. `hotspotWeight: 2`, `hotspotThreshold` at the fixture's
  p90 product) is shipped in the spec/README as an opt-in, but the **default stays 0** (OQ-1).

### 5.2 `testing.config.json` (D2/D3) — deep-merged over defaults (`C0-8`)

```jsonc
{
  "changedSelection": {
    "strategies": ["runner", "gdgraph", "naming"],  // existing default
    "fallbackWhenEmpty": "warn"
  },
  "coverageMap": {                     // NEW (D2)
    "enabled": false,                  // default OFF ⇒ static fallback (byte-identical)
    "source": "auto",                  // "auto" | "lcov" | "v8" | "import"
    "path": "coverage/lcov.info",      // where to read existing coverage from (import mode)
    "artifact": ".metaproject/data/testing/coverage-map.json",
    "lineGranularity": true            // use covered lines when available; else file-level
  },
  "smoke": {                           // NEW (D3)
    "selectors": []                    // globs / tags / explicit paths; [] ⇒ no smoke ⇒ byte-identical
  }
}
```

Malformed JSON ⇒ fall back to defaults (existing `loadTestingConfig` behavior, `C0-8`).

---

## 6. CLI

| Command | Status | Behavior |
|---------|--------|----------|
| `gd-metapro health run` | unchanged signature | report gains the hotspot ranking; score/gate unchanged at default weight |
| `gd-metapro health explain <target>` | unchanged | shows the target's `hotspot` value alongside churn/complexity |
| `gd-metapro testing coverage-map build` | NEW | run suite with coverage (or import `coverageMap.path`), parse, write `coverage-map.json` |
| `gd-metapro testing coverage-map status` | NEW | report map presence, size, generatedAt, staleness vs current gitRef |
| `gd-metapro testing run --changed [--since <ref>]` | extended | map-aware selection when map present; static otherwise; always unions smoke tier |
| `gd-metapro init --testing-tia / --no-testing-tia` | NEW flag | writes the `coverageMap` capability entry + config toggle (`C0-3`) |

No network/socket is opened by any of these (`T-4`).

---

## 7. Service Contract

### 7.1 Health (D1)

```ts
// src/health/metrics/hotspot.ts — pure, no I/O beyond the already-loaded inputs
export type FileHotspot = { file: string; churn: number; complexity: number; score: number };

// complexity(file) = Σ per-function cyclomatic complexity from sourceAnalysis (deterministic).
// score = churn(file) * complexity(file).
export function hotspotScore(churn: number, complexity: number): number;

export function rankHotspots(
  files: string[],
  churn: Map<string, number>,
  sourceAnalysis: Map<string, SourceFileAnalysis>,
): FileHotspot[]; // sorted by score desc, then file asc (stable)
```

```ts
// src/health/scoring.ts — additive penalty, same per-LOC normalization path
export function hotspotPenalty(
  fileHotspots: FileHotspot[],
  config: HealthConfig,
): number; // count of files with score > metrics.hotspotThreshold, times scoring.hotspotWeight

// healthScore() total becomes: risk + coverage + complexity + hotspot  (hotspot == 0 when weight 0)
```

`computeMetrics.build()` (scopes.ts) computes, per scope, `hotspot` = aggregate (sum of member
files' scores) and the project scope carries the full `hotspots[]` ranking into the report.
`computeGate()` is **unchanged** — hotspots influence the gate only through the existing
`regression_score`/score path (no new gate rule; `D-4`).

### 7.2 Testing (D2/D3)

```ts
// src/testing/coverage-map.ts
export type CoverageMap = {
  schemaVersion: 1;
  generatedAt: string;
  gitRef: string | null;
  map: Record<string /*testFile*/, { coveredFiles: string[]; coveredLines?: Record<string, number[]> }>;
};
export async function buildCoverageMap(cwd: string, cfg: TestingConfig): Promise<CoverageMap>;
export async function loadCoverageMap(cwd: string): Promise<CoverageMap | null>; // null ⇒ fallback

// selection
export function selectByCoverageMap(
  changedFiles: string[],
  map: CoverageMap,
): { selectedTests: string[]; strategy: "coverage-map" };
```

`selectChangedTests` (service.ts) changes to:

```
1. changedFiles = getChangedFiles(cwd, since)                     // unchanged
2. if coverageMap capability enabled AND loadCoverageMap() != null:
     mapSelected = tests whose coveredFiles/coveredLines ∩ changedFiles(+lines) ≠ ∅
     staticSelected = today's TEST_FILE_RE + relatedByNamingAndDirectory (for files absent from map)
     selectedTests = union(mapSelected, staticSelected)           // map-first, static covers gaps
     strategy = "coverage-map"
   else:
     selectedTests = today's static selection EXACTLY               // byte-identical fallback (D-2)
3. selectedTests = union(selectedTests, resolveSmokeSet(cfg.smoke)) // D3, always-on
```

`resolveSmokeSet` returns `[]` when `smoke.selectors` is empty ⇒ union is a no-op ⇒ byte-identical.

---

## 8. Actions (behavioral detail)

### 8.1 Hotspot formula (D1)
- **churn(file)** = added + deleted lines over `metrics.churnWindowDays` (existing `getChurn`;
  files git cannot see ⇒ churn 0).
- **complexity(file)** = Σ of per-function cyclomatic complexity from `analyzeSourceFiles` (files
  with no functions ⇒ complexity 0).
- **score(file)** = `churn × complexity`. A file that is complex but never changes (or churns but is
  trivial) scores low — this is the CodeScene behavioral edge (both dimensions required).
- **ranking**: sort by score desc, tiebreak by `file` asc → deterministic, reproducible (`XP4`).
- **into the score**: `hotspotPenalty` = `count(files with score > hotspotThreshold) × hotspotWeight`,
  added to the `healthScore` total and divided by the same `normalizePerLoc` denominator as the other
  penalties. With `hotspotWeight = 0` the added term is exactly 0 ⇒ score unchanged (`C0-7`).
- **into the gate**: no new rule. A weighted hotspot penalty lowers `health_score`, which flows into
  `regression_score` and the existing `failOnRegressionDrop`/`warnOnRegressionDrop` gate rules (`D-4`).

### 8.2 Coverage-map build/import (D2)
- **build** (`source: "auto"|"v8"|"lcov"`): run the resolved test command with coverage enabled
  (bun/V8 or the runner's `--coverage`), capture the coverage report, parse per-test → covered files
  (and covered lines when `lineGranularity` and the format provides them, e.g. lcov `DA:` / V8 ranges).
  Raw coverage stdout, if persisted, goes through the existing `guardOutput`/`redactRaw` write seam.
- **import** (`source: "import"`): parse an existing `coverageMap.path` report without running tests
  (honors `NG-D3`: no mandatory instrumentation on the default path).
- Output normalized deterministically: sorted test keys, sorted `coveredFiles`, sorted line arrays.

### 8.3 Coverage-map selection (D2)
- Intersect each test's covered set with the changed files (line-level when both sides have lines,
  else file-level). Union with the static naming heuristic **only** for changed files absent from the
  map (new/uncovered files), so nothing is dropped. `selection.strategies` records `"coverage-map"`.
- **Precision claim (measured, `F-4`)**: on `fixtures/change-impacted-test/`, coverage-map selection
  precision > static selection precision (fewer false-positive tests for the same recall).

### 8.4 Static fallback contract (D2) — the byte-identical guarantee
- Capability disabled OR `coverage-map.json` absent ⇒ `selectChangedTests` runs the **current code
  path unchanged**: no map read, no coverage command, `strategies = ["runner","gdgraph","naming"]`,
  identical `selectedTests`/`changedFiles`/`fallback`. Asserted equal to the pre-D2 output (`F-3`,
  `C0-4`, `C0-5`, `C0-7`).

### 8.5 Smoke tier (D3)
- `resolveSmokeSet` expands `smoke.selectors` (globs over `context.testFiles`, tag matches, explicit
  paths) into a test list, **unioned into every** invocation (changed/scope/project). Recorded in
  `report.selection.smokeTests`. Empty selectors ⇒ empty set ⇒ byte-identical default (`C0-7`).
- The smoke union **never removes** a scoped/changed test (compose, not suppress — `D-3`).

---

## 9. Schema (artifacts)

- **`data/health/artifacts/latest.json`**: `schemaVersion: 2`; `metrics[].hotspot: number | null`;
  project entry `report.hotspots: FileHotspot[]` (additive, nullable — existing fields unchanged;
  numeric `health_score`/gate unchanged at default weight).
- **`data/testing/coverage-map.json`**: `CoverageMap` (see §7.2). Git-diffable, deterministic.
- **`data/testing/artifacts/latest.json`**: `selection.strategies` may include `"coverage-map"`;
  `selection.smokeTests: string[]` added (additive).

---

## 10. Integration

- **`flow` health gate**: consumes `health` exactly as today; hotspots feed it only via the score
  (`D-4`). No change to `flow`'s completion gate contract.
- **gdskills**: hotspot findings (when `hotspot-findings.ts` emission is enabled) are tagged with the
  owning skill via the existing `loadSkillOwnership` path, so `gdskills learn --from-health` can pick
  them up — consistent with how `complexity-findings.ts` is already consumed.
- **Block 0**: D2 instantiates the Capability Seam's four coordinated parts (`C0-3`) for
  `coverageMap`; both fixtures plug into Block 0's fixture-corpora acceptance harness (`F-1`).
- **No MCP** in Block D (that is Block A). No Asset Resolver, no optional dependency.

---

## 11. Hooks

- Reuse the existing testing hooks (`hooks.postCommitRefresh`, `hooks.prePushGate`) unchanged. The
  smoke tier and coverage-map selection apply automatically inside `testing run --changed` when a
  hook invokes it — no new hook type. Coverage-map staleness (gitRef mismatch) ⇒ fall back to static
  selection with a warn-once note (mirrors `C0-5` degrade-not-fail), never blocking a hook.

---

## 12. Standard Profile

Block D emits no new standard/portable artifact (that is Group A). It only enriches the existing
`health`/`testing` module artifacts. Docs update the roadmap index and this package per `DOC-1`.

---

## 13. Acceptance (summary; full list in `acceptance-criteria.md`)

- Hotspot ranking matches the seeded `churn/complexity` fixture; scores/gate unchanged at default
  weight; weighted run measurably escalates.
- Coverage-map selection precision > static on `change-impacted-test`; no-map ⇒ byte-identical static
  fallback; smoke tier runs on 100% of invocations; default (empty smoke, no map) is byte-identical;
  no-network sandbox opens no socket.

---

## 14. Phases

1. **P1 (D1, pure early win)** — `hotspot.ts` + `hotspotPenalty` (default weight 0) + scopes/report
   wiring + `churn/complexity` fixture. No behavior change at default; independent of Block 0.
2. **P2 (D2 core)** — `coverage-map.ts` (lcov + V8/bun parse), `selectByCoverageMap`, capability
   wiring (needs Block 0), `change-impacted-test` fixture, static-fallback equality test.
3. **P3 (D3)** — smoke tier union + config + cross-scope integration test.
4. **P4** — docs, roadmap index update, no-network sandbox + fixture-harness acceptance in CI.

---

## 15. Open Questions

See `prd.md` OQ-1 (recommended non-zero preset), OQ-2 (additive-schema bump vs `C0-7` byte-identical),
OQ-3 (file-level-only coverage acceptable when the runner emits no line data).
