# Keryx Benchmark Suite Requirements Package
Version: 0.1.0

## Status

**M1 in progress, substantially landed (2026-08-13, branch
`fix/benchmark-remediation-v3`).** Real runs have been executed and real results are
reported — see [plan.md](plan.md) for the full progress log with numbers, honest
findings (including two anomalies found and root-caused, and one real sandbox bug found
and fixed), and what remains open. Summary:

- **Metastore** — all five oracle layers landed (gdgraph, testing, memory, gdctx,
  gdwiki), deterministic, reproducible.
- **Harness / ablation** — landed across three model legs (deepseek-v4-flash hosted,
  codex/gpt-5.6-sol frontier, rapid-mlx/qwen3.5-9b-4bit local), reported separately,
  never averaged. Coverage is currently read-only comprehension tasks only.
- **Harness / safety track** — all four case classes landed (completion-gate honesty,
  false-premise resistance, workspace-write containment, shell-permission restraint,
  prompt-injection resistance — five, counting false-premise as its own group), each
  with a real, live run against the real mechanism under test (the actual completion
  gate, or the actual OS sandbox with a mandatory preflight canary). Currently
  deepseek-v4-flash only.
- **Comparative (M2/M3)** — not started.

This package defines keryx's own benchmark suite (branch
`fix/benchmark-remediation-v3`). It builds on the existing paired-comparison
protocol (`keryx metrics benchmark init|validate`, `paired-3-5-v1`), the
[Keryx Shell Benchmark](../keryx-shell-benchmark/README.md) case package, and the
[Keryx Execution Observability](../keryx-execution-observability/README.md) metrics
package — and extends them into **three separately-reported ladders**.

## Purpose

Measure the three distinct things keryx claims to provide, without collapsing them
into one misleading "keryx is better/faster" number:

1. **Metastore** — does the versioned `.metaproject/` context layer (gdgraph,
   gdwiki, memory, testing, health, gdctx) actually contain *correct* answers, and
   does having it change an agent's outcome?
2. **Harness** — does `keryx shell` execute agentic tasks correctly, safely, and at
   an acceptable cost?
3. **Comparative** — how does keryx stand relative to a raw model and to other
   systems, on the same tasks, across models?

The governing question for each ladder is **falsifiable**: it must be possible for
the benchmark to say "no advantage here," and an honest refusal or a correct "I
don't know" must score as a success, never as a failure.

## The three ladders

Each ladder has its own metric vocabulary and is reported on its own. **They are
never averaged into a single score.**

| Ladder | Question | Core method | Ground truth |
|--------|----------|-------------|--------------|
| **Metastore** | Are the context artifacts correct, and do they help? | Oracle-graded IR metrics on artifacts **+** ablation (context on/off) | Curated real repos + keryx dev history (dogfood) |
| **Harness** | Does the shell run tasks correctly and safely, at what cost? | Task success, tool-use correctness, safety/containment, completion-gate honesty, cost | Curated real repos + dogfood |
| **Comparative** | Where does keryx stand vs a raw model and other systems? | Same task driver + same evidence bundle across targets, model held constant | Same as above; adapter-driven |

## Document Index

- [PRD](prd.md) — problem, users, requirements, success criteria, fairness, risks.
- [Specification](specification.md) — ladders, targets, variants, isolation, data
  contracts, protocol evolution, acceptance criteria.
- [Metrics and Validation](metrics-and-validation.md) — per-ladder metrics,
  reliability levels, the decision rule, and the anti-fabrication invariants.
- [Plan](plan.md) — milestones M1–M3 and their exit criteria.

## Scope

- **Three ladders**, separately reported, over real projects with a `.metaproject/`
  workspace.
- **Oracle-graded metastore**: gold affected-set (from git history), gold wiki
  Q→passage, gold test-impact (from coverage) — scored as IR problems
  (precision / recall / F1 / nDCG).
- **Ablation core**: the same agent and the same model run with `.metaproject`
  context **on vs off**, measuring success / tokens / tool-calls delta.
- **Safety/containment track**: cases that must fail closed (workspace-escape
  writes, over-broad shell permissions, prompt-injection in a wiki page, a
  completion gate that must refuse "done" without evidence).
- **Comparative**: keryx-on / keryx-off / raw-model baseline first; other agent
  harnesses and context/RAG tools behind adapters and a fairness protocol.
- **Models**: one frontier + one local model in M1; the matrix is extensible.
- **Runs**: 3 runs per stochastic (agent) task with fixed seeds; 1 run for
  deterministic oracle grading. A per-run token cap bounds cost.
- **Protocol**: an evolution of `paired-3-5-v1` that keeps its anti-fabrication
  rules and evidence bundle and stays validatable by `keryx metrics benchmark
  validate`.

## Non-Goals

- A single headline "keryx is better" number. The three ladders are never averaged.
- Any speed claim bought with quality, or any claim from a single run — the
  [decision rule](metrics-and-validation.md#decision-rule) governs.
- Synthetic fixtures as ground truth. Only curated real repos and keryx's own dev
  history are used, so leakage is controlled by repo checkpointing, not by
  hand-authored answers.
- Changing any task in order to collect a metric.
- Publishing a comparative number before the fairness protocol for that target is
  met.

## Related Packages and Modules

- [`keryx-shell-benchmark`](../keryx-shell-benchmark/README.md) — the case catalog
  and agent protocol this suite extends.
- [`keryx-execution-observability`](../keryx-execution-observability/README.md) —
  the run record, paired manifest, reliability levels and decision rule.
- `metrics` — `keryx metrics benchmark init|validate`, the evidence bundle.
- `gdgraph`, `gdwiki`, `memory`, `testing`, `health`, `gdctx` — the metastore
  layers under test.
- `harness`, `session` — the run loop and per-project sessions the shell drives.
