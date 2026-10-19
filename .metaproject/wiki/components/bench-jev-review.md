# Module bench/jev-review

Version: 1.0.0
Type: component
Status: accepted

## Summary

`bench/jev-review` is the offline-first benchmark that asks whether the Jev client actually improves keryx's review pipeline. It builds a labelled dataset from the repository's own review history, runs each Jev-touching component with and without Jev, and reports accuracy, precision, noise, cost and wall-clock with n and confidence intervals next to every rate. It depends on `src/metrics` and on its own `bench/jev-review/adapters`.

## Overview

This module owns the evaluation of Jev, the typed "System One" decision client reached through OpenRouter, inside keryx's review pipeline. It answers one question with measured data rather than opinion: does the `with-jev` arm of each component find more real issues, or add noise and cost, compared with the `without-jev` arm. The benchmark is labelled by the repository's own history of acted-on and dismissed review findings, so its numbers describe this codebase, not a generic corpus.

## How it works

The module is a pipeline of four stages with one shared vocabulary in `types.ts`, so a renamed field fails to compile in every stage.

1. **Dataset** (`build-dataset.ts`). `buildDataset` walks every review package directory that has a `manifest.json`, then reduces each finding to a `DatasetFinding` and joins it to its flow's frozen acceptance criteria as a `DatasetFlowAc`. The output is a deterministic function of files on disk, except for `generatedAt`.
2. **Adapters** (`adapters/`). Each component implements the `ComponentAdapter` interface, which exposes an `available` flag and a `run(arm, ctx)` method. An unavailable adapter returns a `ComponentNotAvailable` result with a reason rather than a fake zero.
3. **Metrics** (`metrics.ts`). `computeMetrics` turns a `ComponentResult` into rates. It delegates interval maths to `deriveRate` in `src/metrics/benchmark`, so a rate with no trials stays unmeasured instead of reading as zero. `varianceReport` covers repeated runs and uses a seeded bootstrap so results are reproducible.
4. **Report** (`report.ts`). `formatRate` is the only place a rate is rendered. It always prints n and a 95% CI and marks a rate as anecdotal from its own denominator. Variance below five repeats is labelled as a plain range, not a bootstrap interval.

`run.ts` is the orchestrator that connects these stages. It is the only place that touches cost policy. Only live spend is recorded against the `CostCapTracker`, and an offline replay of the same component is used as the pre-flight estimate before any live call. The run writes `results-<date>.json` and `.md` only when the cap was never exceeded.

The honesty rules are encoded in code, not left to the reader. Labels come from one function, `labelFor`, and the report restates them rather than redefining them.

## Key concepts

- **Disposition** (`DispositionState`, `DispositionSource`). A finding's recorded outcome, such as `acted-on`, `dismissed-incorrect` or `unknown`. Its source is one of `record`, `report-closed-by`, `ledger` or `none`, and the builder resolves it in that precedence order.
- **Finding label** (`FindingLabel`, `labelFor`). `acted-on` becomes `true-positive` and `dismissed-incorrect` becomes `false-positive`. Every other state is `unlabeled`. Only the first two say whether a finding was right. Unlabeled findings are counted and reported but excluded from precision and recall denominators, so a scope dismissal cannot improve precision.
- **Dataset** (`Dataset`, `DatasetFinding`, `DatasetFlowAc`, `DatasetCounts`). The frozen input file. It holds findings with their PR and diff references, the flow's acceptance criteria and confirmation count, and a `problems` list for non-fatal build issues that are surfaced rather than dropped.
- **Arm** (`Arm`). Either `without-jev` or `with-jev`. Each component is run once per arm, and the two results are compared.
- **Prediction** (`ComponentPrediction`). A flag on one finding or case, with `correct` set to `null` when there is no ground truth. `computeAccuracy` refuses to produce a figure if any prediction is unscored.
- **Component result** (`ComponentResult`, `ComponentArmResult`, `ComponentNotAvailable`). A discriminated union on `available`, so an unavailable component cannot be mistaken for a measured one.
- **Usage** (`ComponentUsage`). Jev calls, input tokens, cost and wall-clock time for one arm.
- **Anecdotal threshold** (`ANECDOTAL_THRESHOLD_N`, set to 10). Any rate computed over fewer trials is labelled as an anecdote.
- **Variance** (`VarianceReport`, `bootstrapMeanCi95`). Spread across repeated with-jev runs.

