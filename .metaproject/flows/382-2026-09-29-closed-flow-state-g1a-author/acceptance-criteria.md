# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: When a flow's directory is tracked by git and its files differ from HEAD (modified or untracked inside that directory), `keryx flow complete` ends with one informational note naming the flow and the affected files and saying the closing state is written after the merge and needs committing; with a clean tracked directory, or a directory git does not track, or no git repository, it prints no note, and in every case the exit code and the completion result are unchanged [verify: exec `bun test src/flow/uncommitted-state-note.test.ts`]
- AC2: `keryx flow status <id>` for a flow in status done shows the same note under the same condition, and shows nothing extra for a flow that is not done [verify: exec `bun test src/commands/flow-status-uncommitted.test.ts`]
- AC3: The note gates nothing: a completion with a dirty tracked flow directory still succeeds, and the never-gates and no-model invariants stay green [verify: invariant `bun test src/product/never-gates.test.ts src/product/no-model.test.ts src/product/bulk-budget.test.ts`]
- AC4: Wherever the TUI renders the result of a flow completion or a flow's status, the same note reaches it through the same function, or the TUI shows no closed-flow status at all and the criterion records that [verify: judged]
- AC5: Flow 359's `flow.json`, `journal.md` and its `reviews/` folder are committed by the PR exactly as the CLI wrote them, and the PR touches no other flow directory, no `.metaproject/data` and no untracked flow 352–364 [verify: judged]
- AC6: `docs/requirements/keryx-product-module/metrics-and-validation.md` and `implementation-plan.md` state that G1a is read separately for flows created by a person and flows created by an agent, that agent-created flows are a compliance check and not acceptance, that the hand-classification of the ten flows is recorded next to the reading, and that the split of a real criterion against `not measured — <reason>` stays as a second axis [verify: exec `grep -q 'compliance check' docs/requirements/keryx-product-module/metrics-and-validation.md && grep -q 'compliance check' docs/requirements/keryx-product-module/implementation-plan.md && grep -q 'created by an agent' docs/requirements/keryx-product-module/implementation-plan.md`]
- AC7: `bun run typecheck` is clean, `bun test src/flow src/product` passes, the CLI pins and docs (README or docs site CLI reference where `flow complete` and `flow status` are described, `.metaproject/modules/` flow page if one exists) mention the note, and the CHANGELOG has a 0.3.32 entry with the version bumped [verify: exec `bun run typecheck && bun test src/flow src/product`]
- AC8: After release the work stops: the journal records that the closing-state hole is reported and not gated, that the authorship split is by hand, and that P0 W1 (external agents live) waits for the operator's word [verify: none — a stop is an absence of work; the journal entry and the operator report are the evidence]
