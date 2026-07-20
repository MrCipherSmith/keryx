# Multi-Agent Engine Phase 6a: event-sourced orchestrator state (reduceState fold)

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/ (brainstorm C3, roadmap Phase 6)

## Problem

`orchestrator-state` (`.metaproject/core/gdskills/contracts/orchestrator-state.schema.json`)
is currently a mutable snapshot. There is no single, replayable authority for a
multi-subagent run: crash-safe resume, deterministic replay, and a live HUD each
need their own ad-hoc reconstruction. The `agent-event` stream already records
every state transition — but nothing folds it into the orchestrator state.

## Expected Outcome

A pure **`reduceState(events) → OrchestratorState`** fold that reconstructs the
schema-valid orchestrator state (plan steps + statuses + run status) from the
append-only `agent-event` stream, making the log the source of truth. This is the
foundation the rest of Phase 6 builds on: resume replays the log, the monitor
projects it, and a fleet is deterministically reconstructable. Pure/deterministic
— identical event logs yield a byte-stable, hashable state.

## Out of Scope

- Worktree isolation (Phase 6b, flow 096) and peer messaging (Phase 6c, flow 097).
- Wiring resume/replay call sites to use the fold end-to-end (this phase delivers
  the pure fold + its tests; adoption is incremental).
- Any mutation of live flow state (D-02 preserved).
