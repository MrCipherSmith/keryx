# Implementation Plan

Status: ready to freeze

## Approach

Two-layer monitoring (spec §Data Contracts.4): a PURE deterministic accounting
fold over the frozen `agent-event` contract, and an impure display/CLI layer that
does all I/O and any arrival-ordered rendering. The fold never reads a clock/RNG,
never touches fs/network, and never feeds display state back into itself.

## Steps

1. New `src/harness/monitor/reduce.ts`:
   - `reduceAgents(events: AgentEvent[]) → AgentsSnapshot` — fold canonical
     `agent-event`s (dispatch_created/completed/blocked, run_*, decision_recorded,
     validation_failed) into a per-`dispatch_id` record `{ dispatchId, status,
     model?, source?, budgetRemaining?, usage }`. Deterministic; stable key order.
   - Usage accounting sums only provider-reported EXACT token counts (from event
     `data.usage` with `exact:true`); inexact/unknown is marked, never summed as
     exact (mirrors `NormalizedUsage.exact`).
   - `diffAgents(prev, next) → AgentDelta[]` — derive spawned/running/idle/done/
     failed/blocked deltas from two snapshots; deterministic, stable order.
2. New `src/harness/monitor/reduce.test.ts`: fold determinism (same events →
   deep-equal + stable), exact-vs-inexact usage, all status mappings, diff deltas.
3. New `keryx agents [--json]` command (`src/commands/agents.ts` + registry entry):
   read a persisted/provided `agent-event` source (path/flow), fold it, and render
   — `--json` emits the `AgentsSnapshot`; text renders a parent→child tree with
   status + model + ↑in/↓out tokens. Read-only (no writes). Add a descriptor to
   the command registry (`keryx commands --json` honesty).
4. Command test (json output shape; read-only).

## Risks

- Keep the fold PURE — the CLI does file reads and any timestamp rendering.
- Do not overstate usage: exact-only summation; inexact flagged.
- Parent→child tree derived from `dispatch_id` + provenance/parent linkage already
  in events; no new event type required for this phase.
- Command registry `json:true` must be honest (see command-descriptor-registry).
