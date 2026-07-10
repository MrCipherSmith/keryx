# Keryx Execution Observability Implementation Plan
Version: 0.2.0

## Purpose

Sequence the work so the measurement foundation exists before lightweight mode
or Keryx/no-Keryx performance claims depend on it.

## Phase 1 — Provenance Foundation

- Add the run schema and validator.
- Add run id, commit, branch, worktree, parent run, and source metadata.
- Normalize gdctx, testing, health, graph, and subagent events.
- Render Markdown from canonical JSON.

Exit criteria: a direct and a dispatched run both produce valid, ownership-correct
records with exact/estimated/unknown labels.

## Phase 2 — Artifact and CLI Reliability

- Persist immutable per-run testing and health records.
- Add atomic latest pointers with freshness checks.
- Make hooks linked-worktree safe.
- Implement or remove `keryx index refresh` consistently.

Exit criteria: worktree and latest-pointer regression tests pass.

## Phase 3 — Baseline and CI

- Fix or separately track the `standard validate` baseline defect on `main`.
- Add baseline/pr classification to CI.
- Add metrics-contract CI coverage.

Exit criteria: CI distinguishes baseline-red from PR-introduced failures.

## Phase 4 — Lightweight Mode

- Add execution profile selection and bounded phase routing.
- Preserve focused testing and one reviewer.
- Record skipped phases and reasons.

Exit criteria: small-task runs are comparable to full runs without silent gate loss.

## Phase 5 — Benchmark

- Select 3–5 representative tasks.
- Run paired Keryx and non-Keryx executions.
- Publish comparison with uncertainty and quality outcomes.

Exit criteria: maintainers can decide which Keryx phases to keep, shorten, or make optional.

## Dependencies

- Phase 1 depends on runtime/gdctx event availability.
- Phase 2 depends on the schema and provenance contract.
- Phase 3 depends on standard validator ownership and CI workflow access.
- Phase 4 depends on reliable focused-test and reviewer selection signals.
- Phase 5 depends on all prior phases and a stable task corpus.

## Rollout and Compatibility

Use additive records and compatibility readers first. Existing Markdown reports
remain readable. Unknown fields are allowed during migration, but new writers
must emit schema version and provenance whenever available.

## Implementation Status

- Phase 1: implemented with runtime schema validation, provenance, stable JSON,
  Markdown rendering, event accounting, and retry taxonomy.
- Phase 2: implemented with immutable testing/health run records, latest
  pointers, mismatch detection, and linked-worktree-safe hooks.
- Phase 3: implemented with object-capability schema compatibility and
  baseline/pr classification. CI execution remains environment-owned.
- Phase 4: implemented as a bounded plan selector with focused tests, one
  reviewer, skipped-phase reasons, and required security/test gates.
- Phase 5: harness/template and validation are implemented; no paired task
  corpus has been selected or executed.
