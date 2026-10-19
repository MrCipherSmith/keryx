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

- AC1: Orientation performs at most one working-tree status scan per invocation and graph staleness does not request an unused branch name; no cross-invocation freshness cache is introduced. [verify: exec `bun test src/ctx/orient.test.ts src/gdgraph/staleness.test.ts`]
- AC2: Git failure remains unknown, and edits, commits, renames, untracked paths and recovery remain observable on subsequent calls · sensitive: failure-scenario [verify: exec `bun test src/ctx/orient.test.ts src/gdgraph/staleness.test.ts`]
- AC3: Startup stage timing and event-loop diagnostics are opt-in and covered by tests. [verify: exec `bun test src/lib/shell-startup-trace.test.ts src/commands/agent-hooks.test.ts`]
- AC4: Focused tests, typecheck, lint and independent review are recorded, with same-checkout before/after startup measurements and any remaining animation stall explicitly reported. [verify: judged]
- AC5: Publish a draft PR against main on small-fixes-1; leave this flow in-progress for additional fixes and do not merge. [verify: judged]
