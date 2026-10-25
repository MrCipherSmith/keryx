# Learn Probe Metrics and Validation
Version: 0.2.0

## What is measured

One probe compares two arms of the same task:

- `base` — the pinned read-only context-on baseline, without pattern injection;
- `probe` — the same harness plus the pattern's `trigger`/`action` as the only
  difference.

Per arm, per seed: whether the final answer line names the expected file and
symbol, tokens reported by the provider, tool calls. Per arm, aggregated: success
rate, Wilson interval, totals. Across arms: delta rate and its Newcombe interval.

These are outcome metrics. Probe deliberately does not measure "did the agent
mention the pattern" — an agent that follows an instruction and still fails has
not been helped, and an agent that succeeds without naming the pattern has been.

## Acceptance matrix

| Fixture class | Assertion | AC |
|---|---|---|
| Help surface | Every flag in the specification is listed, exit 0 | AC1 |
| Dry run | Plan printed, zero bytes written, no worktree, no turn | AC2 |
| No budget | Refused with named reason, exit 2 | AC3 |
| No terminal | Refused with named reason, exit 2 | AC4 |
| Completed probe | Plan/checkpoint/comparison valid, worktrees removed | AC5 |
| Improvement | One reinforcement item, weight 1.0, confidence follows `applyEvidence` | AC6 |
| Regression | One contradiction item, weight 1.5 | AC7 |
| Inconclusive | No item, confidence unchanged, comparison still written | AC7 |
| Gold answer reachable | `unmeasurable` / `gold-leak`, exit 3, no evidence | AC8 |
| Status immutability | `status` unchanged; only evidence/confidence/level/updatedAt differ | AC9 |
| Interrupted re-run | Resumes and reuses completed seeds when environment/runs match | AC10 |
| Completed re-run | Finalized marker required for refusal; pending comparison recovers without models | AC10 |
| Mismatched resume | Refused with `probe-environment-mismatch`, exit 2, nothing written | AC18 |
| Write boundary | No import path reaches a skill/rule/agent writer | AC11 |
| Decision commands untouched | Router-only dispatch allowed; decision modules/routing unchanged | AC12 |
| One variable per arm | Environments identical, harness diff is exactly the pattern | AC13 |
| Underpowered | Stochastic task at 2 seeds is `unmeasurable`, never `indistinguishable` | AC14 |
| Verdict table | Exactly one verdict per input, covering all six reasons | AC15 |
| Crash and interrupt | Graceful cleanup/run-failed; uncatchable death reconciles on resume | AC16 |
| Transcript retention | Cap deletes only finalized `runs/`, keeps plan/checkpoint/comparison | AC17 |

Every row is a unit or integration test with a fixture, not a live model run. The
live runs are the outcome measurements below, and they are not CI gates.

## Statistical honesty

- Three seeds per arm is the floor, not a target. With three seeds the minimum
  detectable difference is large; most real patterns will resolve to
  `indistinguishable`. That is the intended, honest result: an underpowered run
  must not manufacture confidence.
- The verdict is a statement about **this task**, not about the pattern's general
  value. The PRD says so, and the comparison artifact records `taskId` so a
  reader cannot mistake one probe for a general result.
- `unmeasurable` is never converted into `indistinguishable`. The two mean
  different things: "no detectable difference" versus "this run could not answer
  the question".
- No p-value hunting: the verdict is the pre-declared interval rule of
  specification §7 (the acceptance criteria are §9), not a threshold chosen after
  looking at the data.

## Falsification criteria

This package claims that probing improves decision quality. Three observations
would falsify that claim, and all three are looked at in the first review after
release:

1. **No discrimination.** Ten recorded probes in a row resolve to `improved`.
   A task set that cannot produce a `regressed` or `indistinguishable` result is
   not measuring anything.
2. **No disagreement with the human.** If probes never change a decision, the
   measurement is cost without value. Not measured — the accept decision log
   (`decisions.jsonl`) records `{action, id, scope, actor, tty, at}` and has no
   field for whether a probe influenced the choice; adding one is out of scope
   for this package.
3. **Probe instability.** Equivalent measurements in a maintainer-controlled
   repeated-measurement study yield incompatible verdicts. Production finalized
   IDs refuse rerun; use isolated fixture stores, never overwrite comparisons.
   Not measured — runtime has not shipped.

## Cost accounting

A probe is `2 × seeds × one agent turn`. Load effective operator pricing with
`loadModelProfiles()[profileKey(provider, model)]` from
`src/harness/routing/model-profile.ts`. priceInputPerMillion/priceOutputPerMillion
contain a numeric value or explicit unknown string (not a nullable price).
Estimate `2 * seeds * (medianInput * priceIn + medianOutput * priceOut) / 1e6`
using observed per-turn medians, or unknown/null when prices/observations are
missing. Historical tokens do not substitute for a missing dollar price.
The adapter supplies pricing to core without a forbidden core-to-harness import.
Actual usage/cache billing follows the reference `estimateTaskCostUsd` in
`src/tui/tui-shell.ts`, not a TUI import; input/output counts and per-provider
cache multipliers matter for chargedUsd/spendUsd. Unknown estimates never waive
explicit budget or durable reservations (§6.5); bounded conservative charges or
a safe stop are new runner obligations, not provided by today's turn helper.

Reports from a probe never enter `keryx metrics` benchmarks: those are model- and
harness-level ladders with their own paired protocol, and folding probe results
into them would mix a per-pattern decision aid with a product-level claim.

## What is not validated here

- Whether a pattern that passes probes generalizes to other tasks. That needs a
  held-out set, which v1 does not define.
- Whether the confidence formula's constants are right for probe evidence. They
  are reused unchanged, so the question stays where W3 already put it.
- Whether the selected task set is representative of the user's work. v1 ships
  tasks that are read-only and objectively checkable; representativeness is a
  curation problem, not a code problem.

## Additional recovery and validation fixtures

| Fixture | Assertion | AC |
|---|---|---|
| Invalid budget/task-set/arguments | Named exit-2 refusal, zero writes | AC3, AC19 |
| Edited text/hash collision | No stale seed reuse or overwrite | AC20 |
| Crash after each durable write, concurrency | One append and confidence change; locked current value | AC21 |
| Drift before/after publication | Unmeasurable before; immutable comparison plus separate skipped after | AC22 |
| Durable running/completed checkpoints | No blind paid replay, cumulative reservations/spend | AC23 |
| JSON stream capture | Exactly one envelope; plan/confirmation/diagnostics stderr | AC24 |

The local schema/example checker is [examples/validate.ts](examples/validate.ts).
It verifies document shapes and selected linkage/arithmetic invariants only;
it does not implement or prove runtime ACs. Actual runs/transcripts remain on
partial failure, but all unmeasurable arms/delta are null. Pre-run failures have
runs=[]. Plan/checkpoint are kept by retention; unfinished probes are skipped.

Baseline confidence: graph reports moved repo/new paths; health last ran
2026-09-09. Refresh impact/health before runtime acceptance. Ablation worktree and
context-on conventions are reusable; base-ref existence checks, signal handling,
usage checkpoints and resume/finalization plumbing are new implementation work.
