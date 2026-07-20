# Multi-Agent Engine Phase 4: monitoring fold + keryx agents surface

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/ (specification §Data Contracts.4)

## Problem

The subagent engine (flows 088–091, all merged) can resolve models, spawn bounded
children, cap fan-out, and assemble a dispatch via `spawnSubagent` — but a parent
or operator has **no way to observe a fleet of subagents**: there is no aggregate
view of per-child status, resolved model, budget remaining, or token usage. The
existing TUI renders only a single session. keryx also forbids non-determinism in
its core, so a monitor cannot be a naive live-polling loop.

## Expected Outcome

A **deterministic accounting fold** over the canonical `agent-event` stream —
`reduceAgents(events) → AgentsSnapshot` (per-dispatch status / model / source /
budget-remaining / usage) — plus a `diffAgents(prev, next)` that derives delta
events (spawned/running/idle/done/failed/blocked), and a read-only
`keryx agents [--json]` command that renders the fold (parent→child tree in text;
the raw snapshot in `--json`). The fold is pure and replayable; all I/O and any
arrival-ordered display live outside it (the two-layer split from the spec).

## Out of Scope

- Live streaming TUI of running children (needs a live fleet; children are not yet
  run end-to-end — this phase folds a persisted/provided event source).
- Adaptive escalation (Phase 5); event-sourced `orchestrator-state` fold as the
  authority + worktrees + peer messaging (Phase 6).
- Cost/token BUDGET enforcement (deferred `maxCostUnits` hook); this phase only
  *reports* usage, honoring exact-vs-inexact reliability.
