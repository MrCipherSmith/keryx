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

- AC1: `keryx review` with no subcommand reviews the current branch against its base: at a terminal it runs the autonomous profile and prints the verdict, and inside an agent session it prints the instruction to load the orchestrator skill; it never only writes `round.json`. [verify: exec `bun test src/commands/review-default.test.ts`]
- AC2: `keryx review --help` opens with a paragraph describing a round and lists at most ten commands a person runs; the remaining commands are shown by a separate agent help command, and every existing subcommand appears in exactly one of the two. [verify: exec `bun test src/commands/review-help.test.ts`]
- AC3: A glossary page defines each term the help and the quick-start use (at least round, package, wave, slice, ledger, readiness, premise, disposition, floor, tier), and a test fails when the help uses a listed term the glossary lacks. [verify: exec `bun test src/docs/review-glossary.test.ts`]
- AC4: `docs/docs/guides/review-with-a-record.md` has no repeated section heading, and a quick-start of under 1000 words leads from a diff to a first report. [verify: invariant `bun test src/docs/review-guide-headings.test.ts`]
- AC5: The docs carry a capability matrix per harness (keryx shell, Claude Code, Codex, opencode, Grok, CI bot) for parallel reviewers, model class, operator cards, usage capture and unattended runs, and state that hosts without a spawn tool run the round on keryx's own provider. [verify: judged]
- AC6: `onboarding.md` no longer presents a bare `keryx review start` as the review step. [verify: judged]
- AC7: `keryx review metrics` reports rounds per change, the share of packages closed, and cost per round where measured. [verify: exec `bun test src/review/bot/metrics.test.ts`]
- AC8: A person following only the quick-start on a fresh clone reaches a first report. [verify: judged]
