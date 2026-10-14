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

- AC1: `createHeartbeat` given a keep-alive period writes the latest running state to stderr every period while nothing changes, writes `phase starting, 0 round(s), 0 tokens` before the runner has reported, and writes nothing after `stop()`; without a period it never writes on a timer. [verify: exec `bun test src/commands/review-run.test.ts`]
- AC2: `keryx review run --autonomous` stops the keep-alive when the run ends, and a child that goes quiet is still terminated by the stall rail (exit 5) with no further heartbeat line after the command returns. [verify: exec `bun test src/commands/review-run.test.ts`]
- AC3: `keryx review complete <package> --head <sha>` is accepted, is not read as a disposition flag, and needs a value; a value that is not 7-40 hex characters, or a package that is not bound to a pull request, is refused. [verify: exec `bun test src/commands/review.test.ts src/review/complete-head-gate.test.ts`]
- AC4: With `--head`, the head gate checks that commit and the closed manifest records it; a replaced recorded head produces a warning naming both. [verify: exec `bun test src/review/complete-head-gate.test.ts`]
- AC5: The gate is not loosened: `--head` with a commit that is not the pull request's head fails with the first-line message and leaves the manifest unclosed, unless the report's first line names that SHA and says the PR moved; without `--head` the recorded head decides as before. [verify: exec `bun test src/review/complete-head-gate.test.ts src/commands/review.test.ts`]
- AC6: `buildAutonomousPrompt` given a head tells the child to pass `--head <sha>` to `keryx review complete` as well as `start`, `attach` and `ingest`. [verify: exec `bun test src/review/autonomous-profile.test.ts`]
- AC7: The CLI reference, the autonomous review guide, the `review run` and `review` help texts and the changelog describe the keep-alive and `review complete --head`, and no longer say the heartbeat is not a timer. [verify: judged]
