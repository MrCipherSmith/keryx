# Flow Reviewer Requirements Package
Version: 0.1.0

## Purpose

Define the implementation-ready requirements for `flow-reviewer`: a
Task Manager-aware review orchestrator that creates or resumes a dedicated
review flow, creates one durable flow task per selected reviewer, preserves
task history and artifacts, and delegates stateless review planning and
consolidation to `review-orchestrator`.

## Status

Specification ready. Runtime implementation does not exist yet.

The existing managed review runtime can create review packages, but it does not
provide the required per-reviewer Task Manager lifecycle. This package defines
the target architecture and supersedes the earlier decision that
`review-orchestrator` should own managed review orchestration.

## Architecture Decision

- `review-orchestrator` remains a stateless, reusable review engine. It selects
  relevant reviewers, prepares bounded dispatch contracts, and consolidates
  normalized findings.
- `flow-orchestrator` may call `review-orchestrator` directly as an embedded
  implementation-review phase, with an explicit reviewer list, token budget,
  and cheaper model policy where appropriate.
- `flow-reviewer` owns standalone managed review work: flow creation or resume,
  per-reviewer tasks, status transitions, retries, history, durable artifacts,
  review decisions, and completion gates.
- `flow-reviewer` composes `review-orchestrator`; it must not copy its reviewer
  routing or consolidation logic.

## Document Index

- [Product Requirements](prd.md) - problem, users, requirements, success
  criteria, risks, and recommendation.
- [Specification](specification.md) - architecture, lifecycle, skill surface,
  storage, contracts, integrations, and acceptance criteria.
- [Agent Protocol](agent-protocol.md) - deterministic orchestration procedure
  for agents.
- [Model and Token Policy](model-and-token-policy.md) - model assignment,
  context budgets, reuse, and escalation rules.
- [Best Practices](best-practices.md) - external primary-source guidance and
  its Keryx-specific application.
- [Artifact Lifecycle](artifact-lifecycle.md) - storage, history, retention,
  retries, and resume behavior.
- [Metrics and Validation](metrics-and-validation.md) - measurable targets and
  verification strategy.
- [Implementation Plan](implementation-plan.md) - staged implementation tasks
  and dependency order.
- [Gherkin Acceptance Scenarios](acceptance.feature) - executable behavioral
  contract for implementation and regression testing.
- [Flow Reviewer Input Schema](schemas/flow-reviewer-input.schema.json) - caller
  configuration contract.
- [Review Execution Plan Schema](schemas/review-execution-plan.schema.json) -
  selected/skipped reviewers, task mapping, budgets, and context references.
- [Reviewer Task Record Schema](schemas/reviewer-task-record.schema.json) -
  durable per-reviewer task attempts and events.
- [Flow Reviewer Output Schema](schemas/flow-reviewer-output.schema.json) - final
  flow outcome, coverage, findings, artifacts, and cost metrics.

## Scope

- Add a canonical `gdskills/review/flow-reviewer` skill.
- Run managed review work through `keryx flow` and Task Manager state.
- Add a review flow kind/completion policy that does not require an
  implementation draft PR.
- Create exactly one review task for every selected specialized reviewer.
- Preserve selected, skipped, failed, retried, and completed reviewer history.
- Reuse existing gdskills dispatch, result, finding, event, and orchestrator
  schemas.
- Build one shared, hash-addressed context pack with `gdgraph`, `gdctx`,
  `gdwiki`, memory, testing, and health evidence where relevant.
- Route only relevant reviewers and use budget-aware model assignments.
- Support resume, bounded retries, strict synthesis, findings decisions, and
  skill-learning handoff.
- Keep every generated user-facing review artifact in English.

## Non-Goals

- Reimplement specialized reviewer logic.
- Replace `review-orchestrator` for lightweight or embedded review.
- Make every `flow-orchestrator` review phase create a separate review flow.
- Run every available reviewer by default.
- Store raw prompts, unrestricted diffs, secrets, or redundant full context in
  each reviewer task.
- Apply code fixes or skill-learning proposals without a separate approved
  workflow.

## Related Packages and Modules

- [Managed Review Feedback Loop](../managed-review-feedback-loop/README.md) -
  existing review package persistence and CLI substrate.
- `tasks` / `flow` - source of truth for lifecycle and task status.
- `gdskills` - skill catalog, routing, dispatch/result contracts, and reviewers.
- `gdgraph` - scope, dependency, affected, and symbol context.
- `gdctx` - compact diff, command, search, and file-read artifacts.
- `gdwiki` and memory - architecture, decisions, constraints, and lessons.
- `testing` and `health` - reusable verification evidence.

## Implementation Status

The package describes future behavior. Existing code supports generic flows and
managed review package persistence, but does not yet provide the `flow-reviewer`
skill, review-plan handoff modes, or per-reviewer flow task history defined here.
