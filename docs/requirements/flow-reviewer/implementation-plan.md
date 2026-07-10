# Flow Reviewer Implementation Plan
Version: 0.1.0

## Purpose

Provide an ordered, implementation-ready task map for the future
`flow-reviewer` skill and required runtime extensions.

## Constraints

- Preserve unrelated working-tree changes.
- Implement against the schemas and Gherkin scenarios in this package.
- Keep `review-orchestrator` stateless and backward compatible.
- Change flow state only through Task Manager CLI/service APIs.
- Use test-first slices for state transitions, fingerprints, resume, and routing.

## Phase 1: Contract and Routing Foundation

1. Add schema fixtures and validators for input, execution plan, task record, and
   output.
2. Add `flow-reviewer` to the bundled catalog and installed profiles.
3. Add routing triggers for `flow review`, `review-flow`, `managed review`, and
   `flow-reviewer`.
4. Add a routing regression test proving these phrases do not resolve to
   `review-frontend`.

## Phase 2: Stateless Engine Split

1. Extract or expose `review-orchestrator` `plan-only` behavior.
2. Extract or expose `consolidate-only` behavior.
3. Keep the existing one-shot path as composition of plan, dispatch, and
   consolidate.
4. Add contract tests proving identical reviewer selection and consolidation
   across one-shot and managed paths.

## Phase 3: Generic Task Manager Enhancements

1. Add a backward-compatible `implementation | review` flow kind and
   review-specific completion gates that do not require a new draft PR.
2. Add task start, fail, retry, skip, and blocked transitions to the flow
   service and CLI, or provide equivalent generic attempt APIs.
3. Preserve backward compatibility with existing `todo`, `in-progress`, and
   `done` flows through schema migration.
4. Record immutable task history events and attempt references.
5. Add state-machine, completion-gate, validation, CLI, and migration tests.

## Phase 4: Flow Reviewer Skill

1. Implement create/resume routing and related-flow linking.
2. Build the shared context manifest using graph/ctx/wiki/memory/testing/health.
3. Call `plan-only`, validate the plan, and create one task per selected
   reviewer.
4. Dispatch reviewer tasks in bounded waves with schema validation.
5. Implement status handling, incremental context, retries, and resume.
6. Persist task attempts, events, findings, and cost metrics.

## Phase 5: Consolidation and Completion

1. Call `consolidate-only` with accepted reviewer results.
2. Persist coverage, report, normalized findings, decisions, learning, and
   output.
3. Implement completion gates and acceptance-criteria evidence.
4. Keep fix implementation as a linked follow-up flow, not hidden mutation.

## Phase 6: Migration and Compatibility

1. Reuse or migrate the current managed review package substrate.
2. Deprecate managed lifecycle ownership inside `review-orchestrator` while
   keeping old package reads compatible.
3. Document migration from standalone `.metaproject/reviews/` packages to
   dedicated review flows where appropriate.
4. Verify embedded `flow-orchestrator` review remains lightweight by default.

## Phase 7: Verification

1. Run schema and Gherkin validation.
2. Run focused unit and integration tests.
3. Run review routing, security, and resume regressions.
4. Run Code Health and relevant review skills.
5. Update documentation status only after runtime evidence exists.

## Suggested Atomic Implementation Tasks

| ID | Kind | Task | Depends on |
|---|---|---|---|
| T1 | test | Add contract and routing tests | — |
| T2 | implement | Register `flow-reviewer` and fix routing | T1 |
| T3 | implement | Add stateless plan/consolidate APIs | T1 |
| T4 | test | Add review flow completion, task transition, and history tests | — |
| T5 | implement | Extend Task Manager flow kind and task lifecycle | T4 |
| T6 | implement | Build context manifest and fingerprints | T2, T3 |
| T7 | implement | Materialize and dispatch reviewer flow tasks | T5, T6 |
| T8 | implement | Add resume, cache, retry, and budget enforcement | T7 |
| T9 | implement | Add consolidation, decisions, and completion gates | T3, T8 |
| T10 | docs | Reconcile migration docs and catalog | T9 |
| T11 | review | Run architecture, logic, security, testing, and strict review | T10 |

## Exit Criteria

- Every acceptance scenario is automated and passing.
- All schemas validate valid fixtures and reject invalid fixtures.
- Task history is resumable across processes.
- Reviewer routing is single-source and does not drift from one-shot review.
- Cost/model/context metrics are visible and truthful.
- Documentation status is upgraded from `future` only with code and test
  evidence.
