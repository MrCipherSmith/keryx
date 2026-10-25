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

- AC1: `keryx review status` on a `cp -a` copy of the vantage-frontend #8174 package (`2026-10-23-review-flow-github-com-presight-ai-vantage-frontend-`; the package is unfinished, its report is a stub, so `review complete` is refused on it) prints one line that shows the plan 28-70 min (54 dispatches), the actual time from first to last raw of about 43 min (67 raw replies) and 0 pauses longer than 10 min. [verify: judged]
- AC2: the same on a copy of #8086 (`vantage-frontend-pr8086`, plan 44-110 min, 88 dispatches) shows 106 min from first to last raw, one pause longer than 10 min of 59 min, and about 46 min without it. [verify: judged]
- AC3: `review complete` writes the line into `report.md` after the `Evidence level:` line and returns it, a second `review complete` on the same package leaves exactly one such line, and a package with neither a recorded plan nor raw replies gets no line and an untouched report. A package with raw replies and no plan, or a plan and no raw replies, gets a line that names what is missing. [verify: exec `bun test src/review/estimate-actual.test.ts src/review/estimate-actual-complete.test.ts`]
- AC4: time marks that cannot belong to the round (the first raw reply older than `plan.json`, as in a copied package) are said to be unusable instead of printed as a duration. [verify: exec `bun test src/review/estimate-actual.test.ts`]
- AC5: the estimate parameters keep their values: a test pins `TYPICAL_DISPATCH_MINUTES=2`, `CHILD_DEADLINE_MINUTES=5`, `ASSUMED_PARALLEL_DISPATCHES=4`, `DEFAULT_MAX_DISPATCHES=40`, `DEFAULT_MAX_MINUTES=90`, and the diff of `src/review/estimate.ts` shows no change to them. [verify: exec `bun test src/review/estimate.test.ts`]
- AC6: the review panel shows the same line for a review row (`formatReviewDepthRowLines`), for an open round as "so far" and for a closed one; a row without anything to show is unchanged. [verify: exec `bun test src/tui/review-panel.test.ts src/tui/review-inspector.test.ts`]
- AC7: `docs/docs/cli-reference.md`, `docs/docs/guides/review-with-a-record.md`, the `review complete` help and `CHANGELOG.md` describe the line, its source files and the 10-minute pause threshold. [verify: judged]
- AC8: `bun run typecheck` is clean and the tests of the touched modules pass. [verify: exec `bun run typecheck`]
- AC9: acceptance ran on copies made with `cp -a`; the originals of #8174 and #8086 have the same path, size and mtime before and after (fingerprints in `verification.md`). [verify: judged]
- AC10: `verification.md` lists per requirement H1-H2 the evidence of its `Verification:` field, the doc-versus-code discrepancies, and what could not be checked. [verify: judged]
- AC11: nothing is committed or pushed before the operator's word, and no AI attribution appears in files, branch names, commit messages, PR text or flow text. [verify: judged]
