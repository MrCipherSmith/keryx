# Module src/security/eval

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/security/eval` groups 2 file(s). Depends on `src/security`, `src/security/detect`, `src/lib`. Exposes 15 public symbol(s).

## Overview

`src/security/eval` is the red-team evaluation harness for Keryx's security detectors. It owns the full pipeline for measuring detector quality: loading labeled corpus fixtures, running them through a configurable detect function, computing per-detector false-negative rates, gating results against committed ceilings, and producing a deterministic, git-diffable plaintext report. The module is consumed by the `src/commands` layer (one import) and depends on `src/security` for configuration and `src/security/detect` for the actual detection pipeline.

## How it works

The module is built around a single file, `harness.ts`, with no sub-layers. The design separates three concerns: data loading, metric aggregation, and quality gating.

Data loading is handled by `loadEvalCases`, which reads `cases.json` from a corpus directory and normalises it into a sorted, validated array of `EvalCase` objects. The sort on case `id` is deliberate: it makes the accumulated report stable regardless of filesystem order. `loadThresholds` applies the same defensive pattern to `fixtures/thresholds.json`, accepting either a flat record or a wrapped `{ thresholds: ... }` shape.

Metric aggregation happens in `runEval`, which iterates corpora, runs each case through the injected `DetectFn`, and accumulates true/false positive and negative counts per detector name. The `firedFor` helper decouples matching from aggregation: a case "fires" if any `DetectorMatch` carries a `policyId` or `category` equal to the labeled detector, so corpus fixtures can label at either granularity. The resulting `EvalReport` carries per-detector `fnRate` values computed as `falseNeg / positives`.

Quality gating is a pure, stateless function (`gateEval`) that compares each detector's `fnRate` against its committed ceiling from the thresholds table. Detectors with no ceiling entry default to 0, preventing silent regressions from unlisted detectors. `formatEvalReport` serialises the report to a fixed-width plaintext table with no timestamps or absolute paths, so a re-run on unchanged fixtures produces an identical string and shows no diff.

The `pureDetect` factory wires the module to the shipped deterministic pipeline (`runDetectors` from `src/security/detect`), but the `DetectFn` interface is intentionally abstract, allowing callers to inject model-augmented or stubbed backends for testing.

## Key concepts

- **EvalCase** — a single labeled test input: an `id`, the raw `input` string, an `expected` outcome (`"positive"` or `"negative"`), and the `detector` name under test.
- **DetectFn** — the injectable detection interface: takes an input string and returns `DetectorMatch[]` (from `src/security/types`). The default implementation is `pureDetect`, which delegates to `runDetectors` with the workspace config.
- **DetectorEval** — per-detector aggregated metrics: `truePos`, `falseNeg`, `falsePos`, `trueNeg`, and the derived `fnRate` (false-negative rate).
- **EvalReport** — the full run result: which corpora were seen, total case count, and the sorted `DetectorEval` array.
- **Thresholds / ThresholdEntry** — the committed quality ceiling table, keyed by detector name; each entry carries `maxFnRate`. An absent entry implies a ceiling of 0.
- **GateResult** — the pass/fail verdict from `gateEval`, carrying human-readable `reasons` for each violation.
- **DEFAULT_CORPORA** — the canonical set of corpus families: `injection`, `exfil`, `structured-pii`, and `secret`.

## Main flows

**1. Standard eval run (pure detector path)**
A caller (typically a CLI command in `src/commands`) invokes `pureDetect(cwd)` to obtain a `DetectFn` bound to the workspace security config. It then calls `runEval({ fixturesRoot, corpora: DEFAULT_CORPORA, detect })`. Inside `runEval`, `loadEvalCases` reads each corpus directory's `cases.json`, validates and sorts entries, and returns `EvalCase[]`. For each case, `detect(input)` is called and `firedFor` maps the resulting `DetectorMatch[]` to a boolean. Counts accumulate per detector name. `runEval` returns an `EvalReport` with sorted detectors and computed `fnRate` values.

**2. Quality gate check**
After obtaining an `EvalReport`, the caller loads `fixtures/thresholds.json` via `loadThresholds`. It then calls `gateEval(report, thresholds)`, which iterates each `DetectorEval` and compares its `fnRate` against the committed ceiling (defaulting to 0 for unlisted detectors). The returned `GateResult` has `status: "pass"` or `"fail"` with a list of human-readable violation strings. A non-empty `reasons` array means at least one detector has regressed beyond its committed ceiling.

**3. Deterministic report serialisation**
`formatEvalReport(report, thresholds)` produces a fixed-width plaintext table ordered by detector name, with each row showing positives, TP, FN, FP, fnRate, ceiling, and pass/fail status. Because the report contains no timestamps or absolute paths and cases are sorted by `id` before aggregation, two consecutive runs on identical fixtures produce an identical string — a re-run diff is empty and a regression appears as a reviewable text change.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `EvalCase` (interface)
- `DetectorEval` (interface)
- `EvalReport` (interface)
- `DetectFn` (interface)
- `ThresholdEntry` (interface)
- `Thresholds`
- `GateResult` (interface)
- `DEFAULT_CORPORA`
- `loadEvalCases` (function)
- `firedFor` (function)
- `pureDetect` (function)
- `runEval` (function)
- `loadThresholds` (function)
- `gateEval` (function)
- `formatEvalReport` (function)

### Key files

- `src/security/eval/harness.ts` - imported by 2, imports 3
- `src/security/eval/harness.test.ts` - imported by 0, imports 3

### Depends on

- `src/security` - 2 import(s)
- `src/security/detect` - 2 import(s)
- `src/lib` - 1 import(s)

### Depended on by

- `src/commands` - 1 import(s)

### Graph signals

- Files: 2
- Cross-module imports: 5

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/security](src-security.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.0 - Prose enriched by gdwiki enrich workflow: Overview, How it works, Key concepts, Main flows written from harness.ts and harness.test.ts.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
