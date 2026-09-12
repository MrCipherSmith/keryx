# Improving the arena itself

Written 2026-09-12 from running it: what the harness got wrong, what it made
expensive, and what it cannot yet answer. Separate from
[`improvement-proposals.md`](improvement-proposals.md), which is about keryx and the
workspace rather than the measuring instrument.

Ordered by how much each one distorts or blocks a result.

## 1. Fix the cost metric before quoting any cost conclusion (K-018)

`parseStream` (`scripts/benchmark/retrieval-agent-claude.ts:185-190`) assigns
`contextTokens` from the final `result` event's `usage` — the main thread — while
`costUsd` comes from `total_cost_usd`, which covers the whole session. An agent that
delegates therefore reports a fraction of what it read: claude's control arms hid
9.51M sub-agent tokens and appeared 4.2× cheaper than the context arms, when the
honest ratio is ~1.26× and the dollar ratio is 1.11×.

Fix: sum usage across every turn and every sub-agent result, or derive the threshold's
cost condition from `total_cost_usd` alone. Record sub-agent count and sub-agent
tokens as their own columns, so a delegating arm is visible rather than merely cheap.

## 2. Settle per arm, not per task (K-017)

`settledKeys` treats a task as done only when every arm has a result or a failure. A
run killed between two arms therefore re-runs the arm that already succeeded: paid
work repeated, and `results.jsonl` grows a duplicate row that a naive read counts
twice. Every analysis now has to de-duplicate by `(harness, task, arm)`.

Fix: skip an arm that already has a row and run only its missing partner.

## 3. The watchdog ceiling decides results

Three of ten keryx pairs were lost because the control arm hit the 900 s ceiling —
always the control arm, never the context arm. That is not a neutral loss: it removes
exactly the tasks where the arm without the workspace was working hardest, which
biases the comparison in the workspace's favour on any metric computed over pairs.

Fix: raise the ceiling for T1, or record a ceiling kill as a scored zero rather than a
dropped pair, and report how many pairs each arm lost to it. Decide this before the
sweep, not after seeing which way it cuts.

## 4. Isolation is a detector, not a boundary

The transcript fence catches an arm that *names* what it touched. An arm that reaches
the network without naming a path, or reads a file it never mentions, is invisible to
it. The fence has already produced one false positive (an arm's own tree at the end of
a sentence) and one class of true positives worth the whole exercise (an arm using the
operator's `gh` login to fetch the answer PR).

Fix, in order of cost: keep the arena's output directory and every previous run out of
`/tmp` — an arm that finds an earlier `results.jsonl` has found the answer key; then
run each arm in a container with no home, no `/tmp` and network only to the model API.
Keep the fence afterwards as the check that the boundary held.

## 5. T1 cannot answer the question that matters

"Name the files this change will touch" measures retrieval. Both legs score about a
third of the gold files in both arms, and the workspace moves that by one file out of
28. The workspace is built for architecture, decisions and blast radius — none of
which T1 exercises.

Fix: finish T2 — implement the change, hidden tests fail before and pass after. It is
the only task type where "the agent understood the codebase" and "the agent produced
a working change" are the same measurement. `arena-judge.ts` exists and is tested
against a scripted model; it needs a real judge model, both presentation orders, and
the calibration probe honoured.

## 6. Scoring hides the difference between wrong and refused

An arm that answers three plausible files and misses the gold scores the same zero as
an arm that says "I cannot determine this reliably". In the earlier contaminated batch
claude refused outright on three tasks; that is a different failure with a different
fix, and the score cannot see it.

Fix: record a refusal as its own outcome. Also consider partial credit weighted by how
central a file is to the change — naming the store and missing its test is not the
same as naming neither.

## 7. Gold sets need a stated rule

The gold set is "files the real commit touched", which includes test files, fixtures
and sometimes unrelated drive-by edits in a squash. An agent that names the source
file and not its `.msw.ts` fixture is marked wrong on a judgement call nobody wrote
down.

Fix: state the rule per task type — source only, or source plus tests — and record it
in the task file, so a later disagreement is about the rule rather than the score.

## 8. Long sweeps need to survive the machine

This sweep was killed five times by the OS for low memory, once mid-arm. Resume works
(see item 2 for the one case where it does not), but each kill costs the arm in flight
and needs a human to notice.

Fix: a supervisor that restarts the runner on a non-zero exit and records the
interruption in the run log, so the sweep's wall-clock and cost stay attributable.

## 9. Record what the run ran on

The comparison is between arms, so drift within a run matters more than absolute
numbers, and arm order already alternates for that reason. Not yet recorded: the CLI
versions, the model snapshot each vendor served, and the machine's state. A sweep that
straddles a vendor model rollout has no way to notice it afterwards.

Fix: capture CLI versions and any model id the transcripts report into the run's own
metadata, beside `results.jsonl`.

## 10. Make the verdict machine-readable

The verdict exists only as a line in the runner's stdout. Every analysis so far has
been a one-off script over `results.jsonl`, and the numbers in a write-up are only as
good as the script that produced them.

Fix: write `verdict.json` beside the results — per leg: paired tasks, recall each arm,
tokens each arm, cost each arm, sub-agents each arm, arms lost to the ceiling, and the
threshold decision. Then a report is a rendering, not a re-derivation.
