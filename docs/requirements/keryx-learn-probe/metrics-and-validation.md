# Learn Probe Metrics and Validation
Version: 0.1.1

## What is measured

One probe compares two arms of the same task:

- `base` — the record's own harness, unmodified;
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
| Completed probe | Both artifacts valid, worktrees removed | AC5 |
| Improvement | One reinforcement item, weight 1.0, confidence follows `applyEvidence` | AC6 |
| Regression | One contradiction item, weight 1.5 | AC7 |
| Inconclusive | No item, confidence unchanged, comparison still written | AC7 |
| Gold answer reachable | `unmeasurable` / `gold-leak`, exit 3, no evidence | AC8 |
| Status immutability | `status` unchanged; only evidence/confidence/level/updatedAt differ | AC9 |
| Interrupted re-run | Resumes and reuses completed seeds when environment/runs match | AC10 |
| Completed re-run | Refused with `probe-already-completed`, exit 2, comparison byte-identical | AC10 |
| Mismatched resume | Refused with `probe-environment-mismatch`, exit 2, nothing written | AC18 |
| Write boundary | No import path reaches a skill/rule/agent writer | AC11 |
| Decision commands untouched | No import edge into probe; their suites pass unchanged | AC12 |
| One variable per arm | Environments identical, harness diff is exactly the pattern | AC13 |
| Underpowered | Stochastic task at 2 seeds is `unmeasurable`, never `indistinguishable` | AC14 |
| Verdict table | Exactly one verdict per input, covering all six reasons | AC15 |
| Crash and interrupt | No worktree left; comparison written with `run-failed` | AC16 |
| Transcript retention | Cap deletes only `runs/`, keeps plan and comparison | AC17 |

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
3. **Probe instability.** The same probe id re-run at the same commit yields
   different verdicts. That means the statistic is noise; the runner must be
   fixed or the task set replaced before the command is recommended.

## Cost accounting

A probe is `2 × seeds × one agent turn`. The estimate printed by `--dry-run` is
`2 × seeds × median tokens per turn for the selected model × provider price`,
falling back to a token count from the last recorded probe when no price table is
available. With no price data the estimate is reported as `unknown` and the run
still requires `--max-usd` — an unknown estimate is a reason to raise the ceiling
consciously, not a reason to skip it.

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
