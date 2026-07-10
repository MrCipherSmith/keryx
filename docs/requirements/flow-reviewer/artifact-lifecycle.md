# Flow Reviewer Artifact Lifecycle
Version: 0.1.0

## Purpose

Define creation, mutation, history, retention, resume, and archival rules for a
managed review flow and its per-reviewer tasks.

## Ownership

| Artifact | Owner | Mutation rule |
|---|---|---|
| `flow.json` and task status | Task Manager CLI/service | Never agent-edited |
| Frozen acceptance criteria | Task Manager CLI/service | Change only with reason and checksum update |
| Description, context, plan, tasks, journal | `flow-reviewer` | Append or update with durable rationale |
| Execution plan and output | `flow-reviewer` | Atomic replacement after schema validation |
| Reviewer attempt artifacts | Reviewer dispatch pipeline | Immutable after acceptance |
| Consolidated report/findings/decisions | Stateless consolidation plus `flow-reviewer` | New revision when accepted task results change |

## Creation

1. Create a normal review flow through `keryx flow init`.
2. Create review-specific directories only after flow initialization succeeds.
3. Write input, context manifest, and execution plan atomically.
4. Create reviewer task directories only for selected reviewers.
5. Freeze acceptance criteria before reviewer dispatch.

## Task Attempts

Each task begins with attempt `001`. Every retry or context enrichment creates a
new monotonically increasing attempt directory. An attempt contains the exact
validated dispatch, result, and findings used for its decision.

`events.jsonl` is append-only and records schema-valid agent events. Required
events include dispatch creation, dispatch completion/block/failure, artifact
write, validation failure, retry decision, and task completion.

## Status and History

- Task status transitions occur through Task Manager.
- Review task records mirror, but never replace, Task Manager status.
- A task is complete only when one accepted attempt has a valid result.
- Failed and superseded attempts remain available for audit.
- The flow journal contains concise summaries and links, not duplicated raw
  payloads.

## Resume

On resume:

1. validate flow structure and every referenced JSON artifact;
2. recalculate scope/context/policy fingerprints;
3. identify reusable, stale, incomplete, failed, and blocked tasks;
4. preserve reusable results;
5. create new attempts for stale or incomplete tasks;
6. regenerate consolidation only when accepted results changed.

## Retention

Review flows are durable project context. Cleanup may remove temporary raw
command output only after compact artifacts remain addressable. Accepted task
attempts, decisions, coverage, findings, and learning handoffs remain with the
flow until explicit archive policy removes the entire flow package.

## Sensitive Data

Artifacts must not store secrets, credentials, unrestricted environment dumps,
hidden prompts, or unrelated personal paths. When evidence contains sensitive
content, store a redacted summary and a hash or controlled reference.

## Completion and Archive

Completion freezes the accepted output revision and records final metrics.
Later review of changed code creates a new review flow or a new explicitly
versioned review run; it must not silently mutate a completed review history.
