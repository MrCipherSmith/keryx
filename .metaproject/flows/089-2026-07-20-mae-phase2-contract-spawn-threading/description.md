# Multi-Agent Engine Phase 2: model block contract + spawnChild threading

Status: ready to freeze
Source: user description + docs/requirements/keryx-multi-agent-engine/

## Problem

With `resolveChildModel` available (Phase 1, flow 088), the child dispatch
contract and spawn path still cannot express or carry a model selection. The
`subagent-dispatch` schema has no `model` block, `ChildContractExtension` carries
no `modelSelection`, and `spawnChild` never resolves a model.

## Expected Outcome

The dispatch contract gains an optional `model` block (the agent-definition
surface), `ChildContractExtension` carries a resolved `modelSelection`, and
`spawnChild` resolves the child model after the policy gate — fail-closed, with
guard order budget → policy → model. Fully backward-compatible: a dispatch with
no `model` block behaves exactly as today (inherit parent).

## Out of Scope

- `resolveChildModel` itself (Phase 1, flow 088 — depends on it).
- Threading into `run.ts` / provider construction, caps, ledger, quarantine
  (Phase 3, flow 090).
- Cost/token budgeting (deferred extension point).
