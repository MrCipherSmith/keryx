# Keryx Shell Benchmark PRD
Version: 0.1.0

## Problem

keryx ships a `.metaproject/` workspace — a dependency graph, a wiki, typed
memory, health signals, test intelligence — and an agent shell that can query it
through tools. The product claim implied by all of that is that an agent with
this workspace behaves better than an agent without it.

Nobody has measured it. The observability package built the instrument and
stopped exactly where a product decision was needed: *which tasks*. So the claim
sits unverified, and the README has been rewritten twice in a week to avoid
overstating things nobody had tested. That is the right instinct and a poor
substitute for evidence.

There is also a failure mode worth naming: the workspace could be *neutral*.
A model given a graph query tool may ignore it and grep anyway. A wiki page may
be worse than reading the source. If that is what happens, the benchmark should
say so plainly — a benchmark designed only to confirm is not a benchmark.

## Goal

Produce a repeatable, honestly-graded comparison that answers three questions:

1. **Leverage** — on questions the workspace already answers, does keryx reach a
   grounded answer in fewer steps and less context than a mainstream agent CLI?
2. **No regression** — on ordinary coding work, is keryx at least not worse?
3. **Cost floor** — how far down the model ladder does the advantage survive?
   A paid gateway and a free local model are both run for exactly this.

## Users

| User | What they get |
|---|---|
| The maintainer | Evidence for or against the central product claim, per capability, before it goes in the README. |
| A prospective user | A published comparison with a documented task set instead of a marketing adjective. |
| The agent | A case catalog that doubles as a regression suite: a capability that stops paying off shows up as a score drop. |

## Requirements

### R1 — Real target, not a fixture

Cases run against a project with a populated `.metaproject/` workspace and a
non-trivial codebase. The primary target is a project that is **not keryx**, so
the tool is not grading itself; keryx is the secondary target because its
workspace is the richest and the bias is then stated rather than hidden.

### R2 — Identical starting state

Every agent starts from the same commit in its own `git worktree`. No agent sees
another's edits, and the diff of a run is attributable to that run alone.

### R3 — Verbatim prompts

A case's prompt text is used byte-identically across every variant. Rewording a
prompt to suit one agent invalidates the pair.

### R4 — Grounding is graded, not assumed

Correctness alone cannot distinguish "queried the graph" from "guessed and got
lucky". Each case declares the evidence a grounded answer must contain, and the
rubric scores it separately from correctness.

### R5 — Two keryx model legs

One cheap gateway leg (DeepSeek) and one free local leg (`gemma4-coder` via
Ollama). Both are run on the full catalog. A capability that only works on the
paid leg is a real finding, not a failure to report.

### R6 — Emission into the existing contract

Results are written into the paired manifest produced by
`keryx metrics benchmark init` and must pass `keryx metrics benchmark validate`.
Unavailable values stay `unknown`; the manifest's `speed_claim` stays
`not-claimed` unless the decision rule is satisfied.

### R7 — Negative results are published

A case where keryx loses, ties, or is ignored by the model is recorded with the
same prominence as a case where it wins.

## Fairness — stated, because it cuts against us

The baseline agents run on frontier models. The keryx legs run on a cheap
gateway and a 7B local model. **This is deliberate and it is not a fair fight on
reasoning.** It is the fight the product claim actually makes: that a materialized
project workspace lets a *weaker, cheaper* model answer project questions that an
unaided stronger model has to reconstruct from scratch. Two consequences follow
and both are honoured in the grading:

- A keryx loss on a reasoning-heavy case is **not** evidence against the
  workspace. Group B exists to detect that, and its results are read as a floor
  check, not as a comparison.
- The baseline agent may read `.metaproject/` files directly — they are ordinary
  Markdown and JSON in the repository. Blocking that would manufacture the
  result. What the baseline lacks is the *query layer*, not the data.

## Success criteria

| # | Criterion |
|---|---|
| S1 | Every case in the catalog has been executed on all declared variants, or is explicitly recorded as skipped with a reason. |
| S2 | Each result carries provenance: commit, worktree, agent, model, timestamp. |
| S3 | The paired manifests validate with `keryx metrics benchmark validate`. |
| S4 | Group A reports a per-case grounding verdict, not only pass/fail. |
| S5 | Group B shows no case where keryx is *materially* worse without that being named as a finding. |
| S6 | The report states, in one sentence per group, what the evidence supports — including where it supports nothing. |

## Risks

| Risk | Mitigation |
|---|---|
| **The model ignores the tools** and greps instead — the most likely failure. | The rubric scores tool usage per case, so "the capability exists but the model does not reach for it" is a distinguishable, reportable outcome. It is a prompt/registry defect, not a measurement error. |
| **A weak local model fails cases for unrelated reasons** (bad instruction-following, malformed tool calls). | Two legs. A case that passes on DeepSeek and fails on `gemma4-coder` is labelled model-capability, not capability-absent. |
| **Grading drift** — the grader is the same assistant that built keryx. | Each case declares its expected evidence *before* the run, in this package, at a fixed version. Grading against a criterion written after seeing the output is not grading. |
| **Stale workspace** on the target makes keryx look bad for the wrong reason. | `keryx sync --apply` runs on the target before the benchmark and the commit is recorded; a stale-artifact failure would otherwise be misread as a capability failure. |
| **Wall time is dominated by model latency**, not by the workspace. | Steps, tool calls and files read are the primary signals. Time is recorded and reported, never used alone. |
| **The catalog overfits to what keryx happens to do well.** | Group B is drawn from ordinary work with no workspace angle, and Group A includes cases where the workspace layer is known to be thin. |

## Recommendation

Run it, on `helyx` first, with the catalog fixed at this package's version before
any execution. Publish whatever comes out. The value of this exercise is entirely
in the fact that the answer is not known in advance — a benchmark whose result is
decided beforehand is a press release with extra steps.
