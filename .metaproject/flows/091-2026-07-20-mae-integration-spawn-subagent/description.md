# Multi-Agent Engine Integration: spawnSubagent orchestration assembly

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/

## Problem

Phases 1–3 (flows 088/089/090, all merged) delivered the subagent primitives —
`resolveChildModel`, contract `model`/`modelSelection`, `spawnChild` with
budget/policy/model guards + depth/count caps, `RemainingBudgetLedger`,
`childRunModel`, credential-scoped `makeProvider`, and `quarantineChildSummary`.
But **nothing assembles them into one real call**: they are individually
unit-tested seams with no production entry point. A caller today would have to
hand-wire the ledger, allowlist, credentials, caps, tiers, env override, spawn,
run-model mapping, and quarantine itself.

## Expected Outcome

A single orchestration facade — `spawnSubagent` — that composes the Phase 1–3
primitives into one fail-closed call: derive the credentialed provider allowlist
+ scoped credentials, build the `SpawnChildInput` (parentModel, allowlist, tiers,
env override, caps) from `HarnessRunConfig`, run `spawnChild` through a shared
run-scoped `RemainingBudgetLedger`, map the resolved selection via `childRunModel`
to the child run input, and expose the `quarantineChildSummary` seam for folding a
child result. Deterministic, zero-dependency, and D-02-preserving (no flow writes).

## Out of Scope

- Monitoring fold / `keryx agents` CLI (roadmap Phase 4).
- Adaptive escalation (roadmap Phase 5); event-sourced fleet / worktrees / peer
  messaging (roadmap Phase 6).
- Cost/token budget enforcement (deferred extension point).
- Actually spawning a live child process/run loop end-to-end — this flow assembles
  and returns the *prepared* child run input + extension; driving `runOffline` for
  the child is the caller's (or a later flow's) concern.
