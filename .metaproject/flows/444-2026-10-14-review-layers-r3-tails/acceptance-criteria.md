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

- AC1: A SIGTERM or SIGINT delivered to `refreshLayers` in each phase after the lock is taken (recover, build, wiki, memory, `layers.json` write) leaves no `refresh.lock`, no detached worktree and no staging directory, and the process still exits by the signal. [verify: exec `bun test src/review/layers-signal.test.ts`]
- AC2: When the wiki reader, the memory reader or `computeAffected` throws, `keryx review layers block --json` reports that source as `unavailable` with a reason, and the text block prints `<source>: unavailable (<reason>)`; a source with no relevant items still prints as empty, not as unavailable. [verify: exec `bun test src/review/layers-payload.test.ts`]
- AC3: After a persistent graph-build failure, a second `ensurePackageLayers` at the same head inside the retry window creates no worktree and runs no build; `--force` or a new head runs the build again. [verify: exec `bun test src/commands/review-layers.test.ts`]
- AC4: The timeout test in `src/tui/review-layers-child.test.ts` fails when the timeout kill is removed and when the child prints no JSON, and asserts the child process is gone. [verify: exec `bun test src/tui/review-layers-child.test.ts`]
- AC5: The `/reviews` double-start guard has a test with two views over one dir (second start refused while the first is pending) and one with two dirs (both start), and the pending promise is settled in a `finally`. [verify: exec `bun test src/tui/reviews-inspector.test.ts`]
- AC6: Tests named after round ids (`layers-round2.test.ts` and the `R2-nn` prefixes in it) are renamed after the behaviour they pin; no test count is lost. [verify: invariant `bun test src/review 2>&1 | tail -4`]
- AC7: A mutation run with the focused command widened to the TUI and command-risk test files kills the mutants for AC1 to AC5 (a mutant per fix: signal handler removed, `unavailable` dropped, retry window removed, timeout kill removed, guard made per-view). [verify: judged]
- AC8: `bun run check` passes and the CHANGELOG `[Unreleased]` section names the fixes. [verify: exec `bun run check`]
