# Managed Review Artifact Lifecycle
Version: 0.2.0

## Purpose

Define how managed review artifacts are created, updated, retained, and linked
to flows.

## Creation

A managed review package is created by the current compatibility surface when:

- `review-orchestrator` runs in `attach-review` mode;
- `review-orchestrator` runs in `review-flow` mode;
- a user asks to ingest an existing review report into Task Manager context.

The target architecture lets `flow-reviewer` create and own these artifacts
inside a dedicated review flow with per-reviewer tasks and immutable attempts.
See [Flow Reviewer Artifact Lifecycle](../flow-reviewer/artifact-lifecycle.md).

## Review Id

The review id should be stable and readable:

```text
<date>-<target-kind>-<target-id-or-slug>
```

Examples:

```text
2026-07-09-pr-6015
2026-07-09-branch-pipeline-fixes
```

## Update Rules

- `manifest.json` may be updated by the managed review command or skill only.
- Markdown artifacts may be updated by review orchestration after preserving
  previous decisions or recording replacement rationale.
- `findings.json` must be regenerated from the consolidated review report or
  explicit ingest source.
- Attached reviews must not mutate `flow.json` directly.

## Retention

Managed review packages are retained with their parent flow or standalone review
folder. They are part of the durable project context and should not be deleted
by cleanup unless the parent flow/review package is explicitly archived.

## Completion States

| State | Meaning |
|---|---|
| `draft` | Package exists but review dispatch or consolidation is incomplete. |
| `reviewed` | Report and findings exist. |
| `decided` | Every finding has a disposition in `decisions.md`. |
| `learned` | Learning candidates were proposed/applied or explicitly deferred. |
| `closed` | No remaining review package action is required. |

## Links

Attached review packages should link to:

- parent flow id;
- source issue URL when available;
- PR URL when available;
- health artifact path when used;
- gdctx artifact paths when used;
- skill-learning proposal paths when generated.