Hand-labelled true positives (`addedTruePositives`) are `null` for every unattended run. A number appears only when a person has recorded a labelling pass, and nothing in this module produces one.

## Main flows

**Building the dataset.** `buildDataset` (in `build-dataset.ts`) collects package directories from `.metaproject/reviews/` and from each flow's `reviews/` folder. For each finding it tries four sources in order: the finding's own `disposition` record, a `closed by <sha>` marker in `report.md` (accepted only if that commit exists in this repository), the disposition ledger at `.metaproject/reviews/dispositions.json`, and finally `unknown`. Free-text evidence passes through `scrubIdentity` before it is written, because `dataset.json` is committed publicly. The result is sorted by id and written by `main`.

**Running the benchmark.** `main` in `run.ts` loads `dataset.json` or rebuilds it, then iterates over `registerAdapters()` and both arms. In live mode, `runComponent` first replays the component offline to estimate cost and calls `assertEstimateWithinCap`, then makes the real call. `CostCapTracker` records only live usage. A `CostCapExceededError` stops the run and prevents any output from being written. Afterwards, `computeMetrics` runs for each result. When `--repeat` is above 1, the with-jev arm is re-run to build a `VarianceReport`, but only for components that report accuracy. `buildReport` and `renderMarkdown` then write the results files.

**Reading a rate.** `formatRate` in `report.ts` prints a percentage with its own n and 95% CI. It appends `**anecdotal**` when that rate's denominator is below 10. Precision is computed only over flagged predictions whose correctness is known, so its denominator can be much smaller than the component's total case count.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `DispositionState`
- `DispositionSource`
- `FindingLabel`
- `labelFor`
- `DatasetDisposition`
- `DatasetFinding`
- `DatasetFlowAc`
- `DatasetCounts`
- `Dataset`
- `Arm`
- `ComponentPrediction`
- `ComponentUsage`
- `ComponentArmResult`
- `ComponentNotAvailable`
- `ComponentResult`
- `AdapterRunContext`
- `ComponentAdapter`
- `ANECDOTAL_THRESHOLD_N`
- `ComponentArmMetrics`
- `ComponentArmUnavailable`

### Key files

- `bench/jev-review/types.ts` - imported by 13, imports 0
- `bench/jev-review/metrics.ts` - imported by 4, imports 3
- `bench/jev-review/run.ts` - imported by 0, imports 6
- `bench/jev-review/report.ts` - imported by 2, imports 3
- `bench/jev-review/report.test.ts` - imported by 0, imports 4
- `bench/jev-review/build-dataset.ts` - imported by 2, imports 1

### Depends on

- `src/metrics` - 3 import(s)
- `bench/jev-review/adapters` - 1 import(s)

### Depended on by

- `bench/jev-review/adapters` - 4 import(s)

### Dependency basis

- Production imports only: 4 import(s) from test file(s) (e.g. `bench/jev-review/adapters/ci-triage.test.ts`) excluded from the two sections above in both directions.

### Module README

- Does Jev (TypeSafe "System One" on OpenRouter — typed `noul`/`choice` answers, `src/harness/decision/jev-client.ts`) actually improve keryx's review pipeline? This benchmark compares `without-jev` and `with-jev` arms of the pipeline's Jev-touching components on a labelled dataset built from this repository's own review history, and reports precision/recall/noise, cost and wall-clock, with honest c (from module README)

### Graph signals

- Files: 11
- Cross-module imports: 4

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/metrics](src-metrics.md)
- [Module bench/jev-review/adapters](bench-jev-review-adapters.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
