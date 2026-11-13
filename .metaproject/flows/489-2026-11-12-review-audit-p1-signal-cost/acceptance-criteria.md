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

- AC1: Readiness has an item that fails when a dispatch of the round has no measured usage record, and the item's message gives the share of dispatches with unknown usage; `review start` and `review complete` record wall-clock timestamps from which the round duration is derived. [verify: exec `bun test src/review/readiness-usage.test.ts`]
- AC2: The rendered report's verdict block states round duration, total tokens with the share that is measured, and the round number. [verify: exec `bun test src/review/report-cost-line.test.ts`]
- AC3: No bundled reviewer skill other than the orchestrator assigns `blocker` to a checklist item inline; severity guidance in each is a table mapping a condition to a shape of the canonical rubric, and a test fails on an inline `— **blocker**` in any bundled reviewer skill. [verify: exec `bun test src/gdskills/review-severity-rubric.test.ts`]
- AC4: Negative enumeration has one rule: the form the orchestrator skill teaches validates against `reviewer-finding.schema.json` and `review-finding.schema.json`, and a test validates the skill's own example against both. [verify: exec `bun test src/gdskills/review-finding-class-scope.test.ts`]
- AC5: No bundled reviewer skill carries an inline markdown finding template; each refers to the schema's field names, and a test fails when a `**Why it matters**` template reappears. [verify: exec `bun test src/gdskills/review-finding-template.test.ts`]
- AC6: `report.md` holds no findings JSON; the machine-readable array lives in a sibling file that `review ingest` reads, and the published body lists blockers, majors and at most ten minors with the remainder as one counted line. [verify: exec `bun test src/review/report-bounded.test.ts`]
- AC7: A reviewer with `stack_requires` naming several tags is dispatched only when the project carries all of them, unless the skill marks the list as any-of; `review-frontend` and `review-frontend-conventions` are not dispatched on a React project without MobX. [verify: exec `bun test src/review/stack.test.ts`]
- AC8: A report cannot state that a cross-family review ran unless a dispatch on the named provider family is recorded with its `executionId`; otherwise the field reads as eligibility. [verify: exec `bun test src/review/cross-family.test.ts`]
- AC9: A benchmark of seeded defects exists for the core reviewer set, with a committed baseline of precision and recall and an offline CI job that fails when the fixture replay diverges from the baseline; the live run is documented as manual. [verify: judged]
- AC10: One managed round run on a real pull request after the changes shows the duration, token and verdict lines in its report. [verify: judged]
