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

- AC1: `keryx review complete` on a package whose ref is a pull request URL, ingested under `--target report`, with a recorded head different from the PR head, is refused unless the report names the reviewed SHA and says the PR moved; `complete --head` still replaces the head with a warning. [verify: exec `bun test src/review/complete-head-gate.test.ts`]
- AC2: The autonomous prompt names `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and the `keryx ctx diff` / `# keryx:raw <why>` ways past the shell guard. [verify: exec `bun test src/review/autonomous-profile.test.ts`]
- AC3: A run that ended on a loop-guard refusal after a floor refusal has a summary reason that starts with the loop guard; status and exit code stay `floor`. [verify: exec `bun test src/review/autonomous-run.test.ts src/review/autonomous-progress.test.ts`]
- AC4: The CLI reference, the review guide, the autonomous-review guide and the README describe the PR-bound rule and the prompt/summary changes. [verify: judged]
