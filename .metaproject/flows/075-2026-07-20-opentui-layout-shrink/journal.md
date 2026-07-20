# Flow Journal

- 2026-07-20T13:16:02.569Z - flow created
- 2026-07-20T13:16:02.722Z - task-added: T5: layout constraints
- 2026-07-20T13:16:02.826Z - task-added: T6: verify
- 2026-07-20T13:16:02.916Z - frozen: 4 criteria; checksum recorded
- 2026-07-20T13:16:03.018Z - started

## Phase 2/3 — implement + verify
- tui-shell.ts: header/menu/composer/footer flexShrink:0 (keep natural height); ScrollBox minHeight:0 (clip+scroll overflow instead of pushing chrome); main minWidth:0; sidebar flexShrink:0. Fixes the composer collapsing when the transcript scrolls, and makes the row (main+sidebar) size correctly.
- Verify: tsc CLEAN; bun test 1507/0. Layout = user (--tui, fill height + scroll).
- AC1-AC4 satisfied.
- 2026-07-20T13:16:03.111Z - task-done: T1: Collect remaining context
- 2026-07-20T13:16:03.192Z - task-done: T2: Implement per plan
- 2026-07-20T13:16:03.275Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-20T13:16:03.358Z - task-done: T5: layout constraints
- 2026-07-20T13:16:03.435Z - task-done: T6: verify
