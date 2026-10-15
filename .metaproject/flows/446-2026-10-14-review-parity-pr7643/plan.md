# Implementation Plan

Status: draft, awaiting operator review

## Approach

Small, independent changes in `src/review/` and the review skills, one commit per acceptance criterion, in a fresh worktree off `origin/main` (the local `~/keryx` main is stale). Order: AC1 (bug, unblocks dispatch-check), AC2, AC4, AC5, AC3, AC7, AC6, AC8, AC9, AC10, AC11. Each change is opt-in or additive, so existing packages and tests behave as before.

## Steps

1. Worktree off `origin/main`, new branch `feat/review-parity`.
2. AC1: add `routed` to the model block of `reviewer-input.schema.json`; test in `dispatch-check.test.ts`.
3. AC2: `retainCommentBlocks` in `ReviewScopeConfig` (`scope.ts`), set by the CLI from the repo's convention sources; reason `kept:comment-rule`.
4. AC4: `kind` on the mutant spec and `MutantResult`; hold logic in `severity-audit.ts`.
5. AC5: follow-up parsing in `ledger.ts`, schema field `follow_ups` in `reviewer-finding.schema.json`, report section.
6. AC3: `mutant_candidates` in the testing reviewers' contract; `cap` and `not_reached` in `MutationRecord`; table and report rendering.
7. AC7: shell-host rule in the orchestrator skill; bounded NEEDS_CONTEXT in `retry-plan.ts`.
8. AC6: bundled skill `review-pr-contract`, catalog entry, routing table, iron-law tests.
9. AC8: shell `/review` view, sidebar, `review status`.
10. AC9: reference-PR replay fixture and test. AC10 to AC11: skill ceiling, docs, CHANGELOG, version.
11. Review orchestrator, PR, green CI, merge, release, install check from npm, close the flow.

## Risks

- More noise from docstring-only PRs: AC2 stays opt-in.
- Mutation run time on large diffs: keep the timeout and the `runnable:false` escape.
- `kind: presentation` is chosen by the mutant author and can be mislabelled; the report shows every held severity so the operator can see them.
- SKILL.md ceiling (R1-10): details go to `SKILL.detail.md`.
