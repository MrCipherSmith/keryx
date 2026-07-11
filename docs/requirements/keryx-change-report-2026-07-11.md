# Keryx Change Verification and Branching Report
Version: 1.0.0
Date: 2026-07-11

## Scope

This report records the read-only verification of the mixed working-tree
changes and the resulting branch separation. It does not claim new runtime
implementation and does not modify the immutable source review.

## Canonical branch mapping

| Concern | Canonical branch | Commit | Worktree status |
|---|---|---|---|
| Project Agent Harness requirements, schemas, fixtures, review evidence | `feature/keryx-harness-docs` | `13676f0` | committed; push previously rejected by GitHub permissions |
| Execution Metrics runtime and direct-mode gate | `feature/execution-metrics-direct-mode` | `2328377` | clean worktree; existing job report records 509/509 full tests |
| Execution Observability runtime and requirements | `feature/keryx-execution-observability` | `d887458` | clean worktree; canonical requirements are Version 0.2.0 |
| This report | `feature/keryx-change-report` | current commit | isolated from the feature branches |

## Verification performed

- Parsed 23 JSON files from the unstaged job/review/observability groups:
  `UNSTAGED_JSON_PARSE files=23 errors=0`.
- Compiled the observability Draft 2020-12 schema with bundled Ajv:
  `OBSERVABILITY_SCHEMA_COMPILE_OK`.
- Checked Markdown links in the three unstaged groups: zero missing links.
- Confirmed the observability worktree is clean and contains the newer Version
  0.2.0 package.
- Confirmed the current worktree had no production-code modifications in the
  unstaged groups.

## Important finding and action

The current worktree contained an older Version 0.1.0 observability draft that
diverged from the canonical Version 0.2.0 branch. It was not staged or deleted.
It was moved intact to:

`/private/tmp/keryx-observability-draft-backup-20260711/`

The canonical Version 0.2.0 remains in the dedicated observability worktree.

## Remaining local artifacts

These artifacts remain outside the feature branches and require a separate
decision:

- `.metaproject/data/memory/artifacts/latest.{json,md}` — generated memory query
  metadata, not feature implementation.
- `.metaproject/jobs/task--execution-metrics-direct-mode/` — direct-mode job
  reports; keep with the metrics job if they are to be versioned.
- `.metaproject/reviews/2026-07-10-review-flow-users-tsaitler-aleksandr-goodea-goodpro-/`
  — immutable baseline review evidence; do not modify or mix into feature
  commits.

## Recommendation

Keep the three implementation concerns on their existing branches. Do not
stage the generated memory metadata or immutable baseline review into a feature
branch. If the direct-mode job reports need publication, add them in a small
dedicated documentation commit on the metrics branch after confirming the
desired repository ownership.
