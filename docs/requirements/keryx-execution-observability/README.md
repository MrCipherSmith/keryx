# Keryx Execution Observability Requirements Package
Version: 0.2.0

## Status

Runtime capability implemented on the feature branch. The provenance,
event-accounting, artifact-lifecycle, hook, baseline, lightweight, and
benchmark-template contracts are backed by source and focused tests. No paired
Keryx/no-Keryx performance result has been run or claimed; representative task
selection remains a product decision.

## Purpose

Define a reliable, comparable observability layer for Keryx and its skills. The
layer must turn execution metrics from an approximate end-of-run narrative into
provenance-aware, machine-readable data that can explain quality, effort,
latency, retries, and Keryx overhead across comparable runs.

## Document Index

- [PRD](prd.md) — problem, users, requirements, success criteria, risks, and recommendation.
- [Specification](specification.md) — architecture, storage, CLI, contracts, integrations, and acceptance criteria.
- [Agent Protocol](agent-protocol.md) — ownership rules for top-level orchestrators, subagents, and lightweight mode.
- [Artifact Lifecycle](artifact-lifecycle.md) — creation, provenance, freshness, retention, and latest pointers.
- [CI Protocol](ci-protocol.md) — Standard validation, baseline health, and CI signal policy.
- [Metrics and Validation](metrics-and-validation.md) — formulas, reliability levels, test strategy, and paired benchmarks.
- [Implementation Plan](implementation-plan.md) — phased delivery plan and dependencies.
- [Execution Metrics Run Schema](schemas/execution-metrics-run.schema.json) — machine-readable run contract.

## Scope

- Exact command and tool counts derived from gdctx and Keryx run events.
- Separate wall time from active execution time.
- Provenance on every report: run, commit, branch, worktree, skill, and parent run.
- Versioned per-run testing and health evidence with a provenance-aware `latest` pointer.
- Worktree-safe hooks and a consistent index-refresh command surface.
- A clean `standard validate` baseline on `main` before PR-specific gating.
- Lightweight execution for small tasks.
- Retry classification and paired Keryx/no-Keryx comparison experiments.

## Non-Goals

- Changing a task solely to collect metrics.
- Fabricating token, cost, model, or timing values unavailable from runtime.
- Requiring every read-only skill to persist a metrics artifact.
- Replacing Keryx health, testing, graph, or CI systems with a second unrelated framework.

## Related Modules

- `gdctx` — command/search/read event source and compact-output artifacts.
- `gdskills` — skill and orchestrator lifecycle, subagent ownership, and metrics opt-in.
- `testing` — per-run test selection and normalized result evidence.
- `health` — per-run quality and baseline evidence.
- `standard` — schema and workspace compliance gate.
- `gdgraph` — affected context and navigation evidence.
- `tasks` / `flow` — parent run and artifact ownership for managed work.
- `security` — redaction and output safety for reports and command metadata.

## Implementation Evidence

- Runtime capability: `src/metrics/` and `src/commands/metrics.ts`.
- Per-run testing/health evidence: `src/testing/service.ts` and
  `src/health/run.ts`.
- Worktree-safe hooks: `src/lib/git-hooks.ts`, used by init, update, and sync.
- Baseline classification: `src/standard/baseline.ts` and
  `keryx standard baseline`.
- Focused tests cover schema/provenance, event accounting, pointers,
  worktrees, baseline classification, lightweight mode, and benchmark
  templates. Full verification is recorded by the managed flow.

## Decision Summary

The canonical source is a versioned JSON run record. Markdown reports are
rendered views of that record. A run is complete only after its provenance,
source reliability, and final status are recorded. `latest` is a pointer to a
specific run, never an unversioned mutable report without provenance.
