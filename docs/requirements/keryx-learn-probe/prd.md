# Learn Probe PRD
Version: 0.2.0

## Problem

The W3 self-learning loop turns repeated signals into learned patterns and raises
`confidence` by a fixed formula (`src/learning/confidence.ts`). Nothing in that
loop observes whether a pattern changes what an agent does. A pattern can
therefore climb to `high` confidence and graduate into a skill purely because the
same event was seen twice — the risk the W3 spec itself names as "volume without
signal" and "confidence gaming".

The repository already says this out loud. `keryx skills verify --help` states
that structural validation "does NOT judge whether a skill's instructions are
correct or useful; that needs a model in the loop and is not built". Today the
human at `keryx learn accept` is the only thing standing between a repeated
signal and a durable instruction, and that human has no measured evidence in
front of them — only a list of observation references.

## Goal

Give the loop a way to be wrong. A probe runs one task twice — without the
pattern and with it — in isolated worktrees, and reports whether the pattern
changed the outcome, with an explicit vocabulary for "cannot tell". The result is
an evidence item the existing confidence model already consumes, so the loop can
lose confidence as well as gain it.

## Users

- **Operator** deciding `accept`/`reject`: wants a measurement, not a repetition
  count, before making an instruction durable.
- **Loop maintainer**: wants to know whether a candidate that looked strong is
  actually inert, and to see that rate over time.
- **Agent** consuming an accepted pattern: benefits indirectly, because a pattern
  that cannot pass a probe does not reach the skill it loads.

## Requirements

The `Verification:` fields name the check that decides each requirement when this
package ships. None of the named commands or files exists in the tree today; the
package status is `spec ready`, not `implemented`.

### R1 — Probe is a separate verb, never a stage of accept or apply
`accept`, `apply`, `promote` and `graduate` keep their current behavior exactly;
probing is a distinct command that a human may run before deciding, and its
absence never blocks them.

Verification: exec `bun test src/learning/probe.test.ts` (asserts the four
commands do not import probe and do not require probe evidence)

### R2 — Two arms, one variable
Each probe runs the same task, model, provider, tool set and repository twice:
`base` (no extra instruction) and `probe` (the identical run plus the pattern's
`trigger`/`action` as one appended instruction block), each in its own git
worktree checked out from the same base ref.

Verification: judged

### R3 — Seeded, never single-shot
A task declared `stochastic` needs at least 3 seeds per arm; a task declared
`deterministic` needs 1. A stochastic task with fewer than 3 seeds is
`unmeasurable`, never `indistinguishable` — an underpowered run must not read as
evidence of no effect.

Verification: exec `bun test src/learning/probe-score.test.ts`

### R4 — Four verdicts, one of them honest about not knowing
Every comparison resolves to exactly one of `improved`, `regressed`,
`indistinguishable`, `unmeasurable`. `unmeasurable` carries exactly one reason
from a closed list — `no-task`, `gold-leak`, `run-failed`, `underpowered`,
`budget-exceeded`, `environment-drift` — and is never silently folded into
another verdict. Refusals before any work starts (no terminal, no budget, an
estimate over the configured ceiling, an ineligible record, an already-completed
probe, a mismatched resume, invalid arguments or task set) are not verdicts and write no artifact; the
specification's §5 and §7 are the single vocabulary for both.

Verification: exec `bun test src/learning/probe-score.test.ts`

### R5 — Evidence reuses the existing confidence model
With a matching snapshot at finalization, `improved` appends one `reinforcement` evidence item, `regressed` one
`contradiction`, both with `sourceType: "probe"` and a `sourceRef` pointing at the
comparison artifact. Confidence is recomputed by `applyEvidence` from
`src/learning/confidence.ts` with no new formula, no new constant, and no
probe-specific rate. Finalization deduplicates sourceRef under the record lock
using current confidence. Publication is the drift cut-off: earlier text/status
drift is unmeasurable/environment-drift; later drift skips uncommitted evidence
without rewriting comparison. CLI reports measurement and evidence outcome
separately (exit 3 for the invocation recording a skip).

Verification: judged

### R6 — No evidence from an inconclusive run
`indistinguishable` and `unmeasurable` append no evidence item and leave
`confidence` untouched; the comparison artifact is still written so the attempt
is auditable. Time-based decay continues to apply to the record as before.

Verification: exec `bun test src/learning/probe.test.ts`

### R7 — Probe never changes status and never writes an instruction
The record's `status` is the same after a probe as before it. Probe writes under
`.metaproject/data/learning/probes/` and appends at most one evidence item to the
record it was given; it never writes `.metaproject/project-skills/`,
`.metaproject/rules/`, `.metaproject/agents/`, or a memory entry.

Verification: invariant `bun test src/learning/probe.test.ts`

### R8 — Spending requires a named budget and a terminal
A real (non-`--dry-run`) probe refuses to start without finite positive `--max-usd <n>`, and
refuses outside an interactive terminal. There is no `--yes`, `--force`, or non-interactive bypass,
matching the discipline `accept` and `promote` already enforce.

