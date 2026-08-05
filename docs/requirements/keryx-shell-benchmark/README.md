# Keryx Shell Benchmark Requirements Package
Version: 0.1.0

## Status

Specification ready; no run has been executed and no result is claimed.

This package supplies the one input
[Keryx Execution Observability](../keryx-execution-observability/README.md)
declared out of scope for itself: *"representative task selection remains a
product decision."* That package defines the metrics, the reliability levels,
the paired manifest (`keryx metrics benchmark init|validate`) and the decision
rule. This one names the tasks, the targets, the agents, and the grading — so a
run can be executed and read by someone who was not in the room.

## Purpose

Answer one question with evidence instead of intuition: **does `keryx shell`
give a model a real advantage over a mainstream agent CLI on a project that has
a `.metaproject/` workspace, and where exactly does that advantage appear?**

The hypothesis under test is narrow and falsifiable: on questions whose answer
is already materialized in the workspace — the graph, the wiki, memory, health,
test intelligence — keryx should reach a grounded answer in fewer steps and with
less context read, while never being *worse* on ordinary work.

## Document Index

- [PRD](prd.md) — problem, users, requirements, success criteria, risks, and recommendation.
- [Specification](specification.md) — targets, variants, isolation, execution, data contracts, and acceptance criteria.
- [Test Cases](test-cases.md) — the case catalog: 26 cases in four groups, each with a prompt, an expected outcome, and what it discriminates.
- [Agent Protocol](agent-protocol.md) — how each agent is driven, verbatim, so a run is reproducible.
- [Benchmark Case Schema](schemas/benchmark-case.schema.json) — machine-readable case contract for the runner.

## Scope

- A fixed catalog of cases runnable on a real project with a `.metaproject/` workspace.
- Two keryx model legs — a paid-but-cheap gateway and a free local model — so cost and capability are separable.
- Baseline legs on mainstream agent CLIs against the same commit, in isolated worktrees.
- A grading rubric that scores *grounding*, not only correctness.
- Emission into the existing paired manifest format so results validate with `keryx metrics benchmark validate`.

## Non-Goals

- Claiming keryx is faster or better. The decision rule in
  [metrics-and-validation](../keryx-execution-observability/metrics-and-validation.md#decision-rule)
  governs: no claim from one run, and never a speed claim bought with quality.
- Comparing model quality. The baseline agents run on stronger models than the
  keryx legs deliberately — see the PRD's fairness section.
- Benchmarking the non-interactive `keryx harness run`. It registers no tools
  and completes a single text turn, so it cannot perform an agentic task at all.
- Changing any task in order to collect a metric.

## Related Modules

- `metrics` — the run record, the paired manifest, and the reliability levels.
- `gdgraph`, `gdwiki`, `memory`, `health`, `testing`, `gdctx` — the workspace layers whose leverage is under test.
- `harness` — the run loop the shell drives; see [the harness page](../../docs/harness.md).
- `session` — per-project sessions, resume and fork, exercised by group D.
