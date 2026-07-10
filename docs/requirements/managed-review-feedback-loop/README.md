# Managed Review Feedback Loop
Version: 0.2.0

## Purpose

Define the low-level managed review persistence and feedback package used to
preserve review context, reviewer coverage, findings, decisions, and
skill-learning handoff as durable artifacts.

## Status

First runtime slice implemented. The CLI/runtime supports managed review package
creation for attach-review, review-flow, ingest, status, complete, and
lightweight report-only mode.

Target orchestration ownership has changed: the future
[Flow Reviewer](../flow-reviewer/README.md) skill owns Task Manager lifecycle,
per-reviewer tasks, attempts, resume, and completion. `review-orchestrator`
remains a stateless review planning and consolidation engine. The current
runtime slice is a persistence substrate to migrate or compose, not the final
orchestration boundary.

## Document Index

- [PRD](prd.md) - problem, users, requirements, risks, and recommendation.
- [Specification](specification.md) - planned structure, CLI/skill behavior,
  data contracts, and acceptance criteria.
- [Agent Protocol](agent-protocol.md) - orchestration rules for attach-review
  and standalone managed review.
- [Artifact Lifecycle](artifact-lifecycle.md) - storage, retention, and update
  rules for managed review artifacts.
- [Metrics and Validation](metrics-and-validation.md) - measurable validation
  and regression checks.
- [Managed Review Package Schema](schemas/managed-review-package.schema.json) -
  planned machine-readable review package manifest.

## Scope

- Attach a standalone `review-orchestrator` run to a related flow when a PR or
  issue link matches existing flow metadata.
- Persist consolidated review reports, reviewer coverage, finding summaries,
  and skill-learning decisions under the Task Manager workspace.
- Make post-flow review findings available to future `flow-orchestrator`,
  `job-orchestrator`, `review-orchestrator`, and `entity-skill-learner` runs.
- Preserve lightweight review mode for users who only need a fast report.
- Provide persistence primitives reusable by `flow-reviewer`.

## Non-Goals

- Do not require every review to create or mutate a flow.
- Do not auto-apply code fixes from review findings.
- Do not apply skill-learning proposals without a read-and-approve step.
- Do not make minor or info findings block a completed flow by default.

## Related Modules

- `tasks` / `flow`: owns flow state and lifecycle gates.
- `gdskills`: owns review, orchestration, skill learning, and worker contracts.
- `flow-reviewer`: future owner of managed review orchestration and task history.
- `gdctx`: provides compact diff/search/read artifacts for review context.
- `memory`: stores accepted long-lived lessons after review decisions.
- `health`: contributes quality gate evidence when a review is attached to a PR.
