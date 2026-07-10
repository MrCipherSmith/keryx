# Managed Review Feedback Loop PRD
Version: 0.2.0

## Problem

Implementation flows can complete with a narrow internal review gate, while a
later standalone `review-orchestrator` run can find additional valid issues. When
that later review is not attached back to the flow, the system loses important
context:

- which reviewers ran before flow completion;
- which reviewers found issues afterward;
- whether findings should update project skills, process skills, or memory;
- whether the original flow had a coverage gap or the finding was a legitimate
  non-blocking follow-up.

This creates a weak feedback loop. The review may be correct, but the next
implementation flow cannot learn from it reliably.

## Goal

Make review results durable and traceable through a reusable managed review
package runtime. The future `flow-reviewer` orchestration layer attaches or
links those packages to Task Manager flows, while stateless
`review-orchestrator` supplies review planning and consolidation. The system
preserves review coverage, findings, decisions, and skill-learning candidates
in a format future agents can consume.

## Users

- Implementation agents running `flow-orchestrator`.
- Review agents running `review-orchestrator`.
- Maintainers auditing why a flow was approved.
- Skill maintainers updating project skills from repeated review findings.
- Developers who want a PR review report without losing task context.

## Requirements

### R1: Detect Related Flow

When reviewing a PR, branch, issue, or path in managed mode, the managed review
caller must attempt to locate related flow metadata by PR URL, issue URL, branch
name, or source reference.

### R2: Support Two Managed Modes

The review system must support:

- `attach-review`: store review artifacts under an existing flow package;
- `review-flow`: create a standalone managed review package when no flow exists
  or the user requests independent review tracking.

### R3: Persist Review Artifacts

Managed reviews must write durable artifacts:

- review scope;
- reviewer coverage matrix;
- consolidated report;
- normalized findings;
- skill-learning decisions;
- follow-up decisions.

### R4: Preserve Lightweight Reviews

Users must still be able to run a simple review that prints a report without
creating or modifying flow state.

### R5: Classify Post-Flow Findings

When a review attaches to an already completed flow, every finding must be
classified as one of:

- `missed_by_flow_gate`;
- `valid_followup`;
- `out_of_scope`;
- `skill_learning_candidate`;
- `false_positive`.

### R6: Record Skill Learning Handoff

Managed review packages must include a `Skill Learning` section even when the
decision is `none`. Learning candidates must identify the target skill, source
finding ids, and proposed command or next step.

### R7: Do Not Over-Block

Minor and info findings must not reopen or fail a completed flow by default.
They may create follow-up tasks or skill-learning entries when classified as
preventable process gaps.

## Success Criteria

- A review of a PR linked to a flow writes a review package under that flow.
- The review package records which reviewers ran and which were skipped with
  reasons.
- A later agent can read one package and understand the issue, PR, flow,
  review scope, findings, and skill-learning decisions.
- A review finding that should have been prevented by a project/process skill is
  routed into a learning proposal workflow.
- Standalone review mode remains available and does not require Task Manager.

## Risks

- Review runs become too heavy if every invocation creates flow state.
- Agents may over-classify ordinary nits as skill drift.
- Existing flow CLI may need extensions to record review artifacts safely.
- Persisted review reports can become noisy if raw diffs are copied instead of
  compact context references.

## Recommendation

Keep the implemented package persistence and CLI as a low-level substrate.
Implement managed lifecycle in `flow-reviewer`, which composes stateless
`review-orchestrator` planning and consolidation. Keep plain report-only review
as the default one-shot mode, and require explicit managed review intent before
creating Task Manager state.
