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

- AC1: The root cause of the non-returning parent `spawn_subagent` call (why the result was not delivered and why the existing `invokeWithBackstop` / `timeout_ms` did not fire) is identified and recorded in context.md "Agent Findings" with file/line evidence. [verify: judged]
- AC2: A regression test reproduces a parallel batch of 9 `spawn_subagent` calls where one child's result is never delivered (or its fold/cleanup hangs), and asserts the parent turn gets a result for every call, with the stuck call resolved as a Timeout error within the bounded time. [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-parallel-hang.test.ts`]
- AC3: With the fix in, AC2's test passes and it fails when the fix is reverted (the test is not vacuous). [verify: judged]
- AC4: The existing backstop and spawn tool tests still pass. [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-backstop.test.ts src/harness/tool/builtin/spawn-subagent-tool.test.ts`]
- AC5: Results the children saved via `save_result_to` are not lost when a call is abandoned by the backstop (the file stays intact and the Timeout output names the saved path). [verify: exec `bun test src/harness/tool/builtin/spawn-subagent-parallel-hang.test.ts`]
- AC6: Typecheck passes. [verify: exec `bun run typecheck`]
