# Keryx Learn Probe
Version: 0.1.1

## Purpose and status

Requirements package for `keryx learn probe` — a falsification step for the W3
self-learning loop (`docs/requirements/keryx-agent-platform-expansion/workstreams/W3-self-learning.md`,
`src/learning/`). W3 raises a pattern's confidence when the same signal repeats.
It has no way to observe whether the pattern changes an agent's behavior, which
is the gap `keryx skills verify` states in its own help text: structural checks
only, "it does NOT judge whether a skill's instructions are correct or useful".

This package specifies one command that runs a probe: the same task, the same
model and the same prompt, twice — once without the pattern and once with it —
in isolated git worktrees, and turns the measured difference into an evidence
item the existing confidence model already knows how to consume.

Status: **spec ready; runtime not implemented.** Every command, path and schema
below is planned. Observed effects are not yet measured.

## Document index

- [PRD](prd.md)
- [Specification](specification.md)
- [Metrics and validation](metrics-and-validation.md)
- [Artifact lifecycle](artifact-lifecycle.md)
- [Probe task set schema](schemas/probe-task-set.schema.json)
- [Probe comparison schema](schemas/probe-comparison.schema.json)

## Scope

In scope:

- one CLI verb, `keryx learn probe <id>`; a real run is reachable only by a human
  at a real terminal, and `--dry-run` is explicitly TTY-free;
- a paired two-arm run (base vs base+pattern) over a task set with objectively
  checkable answers;
- a verdict vocabulary with an explicit `unmeasurable`, and a confidence update
  that reuses `src/learning/confidence.ts` unchanged;
- storage of the comparison artifact under the learning data root, beside the
  observation and candidate stores it belongs to.

Non-goals:

- no automatic acceptance, promotion, graduation, or apply — probe never changes
  a record's `status` and never writes a skill, rule, agent, or memory file;
- no scheduling and no background execution in v1: probing spends money and runs
  an agent, so it stays a foreground, human-started action;
- no user-scope probing in v1 (project scope only);
- no LLM judge: a probe task has an objectively checkable answer, and a task
  without one is refused rather than judged;
- no replacement of the W3 signals — probe is an additional evidence source, not
  a new extraction pipeline.

## Related modules

- `src/learning/` — record store, confidence model, evidence vocabulary, consent
  CLI. This package extends its evidence types and adds a producer beside them.
- `src/metrics/` — `benchmark.ts` (Wilson interval) and `leakage.ts` (gold-answer
  checks) are reused as pure functions rather than re-derived.
  `ablation-runner.ts` is a reference for the arm-scoring shape only and is not
  imported: it scores two variants of one context policy, while a probe scores
  two arms of one task.
- `src/harness/` — `child/git-worktree-port.ts` (isolated worktrees) and the
  turn loop in `src/commands/agent.ts` (`runAgentTurn`) that runs one arm.
- `scripts/benchmark/run-ablation.ts` — the reference producer this design
  follows: same task, two variants, own worktree per variant, pure scorer
  separate from the live producer.
- `.metaproject/rules/core/skill-lifecycle.mdc` — the rule that mutation never
  lives in a hook; probe is agent-loop work and does not touch that boundary.
