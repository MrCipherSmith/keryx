# Flow Reviewer Metrics and Validation
Version: 0.1.0

## Purpose

Define measurable quality, traceability, cost, resume, and compatibility targets
for `flow-reviewer`.

## Metrics

| Metric | Target |
|---|---|
| Selected reviewer task coverage | 100% of selected reviewers map to exactly one flow task |
| Skip transparency | 100% of skipped reviewers include a reason |
| Task history completeness | 100% of attempts include dispatch, result or failure, events, model, budget, and timestamps |
| Contract validity | 100% of accepted input/plan/task/output and worker messages validate |
| Context reuse | Shared context generated once per scope revision and referenced by every reviewer task |
| Resume efficiency | Unchanged accepted tasks consume zero additional model tokens |
| Cost visibility | 100% of run tasks record planned and actual token/model metadata when runtime reports it |
| Stale result safety | 100% of fingerprint mismatches create a new attempt |
| Stateless compatibility | One-shot `review-orchestrator` remains functional without Task Manager |
| English artifacts | 100% of generated review documents and reports contain no Russian text |

## Validation Layers

### Static documentation

- Required package files exist and have versions.
- README links resolve.
- JSON schemas parse and validate fixtures.
- Gherkin scenarios parse.
- The roadmap marks the capability as future/specification ready.

### Unit tests

- Input and plan validation.
- Reviewer-to-task one-to-one mapping.
- Stable task ids and attempt numbering.
- Fingerprint calculation and reuse invalidation.
- Model/budget assignment and total budget reservation.
- Status handling for every `subagent-result` outcome.
- Coverage and findings consolidation.

### Integration tests

- Create a review flow in a temporary Metaproject workspace.
- Add/start/complete/fail/retry/skip reviewer tasks only through CLI/service APIs.
- Resume a partially completed review.
- Reuse unchanged completed tasks.
- Invalidate changed scope and create a new attempt.
- Consolidate multiple reviewer results.
- Reject completion with missing coverage or unresolved blockers.

### Regression tests

- Lightweight `review-orchestrator` writes no flow artifacts.
- Embedded `flow-orchestrator` review does not create a nested review flow by
  default.
- Managed review package persistence remains readable during migration.
- No code path directly edits `flow.json`.

## Performance and Cost Tests

- Assert that domain-filtered tasks receive fewer context bytes than the shared
  unfiltered diff for medium/large reviews.
- Assert concurrency never exceeds the configured limit.
- Assert planned task budgets plus retry/consolidation reserve do not exceed the
  total budget.
- Assert cache reuse records zero newly consumed model tokens.

## Review Gates

Implementation is acceptable only when:

- all Gherkin scenarios pass;
- schema fixtures validate;
- focused unit/integration tests pass;
- Code Health contains no new blocker or major regression;
- security review confirms prompt/content boundaries;
- documentation review reports no blockers;
- the catalog routes `flow review`, `review-flow`, `managed review`, and
  `flow-reviewer` to the new skill rather than `review-frontend`.
