# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A package with unverified blocker or major findings fails readiness item `verifier` in `review complete` and `review publish` even when `report.md` has a `Not verified: N` line; it passes only with an operator readiness waiver of `verifier` (card, TTY or `--answered-by`, as `--waive` accepts), and the item's repair text no longer offers the report line. [verify: exec `bun test src/review/readiness-verifier-waiver.test.ts`]
- AC2: A PR-bound package whose PR head moved or merged is refused by `review complete` and fails readiness item `head` even when the report's first line names the reviewed SHA and says the PR moved; it passes only with an operator readiness waiver of `head`, and the repair text no longer tells the agent to edit the report's first line. [verify: exec `bun test src/review/complete-head-gate.test.ts`]
- AC3: `review complete --head <sha>` whose SHA differs from the head recorded at `review start` is refused, naming both SHAs, unless it carries an operator quote recorded through the channels `--waive` accepts (card, TTY or `--answered-by`); the manifest then records the previous head, the new head and the quote. A `--head` equal to the recorded head passes as before. [verify: exec `bun test src/review/complete-head-relabel.test.ts`]
- AC4: A readiness waiver of one of `files-covered`, `blast-radius`, `reviewers`, `ledger` removes only the research errors belonging to that item; an artifact-locator or manifest/dispatch mismatch error, or an error of an item not waived, still refuses the close. [verify: exec `bun test src/review/complete-waiver-scope.test.ts`]
- AC5: `review publish` refuses a package whose round record was edited after `review start` and a package whose report has no valid `Evidence level:` line, with the same messages `review complete` gives; both commands obtain their refusals from one shared gate evaluation function. [verify: exec `bun test src/review/publish-gate-parity.test.ts`]
- AC6: A review published from a package that carries a `confirmedVia: "host-question"` decision states in its body that the decision was not verified by keryx. [verify: exec `bun test src/review/publish.test.ts`]
- AC7: The review-orchestrator skill instructs `model_class` with values the `spawn_subagent` schema accepts, and a test fails when any bundled review skill names a `spawn_subagent` field that the tool ignores or rejects. [verify: exec `bun test src/gdskills/review-spawn-field-contract.test.ts`]
- AC8: Each regression test added for AC1-AC5 fails when its fix is reverted. [verify: judged]
