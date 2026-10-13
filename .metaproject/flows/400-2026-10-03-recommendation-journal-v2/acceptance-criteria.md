# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With a fixed seed and seq the arm is assigned identically on a repeated run. [verify: exec `bun test src/decisions/arms.test.ts`]
- AC2: In arms B and C no option is preselected; in arm A the recommended option is preselected. [verify: exec `bun test src/tui/composer-choice.test.ts`]
- AC3: In arm D the option text and `recommendationReason` contain none of the words on the stripRecommendedMarks list. [verify: exec `bun test src/decisions/ask.test.ts`]
- AC4: Questions with irreversible, action, or a match in blind.ts always get arm A with `forced: true`; every other arm A decision carries `forced: false`. [verify: exec `bun test src/decisions/arms.test.ts`]
- AC5: The ask_user schema rejects more than one option with `recommended: true`. [verify: exec `bun test src/commands/ask-user-tool.test.ts`]
- AC6: OpenRecord carries arm, seed, preselected, order, channel, forced and recommendation.reason; old records without these fields are still read by the report. [verify: exec `bun test src/decisions/journal.test.ts`]
- AC7: After a deviation from the recommendation in any arm the transcript names the recommended option and its reason. [verify: exec `bun test src/decisions/ask.test.ts`]
- AC8: The round-limit picker and the TUI work decisions are journaled with a `source`; pure permissions (allow/deny) are not journaled. [verify: exec `bun test src/decisions/coverage.test.ts`]
- AC9: With a host available the interviewer skill calls ask_user; without a host it asks no question and returns NEEDS_CONTEXT with its assumptions. [verify: exec `bun test src/decisions/interviewer-path.test.ts`]
- AC10: `keryx decisions open --channel telegram` records the channel; in the report arms A and B are merged for telegram, and everything else is cut by channel. [verify: exec `bun test src/decisions/report.test.ts`]
- AC11: Importing the 87 pre-v2 records sets `legacy: true`, ordinary records go to arm A, blind records go to arm D; the report shows legacy separately and a flag excludes it. [verify: exec `bun test src/decisions/import.test.ts`]
- AC12: `rate` and `rate --blind-model` write a QualityRecord with rater, model and a clean-context flag; the matrix is shown and model ratings are labelled "model self-assessment". [verify: exec `bun test src/decisions/quality.test.ts`]
- AC13: The report shows A-free and A-forced separately. [verify: exec `bun test src/decisions/report.test.ts`]
- AC14: `export` contains no question text and no option text. [verify: exec `bun test src/decisions/export.test.ts`]
- AC15: The guide is updated and states what the journal does not measure, including that A and B are indistinguishable in Telegram. [verify: judged]
- AC16: The arm summary is available in the TUI as a command and as a side-panel section. [verify: judged]
- AC17: Every eligible question whose hash of seed and seq falls in the one-third subsample gets an optional "why" prompt after the answer whether or not the choice matched the recommendation; the subsample is chosen deterministically and recorded before display (`reasonRequested`, `reason` on the record). [verify: exec `bun test src/decisions/reasons.test.ts`]
- AC18: The report and `--json` show the share of named reasons separately for agreement and deviation, and the median `timeToAnswerMs` separately for `reasonRequested` decisions; `export` carries `reasonRequested` and whether a reason was named but never the reason text. [verify: exec `bun test src/decisions/report.test.ts`]
- AC19: Arm weights are read from `.metaproject/decisions.config.json` with defaults A 0.4, B 0.2, C 0.2, D 0.2; an invalid config falls back to the defaults and the report says so; assignment stays deterministic. [verify: exec `bun test src/decisions/arms.test.ts`]
- AC20: Each record carries `eligible` (false exactly when `forced` is true); the report shows ineligible questions on a separate line outside the arm comparison; records without the field are still read. [verify: exec `bun test src/decisions/report.test.ts`]
- AC21: The report shows progress toward flow 392 AC11 (20 decisions, 5 blind) and toward the per-arm threshold (default 150 reversible questions, configurable). [verify: exec `bun test src/decisions/report.test.ts`]
