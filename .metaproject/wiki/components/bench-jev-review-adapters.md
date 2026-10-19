# Module bench/jev-review/adapters

Version: 1.0.0
Type: component
Status: accepted

## Summary

`bench/jev-review/adapters` groups 7 file(s). Depends on `bench/jev-review`. Exposes 3 public symbol(s).

## Overview

`bench/jev-review/adapters` holds the per-component adapters that the jev-review benchmark runs. Each adapter wraps one reviewed component (CI triage, review conformance, or a placeholder for a component still in flight) and reports its result for two arms: a `without-jev` baseline and a `with-jev` run of the real CLI. The module also owns the registry that fixes the order of components in the benchmark report.

## How it works

The module is flat: one registry plus one file per component, all implementing the `ComponentAdapter` contract imported from `../types`. Each adapter has an `id`, an `available` flag and a `run(arm, ctx)` method that returns a `ComponentResult`.

`registry.ts` exports `registerAdapters()`, which returns the adapters in report display order. Available components come first, so a reader reaches the real numbers before the placeholders. The file comment says the benchmark runner iterates this list (the runner itself is outside this module).

`ci-triage.ts` and `review-conform.ts` are the two real adapters. They differ in how they reach Jev:

- `ci-triage.ts` (`ciTriageAdapter`) uses a synthetic `without-jev` comparator. It flags every failing job as a real regression, the conservative escalate-everything default, and scores that against the truth labels in the eval manifest (`CI_TRIAGE_EVAL_MANIFEST`). The `with-jev` arm spawns `bun` against the CLI in the current worktree, running `review ci-triage --eval` with `--json` and, only when live, `--live`. Offline runs replay committed fixtures, and they inject a placeholder `OPENROUTER_API_KEY` so they never depend on the ambient credential.
- `review-conform.ts` (`reviewConformAdapter`) runs `review conform` against committed fixtures in both arms. It runs from a separate fixtures project, so the conformance flag is not enabled for the whole repository. The `without-jev` arm marks every clause `not-evaluated`. The `with-jev` arm counts `likely-violated` clauses as candidate findings.

`not-available.ts` builds placeholder adapters through a shared `notAvailableAdapter` factory. It covers flow 328 (`flowCheckAcAdapter`), flow 330 (`reviewJevRulesAdapter`) and the later severity-calibration work (`severityCalibrationAdapter`). Each one reports `available: false` with a reason for both arms and never invokes a CLI, so the module has no code dependency on those flows.

## Key concepts

- **ComponentAdapter**: the unit the benchmark runs. It has `id`, `available`, an optional `unavailableReason`, and `run(arm, ctx)`.
- **Arm**: `without-jev` is the baseline and `with-jev` is the run through the Jev CLI. Both arms produce a result for the same component, so they can be compared.
- **ComponentResult**: either a `ComponentArmResult` or an unavailable result that carries only a `reason`. The unavailable form is how placeholder adapters report that a component has not landed yet.
- **ComponentPrediction**: one scored item, with `id`, `flagged` and `correct`. `correct` is `null` when there is no truth label (conformance).
- **Usage**: `jevCalls`, `inputTokens`, `cost` and `wallClockMs` for an arm. The `ci-triage` adapter estimates `jevCalls` as two per case so the cost-cap pre-flight does not under-count.
- **addedTruePositives**: a hand-labelled count. Both real adapters set it to `null`, because an unattended run cannot label findings. Conformance candidates appear only as a note.
- **AdapterRunContext**: `root`, `cliPath`, `bunPath` and `live`. `live` selects real `gh` and Jev calls over the offline fixtures.
- **Eval manifest and fixtures**: committed under `src/commands/fixtures/` (`ci-triage-eval` and `conform`). The offline benchmark is hermetic because it replays these files.

## Main flows

1. **Registry to report.** `registerAdapters()` in `registry.ts` returns five adapters: `ciTriageAdapter()`, `reviewConformAdapter()`, `flowCheckAcAdapter()`, `reviewJevRulesAdapter()` and `severityCalibrationAdapter()`. The runner calls `run(arm, ctx)` on each one for each arm. The three placeholders return unavailable results immediately.

2. **CI triage, `with-jev` arm.** `ciTriageAdapter().run` calls `withJev`, which calls `runEval`. That spawns `bun` with `review ci-triage --eval <manifest> --json`, adding `--live` only when the context is live. The JSON result is mapped to predictions with `flagged: true` and `correct` taken from `correctAfter`. `cost` comes from `after.costUsd`. The `without-jev` arm skips the subprocess and runs `naiveBaseline`, which reads the same manifest.

3. **Review conformance, both arms.** `reviewConformAdapter().run` calls `runConform` once, spawning `review conform --ref invented-ref.md --pr 999 --fixtures <dir> --json` from `bench/jev-review/fixtures/conform-project`. It then calls `toResult` for the requested arm. The `without-jev` arm marks each clause `flagged: false`. The `with-jev` arm marks each `likely-violated` clause `flagged: true`, and records the count as a note with `addedTruePositives` left `null`.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `registerAdapters`
- `CI_TRIAGE_EVAL_MANIFEST`
- `ciTriageAdapter`

### Key files

- `bench/jev-review/adapters/registry.ts` - imported by 2, imports 4
- `bench/jev-review/adapters/ci-triage.ts` - imported by 2, imports 1
- `bench/jev-review/adapters/not-available.ts` - imported by 2, imports 1
- `bench/jev-review/adapters/registry.test.ts` - imported by 0, imports 3
- `bench/jev-review/adapters/review-conform.ts` - imported by 2, imports 1
- `bench/jev-review/adapters/ci-triage.test.ts` - imported by 0, imports 2

### Depends on

- `bench/jev-review` - 4 import(s)

### Depended on by

- `bench/jev-review` - 1 import(s)

### Dependency basis

- Production imports only: 3 import(s) from test file(s) (e.g. `bench/jev-review/adapters/ci-triage.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 7
- Cross-module imports: 4

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module bench/jev-review](bench-jev-review.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
