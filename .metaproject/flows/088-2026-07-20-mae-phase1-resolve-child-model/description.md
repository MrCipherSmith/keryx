# Multi-Agent Engine Phase 1: resolveChildModel resolver (explicit-or-inherit, policy-gated)

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/

## Problem

The keryx harness inherits budget and policy fail-closed for child (subagent)
attempts (`inheritBudget`, `inheritPolicy`), but has no resolver for the
model/provider axis. `makeProvider` ignores its `_model` argument, `run.ts`
resolves a model only at the top level, and nothing threads a model to children.
Model/provider is therefore an unconstrained privilege and cost axis.

## Expected Outcome

A pure, fail-closed `resolveChildModel` resolver — sibling to `inheritBudget` /
`inheritPolicy` — that selects a child's model/provider **explicitly or by
inheriting the parent orchestrator's**, gated by a parent provider allowlist and
the child's resolved policy, plus a `providerClass` classifier and full unit
tests. Resolver + classifier + tests only.

## Out of Scope

- Editing `subagent-dispatch` / `ChildContractExtension` (Phase 2, flow 089).
- Threading into `run.ts` / `makeProvider` (Phase 3, flow 090).
- Cost/token budgeting (deferred extension point).
