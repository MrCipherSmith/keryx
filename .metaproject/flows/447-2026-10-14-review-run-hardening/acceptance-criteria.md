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

- AC1: When a model-supplied `idle_timeout_ms` is clamped, the `shell_exec` result states the requested and the effective value, on the background, promoted and foreground-exit paths; an in-range value adds nothing. [verify: exec `bun test src/harness/tool/builtin/shell-exec-background.test.ts`]
- AC2: The `shell_exec` tool description states the maximum (1800000, 30 minutes) and that a command silent for longer must print progress or be started detached. [verify: exec `bun test src/harness/tool/builtin/shell-exec-background.test.ts`]
- AC3: `keryx review run --autonomous` writes `heartbeat: phase <phase>, <n> round(s), <n> tokens` to stderr when the phase, rounds or tokens change, at most once a minute, and only while the run is running. [verify: exec `bun test src/commands/review-run.test.ts`]
- AC4: With `--json` the heartbeat still goes to stderr and stdout stays the summary JSON alone. [verify: exec `bun test src/commands/review-run.test.ts`]
- AC5: `buildAutonomousPrompt` given a non-null head names it, says to review exactly that commit, and tells the child to pass `--head <sha>` to `keryx review start`, `attach` and `ingest`. [verify: exec `bun test src/review/autonomous-profile.test.ts`]
- AC6: With a null or absent head the prompt is byte-identical to the one built without a head. [verify: exec `bun test src/review/autonomous-profile.test.ts`]
- AC7: The autonomous run passes the head it resolved to `buildAutonomousPrompt`, so the child's prompt carries it. [verify: exec `bun test src/review/autonomous-run.test.ts`]
- AC8: The CLI reference, the autonomous review guide and the changelog describe the heartbeat, the head in the prompt and the visible clamp. [verify: judged]
