# Keryx Benchmark Suite — PRD
Version: 0.1.0

## Problem

keryx makes three separable claims: that its `.metaproject/` context layer holds
correct, reusable answers; that its agent shell runs tasks correctly and safely;
and that both together beat working without them. None of these is currently backed
by evidence a stranger can reproduce. Worse, the easy mistake — one blended
"keryx is better" score — would be both unfalsifiable and easy to game. A benchmark
designed only to confirm is not a benchmark.

## Goal

Produce reproducible, leakage-controlled, anti-fabrication evidence for each of the
three claims **on its own terms**, designed from the start to survive external
publication, and run internally first. It must be possible for any ladder to
report "no advantage here."

## Users

- **keryx maintainers** — catch regressions between versions; see where the context
  layer earns its keep and where it does not.
- **Prospective adopters / reviewers** — read a comparison that names its tasks,
  targets, models, grading and fairness rules, not a marketing number.
- **Contributors** — extend the case catalog and add comparison targets behind a
  stable adapter without renegotiating the protocol.

## Product requirements

- **BS-1 — Three separate ladders.** Metastore, Harness and Comparative are scored
  with distinct metric vocabularies and reported separately. No result averages
  across ladders.
- **BS-2 — Falsifiability.** Every case states what outcome would count as "no
  advantage" or "keryx worse." An honest refusal, or a correct "unknown," scores as
  correct (`correctness: 1`), never as failure.
- **BS-3 — Oracle-graded metastore.** gdgraph (affected-set), gdwiki (grounded
  retrieval) and testing (test-impact) are graded against gold labels as
  information-retrieval problems (precision / recall / F1 / nDCG), independent of
  any agent.
- **BS-4 — Ablation core.** The same agent and the same model are run with the
  `.metaproject` context **on and off** on the same task; the metric is the delta in
  success, tokens and tool-calls. This is the primary, least-gameable measurement of
  context value.
- **BS-5 — Harness quality and safety.** The shell is scored on task success,
  tool-use correctness, cost (tokens / cost / latency, with exact/estimated/unknown
  labels), and a dedicated safety track: workspace-write containment, shell-permission
  restraint, prompt-injection resistance, and completion-gate honesty (it must not
  claim "done" without the evidence its flow requires).
- **BS-6 — Comparative fairness.** A comparative number may be published for a
  target only after its fairness protocol is met: same task, same model, same
  environment, an adapter reviewed for parity, and the target's own idioms honored.
  The baseline ladder (keryx-on / keryx-off / raw-model) ships first; other harnesses
  and context/RAG tools follow behind adapters.
- **BS-7 — Ground truth without leakage.** Ground truth is curated real repositories
  pinned to a commit, and keryx's own development history (dogfood). For dogfood, the
  repository is checkpointed to the state **before** the answer existed; the gold
  answer (the merged diff, the review findings, the recorded flow) is never readable
  by the agent during the run.
- **BS-8 — Stochasticity handled.** Agent (stochastic) tasks run 3 times with fixed
  seeds; the report carries the distribution (median and spread), not a single lucky
  run. Deterministic oracle grading runs once. Cache state, model, and environment
  are recorded per run.
- **BS-9 — Protocol continuity.** The suite evolves `paired-3-5-v1` with backward
  compatibility: it keeps the anti-fabrication rules and the durable evidence bundle,
  and every run still validates with `keryx metrics benchmark validate`.
- **BS-10 — Durable, readable evidence.** Every run writes a self-describing evidence
  bundle (inputs, target, model, seed, cache state, transcript reference, grading,
  labels) so a reader who was not present can audit the result and re-run it.

## Success criteria

- For a fixed metastore gold set, gdgraph/gdwiki/testing report reproducible IR
  metrics; re-running on the same pinned repo yields the same numbers.
- The ablation delta is reproducible in sign on the same task set across seeds:
  context-on is not *worse* on ordinary work, and is measurably better where the
  answer is materialized in the workspace.
- 100% of persisted runs carry model, seed, cache state, cost labels and a grading
  rationale; 0 runs claim a metric that was not measured.
- The safety track produces zero "task success" credit for an unsafe completion, and
  scores an honest refusal as correct.
- A comparative result is present only for targets whose fairness protocol is
  documented as met; no comparative number is published otherwise.
- `keryx metrics benchmark validate` passes on every emitted manifest.

## Fairness

The comparison is deliberately unflattering-capable. Where keryx runs a cheaper or
local model than a baseline, that is stated, and capability is reported separately
from context leverage so the two are never conflated. Baseline systems are driven
through their own idiomatic interface, not a crippled one, and each adapter is
reviewed for parity before its numbers count. The ablation ladder holds the model
constant precisely so "keryx's context helped" cannot be confused with "keryx used a
better model."

## Risks

- **Blended-score temptation.** Mitigation: BS-1 forbids cross-ladder averaging;
  the report format has three separate sections.
- **Ground-truth leakage (dogfood).** Mitigation: BS-7 checkpoints the repo before
  the answer exists; a leakage check asserts the gold artifact is absent from the
  agent-visible tree.
- **Overfitting to the gold set.** Mitigation: hold out a portion of cases;
  rotate curated repos; treat a suspiciously perfect score as a red flag to audit,
  not a win.
- **Cost blow-up.** Mitigation: M1 is one frontier + one local model, 3 runs/task,
  per-run token cap; the matrix expands only after M1 reads cleanly.
- **Unfair comparative numbers.** Mitigation: BS-6 gates publication on a met
  fairness protocol per target; the baseline ladder (no third-party adapter) ships
  first.
- **Grading subjectivity.** Mitigation: oracle/IR grading where a gold label exists;
  rubric with explicit discriminators elsewhere; grading rationale stored in the
  bundle.

## Recommendation

Ship the **Metastore oracle + Ablation** ladders first (M1) on curated real repos
and a small dogfood set, with the safety track folded in, one frontier + one local
model, 3 runs/task. Add the **baseline Comparative** (keryx-on/off/raw) in the same
protocol. Defer third-party comparative targets (other harnesses, RAG tools) to M2–M3
behind adapters and a per-target fairness protocol. Never publish a comparative
number, or any single-run claim, before its decision-rule bar is met.
