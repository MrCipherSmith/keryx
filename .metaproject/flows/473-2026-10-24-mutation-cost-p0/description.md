# Cheaper mutation pass: early exit on red, run provenance, timing in the record

Status: formalized
Source: user description (origin: human-request)
Analysis basis: `~/arena/ideas/keryx-mutation-cost/` (README.md, requirements.md, bailprobe log); not in git. Numbers below were recomputed on origin/main 0.3.130, not copied.

## Problem

The attended mutation pass (`keryx review mutate`) is the most expensive step of a review round. On the 73 recorded passes in `.metaproject/flows` (6 flows, 13-22 Oct 2026): 598 min for 1956 mutant runs; killed mutants took 394 min, survivors 149, timeouts 28. 99.9% of that time went through plain `bun test <paths>` commands, and none of the 73 commands carried `--bail`, so a mutant that turns the first test red still waits for the rest of the suite. 50% of the runs (313 min) repeat a mutant already run in the same package, but 28% of those repeats changed status, so reuse cannot be switched on blind: the record does not say whether the code changed between runs, nor how loaded the machine was, nor how long the tree copy took.

## Expected Outcome

- `keryx review mutate` stops a plain `bun test` run at the first red test when it judges a mutant. A mutant is `killed`, `survived`, `timeout` or `invalid` exactly as before; the baseline still runs in full.
- Every new `mutation-<n>.json` and `.md` says what the next measurement needs: when the pass started, on which commit and tree state, the load average, the copy time, the total mutant time, and whether `--bail` was applied.
- Old records still read everywhere.

## Outcome criteria

- Запрос (дословно): «максимально оптимизировать» (source: operator helyx 221734 and 221759 (fragment as quoted in arena/ideas/keryx-mutation-cost/README.md; the full message was not re-read))
- Эффект (формализация агента): a mutant that a test kills costs the time to the first red test, not the time of the whole suite; the cost of the pass becomes readable from its record.
- Как наблюдать (предложение агента): replay a sample of recorded mutants with and without `--bail`: same status for each, killed-mutant time at most half. Then read `bail`, `copyMs`, `mutantsMs`, `loadavg` in the next real `mutation-<n>.json`.

## Out of Scope

- R2 of the analysis (two-stage test selection) and R3 phase 2 (reusing earlier results): separate flows, after this one produces data. The record gets no `reused` and no stage fields here.
- Narrowing `mutant_candidates`, the cap policy default (D2), the coverage gate, severity-audit, `scripts/mutation-sweep.ts`, the reviewer's own mutation pass (layer 1).
- Commands other than plain `bun test ...`: they run as before.
