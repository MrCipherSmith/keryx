# Managed Review Agent Protocol
Version: 0.2.0

## Purpose

Define the compatibility protocol for managed review package persistence without
losing Task Manager context or over-blocking completed flows. The future
per-reviewer Task Manager protocol is owned by
[Flow Reviewer](../flow-reviewer/agent-protocol.md).

## Modes

### Lightweight Review

Use when the user asks for a quick review and no durable trace is needed.
Output a consolidated report only.

### Attach Review

Use when a PR, issue, branch, or explicit flow id maps to an existing flow.
Write review artifacts under:

```text
.metaproject/flows/<flow-dir>/reviews/<review-id>/
```

### Review Flow

Use when no implementation flow exists but the user wants a managed review
lifecycle. Write review artifacts under:

```text
.metaproject/reviews/<review-id>/
```

### Ingest Existing Review

Use when a user already has a review report and wants it attached to a flow or
converted into learning/follow-up decisions.

## Required Agent Steps

1. Build review context from target metadata, diff/path scope, existing flow
   metadata, and compact gdctx artifacts.
2. Resolve related flow by explicit id, PR URL, issue URL, or branch metadata.
3. Use stateless `review-orchestrator` to select reviewers and record the
   reviewer coverage plan before dispatch.
4. Dispatch reviewers with explicit schema-governed payloads.
5. Consolidate findings into `report.md`.
6. Normalize findings into `findings.json`.
7. Classify each finding, especially post-flow findings.
8. Write `learning.md` with candidates or `none`.
9. Write `decisions.md` with the chosen disposition per finding.
10. Complete the review package only after required artifacts exist.

For a full managed lifecycle with one flow task and history per reviewer, route
to `flow-reviewer`. Do not extend this compatibility protocol by duplicating
reviewer orchestration.

## Classification Rules

| Classification | Meaning |
|---|---|
| `missed_by_flow_gate` | The original flow should reasonably have caught this before completion. |
| `valid_followup` | The finding is valid but not required for the original acceptance criteria. |
| `out_of_scope` | The finding is outside the reviewed task boundary. |
| `skill_learning_candidate` | A project/process skill should be updated to prevent recurrence. |
| `false_positive` | The finding is unsupported after verification. |

## Blocking Policy

- Blockers and majors may require fix tasks before review completion.
- Minor and info findings do not reopen completed flows by default.
- Minor and info findings may still produce learning candidates when they
  reveal a preventable process or checklist gap.

## Safety Rules

- Never edit `.metaproject/flows/<id>/flow.json` by hand.
- Never mark a finding as fixed unless code or documentation evidence exists.
- Never apply `skills learn apply` without reading the proposal.
- Never store raw large diffs in managed review packages when gdctx artifacts or
  compact summaries are sufficient.
