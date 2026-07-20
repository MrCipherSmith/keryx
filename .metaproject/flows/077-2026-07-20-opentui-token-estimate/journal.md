# Flow Journal

- 2026-07-20T13:46:48.465Z - flow created
- 2026-07-20T13:46:48.594Z - task-added: T5: token estimate fallback
- 2026-07-20T13:46:48.684Z - task-added: T6: verify
- 2026-07-20T13:46:48.770Z - frozen: 4 criteria; checksum recorded
- 2026-07-20T13:46:48.855Z - started

## Phase 2/3 — implement + verify
- tui-shell.ts: io.onUsage ignores 0/0 reports and sets hasExactUsage on real numbers; the turn finally, when !hasExactUsage, shows estimateContextTokens(history) (~N, ~N tokens (est)) in header + sidebar. pure estimateContextTokens (chars/4) exported + unit-tested.
- Verify: tsc CLEAN; bun test 1511/0 (+1). Counter no longer stuck at 0 for local models.
- AC1-AC4 satisfied.
- 2026-07-20T13:46:48.951Z - task-done: T1: Collect remaining context
- 2026-07-20T13:46:49.050Z - task-done: T2: Implement per plan
- 2026-07-20T13:46:49.144Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-20T13:46:49.231Z - task-done: T5: token estimate fallback
- 2026-07-20T13:46:49.318Z - task-done: T6: verify
