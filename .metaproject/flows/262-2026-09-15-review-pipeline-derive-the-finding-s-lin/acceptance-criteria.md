# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A finding carries the code it is about as a quote, and `keryx review ingest` derives `line` from locating that quote in `file` at the round's head. A finding whose quote is found at a line other than the one the reviewer reported is recorded at the DERIVED line, and the discrepancy is visible in the package.
- AC2: A finding whose quote cannot be located at the round's head is recorded with a terminal locator state (`unlocatable`) naming why — file absent, or quote not found — and is never recorded with a line number that was not derived. Asserted by a test that feeds a finding quoting code which does not exist in the tree.
- AC3: `keryx review ingest` fills in `id` (by report order) and `problem` (from `title`) when a report omits them, and the repair is REFUSED when the repaired findings would introduce any property `review-finding.schema.json` does not define, or would change the number of findings. Asserted both ways: a report missing `id` and `problem` ingests cleanly; a report whose repair would add an unknown property is refused with that reason.
- AC4: `class_scope`, `evidence`, dispositions and verifier verdicts are NOT repaired. A report omitting any of them is refused exactly as it is today. Asserted by a test that would fail if the repair pass ever widened to them.
- AC5: Cost is visible at three points — `keryx review scope` prints an estimate for the scoped diff before dispatch, `keryx review ingest` records actual usage into the round's `manifest.json`, and `keryx review complete` prints cost per retained finding. A round with no usage reported prints `not recorded`, never `0`.
- AC6: The grouping question (report item D) is decided and the decision is written into the flow's `decisions.md` with its reason — either related-file grouping is implemented in `keryx review scope` and asserted by a test, or it is declined with the evidence for declining. An unrecorded decision does not satisfy this criterion.
- AC7: `review-orchestrator/SKILL.md` and every reviewer whose output contract names a line number are updated to require the quote instead, and the change is limited to the output contract — no reviewer's scope, severity rubric or dispatch rules are altered by this flow.
- AC8: Round-trip evidence: the flow-260 report (`.metaproject/flows/260-*/reviews/`) re-ingests under the new pipeline with every finding's line derived, and the result is compared against what was recorded in September. Any finding whose derived line differs from the recorded one is listed in the flow's report — that list is the measurement of how often the old anchors were wrong.
- AC9: Full gate green on the branch head: `bun test`, `bunx tsc --noEmit -p .`, `bun run lint`.
