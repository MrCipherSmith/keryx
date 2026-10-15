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

- AC1: `SKILL.md` and `SKILL.detail.md` of the review-orchestrator (bundled and `.metaproject` copies byte-identical, `SKILL.md` under the 1615-line ceiling) carry one "Clean context" section: context comes only from the orchestrator's context stages; the agent's session memory, auto-memory index (`MEMORY.md`) and earlier conversation are not inputs; `prior_findings`, review-notes and reviewer `memory_search` are named as the only accepted exceptions. [verify: exec `bun test src/review/clean-context.test.ts`]
- AC2: Every reviewer skill under `review/` (`review-*/SKILL.md`, bundled) states that its inputs are the reviewer payload only; the test fails when one lacks the sentence. [verify: exec `bun test src/review/clean-context.test.ts`]
- AC3: `keryx review start` writes a `cleanContext` block into the package manifest (start time and the memory query of the context stage), and the managed-review-package schema accepts it. [verify: exec `bun test src/review/clean-context.test.ts`]
- AC4: A read of memory by the orchestrator outside its memory stage (query differs from the recorded stage query, or precedes the stage, and is not a reviewer lookup) is reported as `memory-outside-stage`, the tenth readiness item: it blocks `review complete` and `review publish`, repair text names the command, and only `--waive memory-outside-stage "<quote>"` from a terminal lifts it. Tests: a log with an extra orchestrator `keryx memory search` (blocked), a stage-only log (ready), a reviewer lookup (ready). The first task confirms that the usage log tells orchestrator calls from reviewer calls and records the caller if it does not. [verify: exec `bun test src/review/memory-outside-stage.test.ts`]
- AC5: The skill has one general open-question rule: look in the orchestrator's instructions first; if the answer is not there, ask the user (one `AskUserQuestion` interactively, `STATUS: BLOCKED question` unattended); never answer from memory or a guess. A scripted case with an unanswerable question yields the BLOCKED status. [verify: exec `bun test src/review/clean-context.test.ts`]
- AC6: The new item appears in `keryx review readiness`, `review status`, the TUI depth tab and sidebar, and `/review readiness`, like the nine others (ten items in total). [verify: exec `bun test src/review/readiness.test.ts src/tui/review-readiness.test.ts`]
- AC7: `docs/docs/guides/review-with-a-record.md`, `docs/docs/cli-reference.md` (where the item list is named) and `CHANGELOG.md` describe clean context, the tenth item and the three accepted paths; the docs coverage test stays green. [verify: exec `bun test src/cli-reference-coverage.test.ts`]
- AC8: The named limit is written in the guide and in the skill: a runtime that loads the agent's memory before the skill starts cannot be prevented by keryx; the guarantee is instruction plus detection, not isolation; reads of personal memory outside `keryx memory` are not visible to the log. [verify: judged]
- AC9: The defaults of 40 blast-radius files and depth 2 and the nine existing readiness items are unchanged: the existing readiness and chunk tests pass without edits to their expectations. [verify: exec `bun test src/review/chunks.test.ts`]
