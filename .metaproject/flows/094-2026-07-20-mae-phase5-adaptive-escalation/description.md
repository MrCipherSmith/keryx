# Multi-Agent Engine Phase 5: adaptive model escalation

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/ (brainstorm C2, roadmap Phase 5)

## Problem

The engine (flows 088–092, merged) can resolve a child's model (explicit or
inherited/tier), spawn it fail-closed, and monitor a fleet — but every subagent
runs on a SINGLE model chosen up front. Simple subtasks over-pay on a flagship
model, while hard ones that fail on a cheap model have no path to retry stronger.
There is no cost-aware "try cheap, escalate on evidence" policy.

## Expected Outcome

A pure, deterministic **adaptive escalation** policy layer: an initial-tier
classifier over the task description, an escalation predicate over the canonical
`subagent-result` disposition, and an `escalate` driver that runs a model LADDER
(cheap→standard→deep) — advancing a rung only when the result warrants it, each
rung a new `attempt.number` on the same `branchId`, emitting `tier_escalated`
decision events, and **self-truncating** when the shared budget ledger can no
longer admit the next rung. Reuses the existing attempt/branch + ledger + model
machinery; adds no new subsystem.

## Out of Scope

- Actually executing a child run loop — the driver runs rungs via an INJECTED
  `runRung` callback (the real executor is the orchestrator's / a later concern),
  keeping this layer pure and testable.
- Event-sourced fleet / worktrees / peer messaging (Phase 6).
- Cost/token BUDGET enforcement in currency (deferred `maxCostUnits` hook); this
  phase governs escalation by the existing runtime/tool-call ledger only.
