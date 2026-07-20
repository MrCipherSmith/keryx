# Multi-Agent Engine Phase 3: subagent caps + shared budget ledger + run threading + injection quarantine

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/

## Problem

With model resolution wired into the contract and spawn (Phases 1–2, flows
088/089), three safety/runtime gaps remain: (a) no subagent tree-depth or count
cap and no single budget ledger — independent spawns each see full parent
remaining and can over-grant; (b) the resolved model is not yet used to build the
child's `NormalizedRequest`, and `makeProvider` still reads ambient `process.env`
(a credential-presence oracle) and fails open to `FakeProvider`; (c) child
free-text is folded into evidence without an injection quarantine.

## Expected Outcome

A run-scoped shared budget ledger + fail-closed depth/count caps; the child's
model threaded into `run.ts`/`NormalizedRequest` via credential-scoped
`makeProvider` (no silent `FakeProvider` on the orchestrated path); and an
instruction-shaped-pattern quarantine on child summaries before re-dispatch.

## Out of Scope

- `resolveChildModel` (flow 088) and contract/spawn threading (flow 089) — depends
  on both.
- Monitoring fold / `keryx agents`, adaptive escalation, event-sourced fleet,
  worktrees, peer messaging (roadmap phases 4–6).
- Cost/token budgeting enforcement (deferred extension point; ledger leaves a
  documented `maxCostUnits` hook).
