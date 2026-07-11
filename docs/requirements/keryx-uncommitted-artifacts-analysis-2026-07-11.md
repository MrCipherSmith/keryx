# Uncommitted Artifacts Analysis
Version: 1.0.0
Date: 2026-07-11

## Executive summary

The 66 files shown as unstaged are not one feature implementation. They are
three different classes of Metaproject artifacts: generated memory metadata,
execution-metrics job evidence, and the immutable source review for the harness
requirements work. None is required by the harness runtime or by the already
published feature branches.

## Classification

| Group | Count | Importance | Recommended handling |
|---|---:|---|---|
| `.metaproject/data/memory/artifacts/latest.{json,md}` | 2 | Low for implementation; generated query cache | Do not include in feature commits; regenerate when needed |
| `.metaproject/jobs/task--execution-metrics-direct-mode/` | 10 | Important for job provenance and test evidence | Keep with the execution-metrics job or publish as a dedicated documentation commit |
| `.metaproject/reviews/2026-07-10-review-flow-users-tsaitler-aleksandr-goodea-goodpro-/` | 54 | Important audit evidence; immutable | Preserve unchanged; do not mix into feature commits |

## Verification evidence

- JSON parsing: `UNSTAGED_JSON_PARSE files=23 errors=0` for all JSON files in
  the job, review, and observability groups that were present in the worktree.
- Observability Draft 2020-12 schema: `OBSERVABILITY_SCHEMA_COMPILE_OK`.
- Markdown link audit: zero missing links in the checked job/review/package
  documents.
- The stale Version 0.1.0 observability draft was not staged or deleted. It was
  preserved at `/private/tmp/keryx-observability-draft-backup-20260711/` while
  the canonical Version 0.2.0 remains in the dedicated
  `feature/keryx-execution-observability` worktree.

## Branch ownership

| Branch | Responsibility | Commit |
|---|---|---|
| `feature/keryx-harness-docs` | Harness requirements, schemas, fixtures, reviews, handoff | `13676f0` |
| `feature/execution-metrics-direct-mode` | Execution metrics runtime and direct-mode gate | `2328377` |
| `feature/keryx-execution-observability` | Observability runtime and Version 0.2.0 requirements | `d887458` |
| `feature/keryx-change-report` | Verification/change report | `b20d90c` |

The harness, metrics, observability, and analysis branches are published to
the `MrCipherSmith/keryx` remote. This analysis branch contains only this
report and is intentionally separate from those feature branches.

After this report was prepared, the superseded
`feature/keryx-change-report` branch was deleted locally and remotely. Its
report commit remains reachable through `feature/keryx-uncommitted-analysis`.

## Decision

The artifacts are useful for audit and reproducibility but should not be
committed together. Keep the immutable review and metrics job evidence outside
runtime feature commits; leave generated memory metadata local unless a
separate Metaproject maintenance change explicitly requires it.
