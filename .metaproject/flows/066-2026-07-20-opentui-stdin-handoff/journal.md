# Flow Journal

- 2026-07-20T10:50:33.336Z - flow created
- 2026-07-20T10:52:43.203Z - task-added: T5: onBeforeInit stdin handoff
- 2026-07-20T10:52:43.278Z - task-added: T6: verify
- 2026-07-20T10:52:43.359Z - frozen: 4 criteria; checksum recorded
- 2026-07-20T10:52:43.455Z - started

## Phase 2/3 — implement + verify (orchestrator)
- tui-shell.ts: launchTuiAgentShell now takes onBeforeInit (was onStart) and calls it AFTER the no-TTY/absent-dep guards but BEFORE createCliRenderer, so the caller detaches readline before OpenTUI sends capability/DA/DSR queries → responses reach OpenTUI's parser instead of leaking.
- shell.ts: passes onBeforeInit: () => rl.close().
- Verify: tsc CLEAN; bun test 1506 pass/0 fail; default --agent (no --tui) → readline (smoke). Real-terminal no-leak effect = user (via --tui). Default stays readline (flow 065); TUI opt-in.
- AC1-AC4 satisfied.
- 2026-07-20T10:52:43.536Z - task-done: T1: Collect remaining context
- 2026-07-20T10:52:43.618Z - task-done: T2: Implement per plan
- 2026-07-20T10:52:43.692Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-20T10:52:43.773Z - task-done: T5: onBeforeInit stdin handoff
- 2026-07-20T10:52:43.845Z - task-done: T6: verify
