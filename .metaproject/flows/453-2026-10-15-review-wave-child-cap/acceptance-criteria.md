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

- AC1: `spawn_subagent` accepts an optional `review_wave` (package path and pass id). With a valid wave the child counts against that wave's own counter of 32 and not against the turn counter: 32 children in wave A, then 32 more in wave B, are admitted; the 33rd in one wave is refused. [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
- AC2: A `review_wave` that does not name a pass of the package's recorded chunk plan, or whose package lies outside the project, is ignored: the child counts against the turn counter and the call is not refused for that reason alone (the turn cap still refuses the 33rd). [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
- AC3: Calls without `review_wave` behave as before: the existing `SUBAGENT_TURN_MAX_CHILDREN` tests pass without edits to their expectations. [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
- AC4: The refusal text names the cap, whether the wave or the turn counter refused, and the next step (finish the wave with `review chunks record`; for the turn, continue in a new turn). [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
- AC5: The review-orchestrator skill (bundled and `.metaproject` copies byte-identical, `SKILL.md` under the 1615-line ceiling) tells the dispatcher to pass `review_wave` for chunk-plan waves. [verify: exec `bun test src/review/review-wave-skill.test.ts`]
- AC6: The package total stays bounded: at most `DEFAULT_MAX_PASSES` (25) waves of 32 in one turn; the 26th wave is refused. [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
- AC7: CHANGELOG and the review guide describe the per-wave count and the fail-closed rule. [verify: judged]
