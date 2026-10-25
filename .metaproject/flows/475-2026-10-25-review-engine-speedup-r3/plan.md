# Implementation Plan

Status: draft

## Approach

Fix the accounting where it goes wrong, in `reviewNext`, instead of adding a second pass: replace "one newest reply per reviewer" with an ordered list of replies per reviewer and feed them one by one through the existing `evaluateRetry` / `planRetry` state machine, so attempt, stall and processed-hash bookkeeping stay the engine's own. `.prev` files are excluded by name; the wave number comes from the `-w<n>` suffix or the driver's `wave`, mtime only breaks ties and covers files with no number; a reply already in `processed` is skipped, which makes a second call idempotent.

For a finished reply with no `slices` array the spec offers "take coverage from the driver or reject". Reject is chosen: the ledger already treats a reply with no list as covering none, and taking the driver's list would count slices nobody confirmed. The reply is reported as `rejected` with a reason and its reviewer's slices stay open.

The `needs_context` shape is read by one exported helper (`needsContextQuestions`) used by `retry-plan.ts`, `retry-eval.ts` and `ledger.ts`, so the three places can no longer disagree.

## Steps

1. `retry-plan.ts`: add `needsContextQuestions(value: unknown): string[]` (strings kept, objects read through `question` / `text` / `message` / `id`, else JSON text, empties dropped); use it in the retry plan; the `ReviewerResult.needs_context` type becomes `unknown`.
2. `retry-eval.ts` and `ledger.ts`: use the helper for the open-question check.
3. `review-next.ts`: ordered replies per reviewer, `.prev` exclusion, hash dedupe, sequential evaluation, escalations from every reply, `rejected` in `NextResult` and `renderNext`, old-format `retry-state.json` hardening.
4. Tests in `review-next.test.ts`, `retry-plan.test.ts`, `retry-eval.test.ts`.
5. Docs: the four copies of the `review-orchestrator` skill, `docs/docs/cli-reference.md`, `docs/docs/guides/review-with-a-record.md`, `README.md`, `CHANGELOG.md` `[Unreleased]`.
6. Acceptance on copies of #8174, #8111, #8158, #8086 against the baselines taken on main; `verification.md`.

## Risks

- Several old replies processed in one call can move the attempt and stall counters; the last plan wins and a later reply that covers everything overrides `notRun`.
- Rejecting slice-less `DONE` replies may add re-dispatches on the closed #8086 (`clean-code`, `layout`); the copy run shows it and it goes into `verification.md`.
- `review-next.ts` is also changed by PR #1083 (R1+R2): a merge conflict is expected and will be resolved at merge.
