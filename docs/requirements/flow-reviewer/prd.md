# Flow Reviewer PRD
Version: 0.1.0

## Problem

Keryx currently has two useful but incomplete review paths:

1. `review-orchestrator` performs stateless reviewer selection, parallel
   dispatch, and consolidation. It is suitable for direct reviews and for the
   review phase inside `flow-orchestrator`.
2. The managed review runtime persists a package and can associate it with an
   implementation flow, but it does not model every reviewer as a durable Task
   Manager task with its own attempts, status, context, result, and history.

Placing the full managed lifecycle inside `review-orchestrator` couples a
reusable review engine to Task Manager state. Copying the orchestrator would
create two reviewer-selection and consolidation implementations that drift over
time. Running all reviewers with the same context and model also wastes tokens
and hides why a reviewer was selected, skipped, retried, or escalated.

## Goal

Introduce `flow-reviewer` as the Task Manager orchestration layer above
`review-orchestrator`. A managed review must be resumable and auditable: one
flow task per selected reviewer, explicit model and token budgets, compact
shared context, schema-validated messages, durable history, and deterministic
completion gates.

## Users

- Developers who want a traceable review of a PR, branch, commit range, or path.
- Maintainers who need reviewer coverage and cost visibility.
- Agents resuming a partially completed review.
- `flow-orchestrator`, which continues to use lightweight stateless review for
  embedded implementation gates.
- Skill maintainers consuming normalized learning candidates.

## Requirements

### R1: Separate Responsibilities

`review-orchestrator` must remain usable without Task Manager. `flow-reviewer`
must own managed flow state and compose the stateless engine through explicit
plan and consolidation contracts.

### R2: Dedicated Review Flow

A full managed review must create or resume a dedicated Task Manager flow with
review-specific completion gates. When the target is related to an
implementation flow, the review flow must link to it rather than mutating a
completed implementation flow. Completing a review flow must not require
creating another implementation PR.

### R3: One Reviewer Per Task

Every selected reviewer must map to exactly one flow task. Skipped reviewers
must be recorded in the execution plan with reasons but must not create tasks.

### R4: Durable Task History

Every reviewer task must preserve status changes, attempts, assigned model,
budget, context hash, dispatch/result paths, findings, failures, retries, and
timestamps. Flow state changes must go through the Keryx CLI or an equivalent
Task Manager service API, never manual `flow.json` edits.

### R5: Reviewer Selection

The review plan must select only reviewers justified by the target, changed
scope, risk, project conventions, and explicit user flags. `--all` remains an
explicit opt-in, not a safety default.

### R6: Cost-Aware Model Routing

The caller must be able to request an economy, current, adaptive, or explicit
model policy. Adaptive routing should assign cheaper/faster models to bounded
mechanical reviewers and reserve stronger models for complex correctness,
security, high-load, architecture, or strict synthesis work.

### R7: Shared Compact Context

The flow must build one versioned context pack and pass references rather than
duplicating raw content. `gdgraph` narrows affected files and dependencies;
`gdctx` stores compact diff/search/read artifacts; `gdwiki`, memory, testing,
and health are included only when relevant.

### R8: Schema-Governed Communication

Inputs, execution plans, reviewer tasks, outputs, worker dispatches, worker
results, findings, events, and orchestrator state must use JSON Schema
contracts. Invalid messages must not advance task status.

### R9: Resume and Idempotency

A resumed review must reuse completed task results only when target, scope,
context hash, reviewer skill version, and policy fingerprint are unchanged.
Otherwise it must create a new attempt while preserving the earlier history.

### R10: Consolidation and Decisions

After reviewer tasks finish, `flow-reviewer` must call stateless consolidation,
deduplicate findings, run strict synthesis only when required, and persist the
report, normalized findings, coverage, decisions, and learning handoff.

### R11: Completion Gates

The review flow may complete only when required reviewer tasks have terminal
states, coverage explains skipped/failed reviewers, required artifacts validate,
blocking findings have a recorded decision, and acceptance criteria have
evidence.

### R12: Embedded Review Compatibility

`flow-orchestrator` must remain able to invoke `review-orchestrator` directly as
an embedded phase with selected reviewers, an optional cheaper model policy,
and a bounded token budget. It must not be forced to create a nested review
flow.

## Success Criteria

- Every selected reviewer is visible as a distinct Task Manager task.
- A second agent can resume a review using only the flow package and referenced
  artifacts.
- Reviewer coverage distinguishes selected, skipped, failed, retried, and run
  reviewers with reasons.
- Context is generated once per scope revision and referenced by hash.
- Actual token use and model assignment are recorded per reviewer task.
- Unchanged successful reviewer tasks are not rerun on resume.
- `review-orchestrator` continues to work in lightweight mode without flow
  artifacts.
- All schemas and Gherkin scenarios pass validation before implementation is
  declared complete.

## Risks

- Task Manager currently exposes only limited task transitions and a
  draft-PR-gated implementation completion path. It requires a backward-
  compatible review flow kind/completion policy plus start, fail, block, retry,
  and skip task transitions.
- Overly aggressive cheap-model routing can reduce finding quality.
- A shared context pack can become too broad if graph/domain slicing is not
  enforced.
- Reusing task results with an incomplete fingerprint can hide stale review
  output.
- Parallel reviewers can exceed a total budget unless concurrency and budget
  reservation are enforced before dispatch.

## Recommendation

Implement `flow-reviewer` by composition. Extend `review-orchestrator` with
schema-defined `plan-only` and `consolidate-only` entry points, then let
`flow-reviewer` create Task Manager tasks and dispatch each specialized reviewer
directly through the existing `subagent-dispatch` and `subagent-result`
contracts. Add the minimum generic Task Manager capabilities needed for durable
per-task attempts instead of storing hidden state inside the skill.
