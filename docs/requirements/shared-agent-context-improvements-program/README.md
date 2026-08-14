# Shared Agent Context Improvements Program
Version: 0.1.0

## Purpose

This package is the program-level control plane for the twelve independent SAC
improvement packages produced from the 2026-08-14 integrated analysis. It does
not merge them into one implementation. It defines dependency order, phase
prompts, progress tracking, aggregate metrics, gates, rollback, and the evidence
needed to decide whether later memory, multi-agent, learned-policy, and remote
work should proceed.

## Status

**Future / spec-ready.** The program documents proposed work only. Each
child package has its own acceptance criteria and must be implemented through a
separate managed Flow.

## Documents

- [Package index](README.md) — this program overview and child registry.
- [PRD](prd.md) — program problem, goals, users, requirements, and risks.
- [Specification](specification.md) — package registry, dependency graph,
  progress and evidence contracts.
- [Implementation plan](implementation-plan.md) — sequential waves, entry/exit
  gates, stop conditions, and rollback order.
- [Phase execution prompts](phase-execution-prompts.md) — copy-ready prompts
  for a human or agent to start and manage every package/phase.
- [Progress dashboard](progress-dashboard.md) — updateable package/phase status,
  blockers, evidence, and aggregate statistics.
- [Metrics and validation](metrics-and-validation.md) — program outcome and
  delivery metrics.

## Child packages

1. [Runtime Truth](../shared-agent-context-runtime-truth/README.md)
2. [Source-owned FWK Projections](../shared-agent-context-source-projections/README.md)
3. [Session–Workspace–Flow Lifecycle Binding](../shared-agent-context-lifecycle-binding/README.md)
4. [Promotion Semantics and Integrity](../shared-agent-context-promotion-integrity/README.md)
5. [Secure Minimal Evidence](../shared-agent-context-secure-evidence/README.md)
6. [Identity, Capabilities, and Live Policy](../shared-agent-context-identity-capabilities/README.md)
7. [Generational Memory](../shared-agent-context-generational-memory/README.md)
8. [Causal Collaboration and Worktrees](../shared-agent-context-collaboration-worktrees/README.md)
9. [Unified Operations and Agent UX](../shared-agent-context-unified-operations/README.md)
10. [Receipt Operability and Provenance](../shared-agent-context-receipts-provenance/README.md)
11. [Evaluation and Topology-aware Orchestration](../shared-agent-context-evaluation-orchestration/README.md)
12. [Documentation and Graph Truth Sync](../shared-agent-context-documentation-truth/README.md)

## Program scope

- Dependency-aware implementation order across all child packages.
- One managed Flow and evidence bundle per child package.
- Shared baseline characterization and truth-sync gates.
- Program dashboard and aggregate progress/statistics.
- Copy-ready prompts for planning, implementation, review, verification,
  rollback, and package completion.
- Decision gates for learned policy, multi-agent expansion, remote transport,
  and UI.

## Non-goals

- A single cross-cutting implementation branch or mega-PR.
- Parallel mutation of tightly dependent packages.
- Bypassing child acceptance criteria through aggregate status.
- Claiming progress from document count, commit count, or agent self-report.
- Enabling learned policy, remote SAC, or automatic promotion as part of program
  management.

## Related sources

- [Integrated analysis](../../analysis/keryx-improvements-1/2026-08-14/report/en/report.md)
- [Original SAC package](../shared-agent-context/README.md)
- [Requirements roadmap](../roadmap.md)
- Keryx Flow and flow-orchestrator for managed implementation.
