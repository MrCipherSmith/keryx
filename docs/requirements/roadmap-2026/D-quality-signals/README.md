# Block D — Quality Signals (`health` + `testing`)

**Status:** Draft / ready-for-implementation
**Version:** 1.0.0
**Date:** 2026-07-07
**Mode:** `task_in_project` — extends the existing gd-metapro; does NOT re-spec shipped modules.
**Language:** English (per this block's task directive; note DOC-4 marks `health` as RU — see Concerns in the orchestrator return).

---

## Purpose

Block D adds two **deterministic, local, dependency-free** quality signals on top of the
shipped `health` and `testing` modules:

- **D1 — Git-churn × complexity hotspot signal.** A CodeScene-style *behavioral* metric
  that ranks files that are BOTH churning (git activity) AND complex. It reuses the
  existing `getChurn()` (`git log --numstat`) and the existing per-function complexity
  from `source-analysis.ts` — **no new dependency, no network**. It becomes a **new,
  additive input** to the normalized health score and feeds the same `flow` health gate.
  D1 is the **pure early win** of this block (no capability seam wiring, no asset).
- **D2 — Dynamic (coverage-map) Test Impact Analysis for `testing`.** An opt-in
  test-to-code **coverage map** so changed-scope selection matches which tests actually
  cover the changed lines/files — more precise than today's static changed-file/naming
  heuristic. Ships an **always-on smoke tier** that runs on every invocation. The
  existing static changed-file selection stays the **deterministic default/fallback**
  whenever no coverage map exists.

Everything in Block D is deterministic and reproducible. With no coverage map and default
config, `health` and `testing` behave **byte-identically** to today (no new dep loaded,
no socket opened) — the package-wide gate `C0-7`.

## Scope at a glance

| In scope | Out of scope (see `prd.md` Non-Goals) |
|----------|----------------------------------------|
| D1 hotspot metric (churn × complexity), ranking, additive score/gate input | SaaS/hosted code-quality service (NG-D1) |
| D2 coverage-map TIA: build/import map, intersect changed lines→tests | Replacing the normalized multi-tool health score (NG-D2) |
| D3 always-on smoke tier composed with scoped selection | Mandatory coverage instrumentation on the default path (NG-D3) |
| Static changed-file selection preserved as default/fallback | A new/bespoke test runner (NG-D4) |

## Dependency on Block 0 (hard)

Block D **cannot start** until **Block 0 — Capability Seam** lands, because D2's opt-in
must instantiate the four coordinated parts (`C0-3`): an `init` flag, a `metaproject.json`
manifest capability entry, a config toggle deep-merged over defaults, and a fallback
contract (map absent ⇒ deterministic static selection). D also reuses Block 0's
**fixture-corpora acceptance harness** (`F-1`) for its two corpora.

Notes specific to D:
- **D introduces NO optional runtime dependency** (architecture §5). D1 and D2 are pure
  git + coverage-artifact parsing, so `package.json` `optionalDependencies` is not exercised
  and the **Asset Resolver is not used** (the coverage map is a locally-derived artifact,
  not a downloaded model/grammar asset).
- D2's "opt-in" is therefore only: *config toggle + presence of a coverage map*. When the
  map is absent, selection is byte-identical to today (`D-2`, XP2).

## How to run (via flow)

Block D is implemented as a managed gd-metapro flow. Task breakdown is in
[`tasks.md`](./tasks.md); acceptance gates are in [`acceptance-criteria.md`](./acceptance-criteria.md).

```bash
# 1. Ensure Block 0 is complete (capability seam + fixture harness present).
# 2. Open the managed flow for this block:
gd-metapro flow init --title "Block D — Quality Signals (health + testing)" \
  --spec docs/requirements/roadmap-2026/D-quality-signals

# 3. Work tasks T1..Tn (tasks.md); each maps to flow tasks with AC.
gd-metapro flow task add <id> --title "T2: hotspot metric (churn × complexity)"
# ... implement, confirm ACs, attach PR, pass the health gate:
gd-metapro flow complete <id>

# 4. Demo the signals:
gd-metapro health run                 # hotspot ranking now in the report + hotspots artifact
gd-metapro testing coverage-map build # build/import the coverage map (opt-in)
gd-metapro testing run --changed      # coverage-map TIA + always-on smoke tier
gd-metapro testing run --changed      # with no map present: byte-identical static fallback
```

## Links

- [`prd.md`](./prd.md) — problems, goals, metrics, non-goals, user/agent stories.
- [`specification.md`](./specification.md) — hotspot formula and how it enters the score/gate;
  coverage-map TIA (map format, selection algorithm, smoke tier, static-fallback contract).
- [`acceptance-criteria.md`](./acceptance-criteria.md) — hard AC1..ACn.
- [`tasks.md`](./tasks.md) — atomic T1..Tn with kinds and dependencies (incl. Block 0).
- Upstream artifacts: `problem-statement.md` (Group D), `architecture.md` (§5 Group D,
  §6 fixtures), `tech-bestpractices.md` (§5 Group D constraints D-1..D-7).
- Existing seams reused: `src/health/metrics/churn.ts:getChurn`,
  `src/health/source-analysis.ts:analyzeSourceFiles`, `src/health/scoring.ts:healthScore`,
  `src/health/scopes.ts:computeMetrics`, `src/health/gate.ts:computeGate`,
  `src/testing/service.ts:selectChangedTests`, `.metaproject/testing.config.json`,
  `.metaproject/health.config.json`, `.metaproject/metaproject.json`.
