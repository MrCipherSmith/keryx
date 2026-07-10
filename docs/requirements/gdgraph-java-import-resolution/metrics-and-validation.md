# Metrics & Validation — gdgraph Java/Python Import Resolution

Version: 1.0.0

## The metric bug this package must fix

gdgraph currently reports `Import resolution: 100%` for a graph with **0 edges**.
The code is `importTotal > 0 ? imports/importTotal : 100` with
`importTotal = imports.length + unresolved.length` (build.ts). Because
non-relative Java/Python imports are dropped rather than recorded as
`unresolved`, `importTotal` is `0` and the explicit `: 100` branch fires. This is
a false success signal: a downstream agent read `100%` and reported "full Java
support activated" while the dependency graph was empty.

Fix: compute over **all extracted specifiers**, and define
`rate = extracted === 0 ? n/a : resolved / extracted`. `n/a` (or an explicit
`0 edges`) must be shown when nothing was extracted.

## Baseline (measured 2026-07-10, `back4/example-backend`)

| Metric | Baseline |
|---|---|
| Nodes | 3733 (3732 java, 1 js) |
| Import edges | 0 |
| Unresolved edges | 0 (dropped, not recorded) |
| Reported resolution | 100% (false — `0/0`) |
| Real resolution | 0% |

## Target metrics

| Metric | Target |
|---|---|
| Java import edges on example-backend | > 0 (expected: thousands) |
| Resolvable in-repo imports resolved | ≥ 80% |
| Reported rate vs. real rate | equal; `n/a` at 0 extracted |
| TS/JS graph diff on TS/JS-only repo | byte-identical (0 changes) |
| New-project grammar seeding | java + python present in `assets.lock.json` after `init` |

## Validation plan

1. **Unit** — Maven `pom.xml` source-root parse (single + multi-module);
   Gradle `sourceSets` parse (Groovy + Kotlin DSL); Java FQN→path mapping;
   Python absolute + relative + `__init__.py` mapping.
2. **Build-level fixtures** — a minimal Maven Java project and a Python package
   under test fixtures; assert `imports` edges are produced (this is the test
   class that is currently missing and would have caught the `0 edges` regression).
3. **Metric** — assert `0 extracted → n/a`; assert non-relative unresolved import
   yields an `unresolved` edge, not a dropped one.
4. **Regression** — build a TS/JS-only fixture before/after; assert
   byte-identical `nodes.jsonl`/`edges.jsonl`.
5. **End-to-end** — run `keryx gdgraph build` on `back4/example-backend`; assert
   `edges > 0` and a plausible resolution rate; spot-check a known import
   (e.g. `com.example.admin.dto.FixReplicaRequest` →
   `src/main/java/com/example/admin/dto/FixReplicaRequest.java`).

## Honesty guardrail

Any reported "language support" claim must cite `edges > 0` from the built graph,
not the resolution-rate percentage alone. A percentage derived from zero
denominators is not evidence of resolution.