Verification: exec `bun test src/commands/learn-probe.test.ts`

### R9 — The answer key is absent from the arm at the named paths
Before any seed, every named gold path must exist in the resolved base commit.
Both arms use the identical read-only context-on baseline/toolset. Every path the task set names in `goldArtifacts` is removed
from that arm's worktree, and the removal is verified with the existing
`checkGoldLeakage`. A task whose gold artifact cannot be removed or verified is
`unmeasurable` with reason `gold-leak`. The claim is limited to what the arm can
reach: both arms run the read-only tool set, so no write tool can restore a
removed file.

Verification: exec `bun test src/harness/probe/runner.test.ts`

### R10 — Worktrees are disposable, results are not
Both worktrees are removed when the probe ends, including on failure and
graceful interrupt. Uncatchable death cannot execute cleanup; resume reconciles
owned stale worktrees before further runs. Comparison and transcripts remain under the
probes root. Immutable plan/text snapshot and durable seed/spend checkpoints
allow resume without resetting cost or duplicating completed calls. Recoverable
finalization appends at most one evidence item despite process death.

Verification: judged

## Success criteria

### Release criteria

- The README-indexed Markdown documents and four schemas (task-set, comparison,
  immutable plan, mutable checkpoint) exist; every Markdown document
  carries `Version`.
- `keryx learn probe --help` documents the flags in the specification and exits
  zero.
- `bun test src/learning/probe.test.ts src/learning/probe-score.test.ts
  src/commands/learn-probe.test.ts src/harness/probe/runner.test.ts` passes.
- `bun run typecheck` and `bun test src/lib/import-policy.test.ts` pass. The zone
  table is unchanged: both new paths inherit their parent segment's zone by
  nesting, so no new table entry exists to guard.
- A recorded fixture probe produces a `probe-comparison.schema.json`-valid file
  and the expected confidence movement for each of the four verdicts.
- `.metaproject/data/learning/probes/` is gitignored by `keryx init`'s managed
  block, asserted by a guard test.

### Outcome criteria

These are post-runtime-release observations, NOT release or CI gates. Publishing
this spec alone starts no adoption clock.

- **Adoption**: at least one accepted pattern in this repository carries a
  `sourceType: "probe"` evidence item within 60 days of release. Observed by
  taking the accepted records `keryx learn list --status accepted` reports and
  reading each one's evidence with `keryx learn review <id>`, on the
  maintainer's own working copy.
- **Discrimination**: across the first 10 recorded probes, at least one resolves
  to `regressed` and at least one to `indistinguishable`; a run of ten `improved`
  results would suggest the task set is too easy to discriminate, and is looked
  at in the metrics review described in
  [metrics-and-validation.md](metrics-and-validation.md).
- **Decision value**: for probes recorded before an `accept`, the operator can
  state whether the probe changed the decision. Not measured — the accept
  decision log (`decisions.jsonl`) has no field for it, and adding one is out of
  scope for this package.

## Risks

- **Probe cost.** Every probe is 2 arms × N seeds × one agent turn. Mitigation:
  a mandatory `--max-usd` ceiling, a task set of read-only tasks, and a default
  of one task per invocation.
- **Weak statistics at small N.** Three seeds cannot detect a small effect.
  Mitigation: the verdict vocabulary is asymmetric — small effects resolve to
  `indistinguishable`, which appends no evidence, so a weak probe can only fail
  to move confidence, never inflate it.
- **Overfitting to the probe task.** A pattern could be tuned to pass one task
  without generalizing. Mitigation: tasks are not the pattern's source task,
  the task set is versioned, and a pattern passing probes does not skip the
  human accept gate.
- **False improvement from environment drift.** Model or repository changes
  between arms would fake a delta. Mitigation: both arms share one base ref and
  one model, recorded in the comparison artifact; a mismatch is `unmeasurable`.
- **Probe used as a rubber stamp.** A single `improved` result could be treated
  as proof. Mitigation: the PRD states the verdict is one evidence item among
  the record's others, and the confidence formula's diminishing returns apply.

## Recommendation

Build R1–R10 as one feature across core, client and adapter zones in the specification, on top of
the existing ablation machinery rather than beside it. Ship it behind no flag:
the command is inert until a human runs it, and the cost gate is explicit. Do not
extend it to user-scope records, scheduling, or LLM judging until at least ten
probes have been recorded and the metrics review in
[metrics-and-validation.md](metrics-and-validation.md) has been read.

## Preparation constraints and open verification

Keep apply.ts Partial evidence map/domain fallback and proposal sourceType/sections
unchanged (regression AC12). Router-only probe dispatch is permitted; decision
modules have no probe dependency. Invalid arguments/task sets are named exit-2
zero-write refusals; missing ID in valid task set is no-task. The specification
is the authoritative error/output vocabulary. No unresolved product decision
remains after operator cut-off clarification; runtime guarantees remain unverified.
