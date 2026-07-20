# Keryx Multi-Agent / Subagent Orchestration Engine
Version: 0.1.0

## Purpose

Define the requirements for a first-class **subagent orchestration engine** in
the Keryx harness: a parent (orchestrator) agent can launch bounded child
(subagent) attempts, each with an **explicitly selected or inherited model /
provider**, manage their lifecycle and concurrency, monitor them, and fold their
results back — without breaking Keryx's fail-closed, deterministic, parent-owns-
completion invariants.

The engine closes the one authority axis the current harness does not constrain:
**model and provider selection**. Budget and policy already inherit fail-closed
(`inheritBudget`, `inheritPolicy`); model/provider currently rides in as an
unchecked string and is ignored at construction (`makeProvider(name, _model,…)`).
This package adds a fourth inheritance resolver plus the surrounding lifecycle,
monitoring, and safety machinery, documented as a phased architecture (A → B → C).

## Status

**draft** — specification and phased plan ready; no new runtime implemented yet.
Builds on the existing harness primitives in `src/harness/` (child spawn +
isolation + contract, `planWaves` scheduler, provider port, canonical
`subagent-dispatch`/`subagent-result`/`agent-event`/`orchestrator-state`
contracts). No performance or completeness claim is made until code and tests
prove it.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, scope, status, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Identity, data contracts, resolver semantics, CLI/skill surface, acceptance criteria. |
| [agent-protocol.md](agent-protocol.md) | Subagent behavior: spawn, model resolution, caps, result/quarantine, monitoring events. |
| [brainstorm.md](brainstorm.md) | Decision history: reference designs studied, options, critical questions, resolved forks. |
| [implementation-plan.md](implementation-plan.md) | Phased A → B → C plan with file touch-points and effort. |
| [schemas/child-model-selection.schema.json](schemas/child-model-selection.schema.json) | Machine-readable model-selection block on the dispatch contract + resolved extension field. |
| [schemas/agent-event-extensions.schema.json](schemas/agent-event-extensions.schema.json) | New `agent-event` types: `model_resolved`, `tier_escalated`, `peer_message`. |

## Scope

**In scope**
- A pure, fail-closed **`resolveChildModel`** resolver (explicit-or-inherit),
  gated by a parent **provider allowlist** and the child's resolved policy.
- An optional **`model` block on `subagent-dispatch`** as the agent-definition
  surface (no new file format).
- Threading the resolved selection through `spawnChild` → `ChildContractExtension`
  → the child's `NormalizedRequest` / `makeProvider`.
- **Safety caps**: subagent tree depth, total live/emitted child count, and a
  single shared budget ledger across every spawn path.
- **Monitoring**: a deterministic accounting fold plus a non-deterministic
  display layer, and a `keryx agents --json` surface.
- **Result handling**: canonical result folding + injection quarantine of child
  free-text before the orchestrator acts on it.
- **Roadmap (C)**: adaptive cost-aware model escalation, event-sourced
  orchestrator state, git-worktree isolation for parallel mutators, bounded peer
  messaging — documented with extension points.

**Non-goals (this release)**
- Token/dollar **cost budgeting enforcement** — the budget lattice stays
  runtime + tool-calls; a cost dimension is a documented extension point only
  (providers report usage inconsistently; see PRD risk R3).
- A separate `.claude/agents/*.md`-style loader — the dispatch contract is the
  definition surface.
- Any relaxation of the D-02 invariant (a child never writes flow state).
- New runtime dependencies — the zero-`dependencies` policy holds; any optional
  provider SDK follows the optional-deps + dynamic-import + ADR + AC15 rule.

## Related Modules

- **Project Agent Harness** (`docs/requirements/keryx-project-agent-harness/`) —
  the provider protocol, session, budget, policy, and child-contract this engine
  extends.
- **Execution Observability** (`docs/requirements/keryx-execution-observability/`)
  — provenance, per-run evidence, retry taxonomy the monitor reuses.
- **Metaproject-Native Harness** (`docs/requirements/keryx-metaproject-native/`)
  — the `MetaprojectPort` and universal Task Manager that dispatch subagents.
- **Flow Reviewer** (`docs/requirements/flow-reviewer/`) — a concrete consumer
  that already anticipates adaptive model routing over subagents.
