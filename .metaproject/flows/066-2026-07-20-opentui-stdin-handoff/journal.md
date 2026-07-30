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
- 2026-07-30T16:12:31.784Z - task-done: T4: Self-review and prepare draft PR
- 2026-07-30T16:12:42.666Z - completing: merged commit: 69d5340d343370773883319aab20689dfae6d399
- 2026-07-30T16:12:42.675Z - completion-failed: acceptance-criteria: unconfirmed: AC1, AC2, AC3, AC4
- 2026-07-30T16:13:14.338Z - ac-confirmed: AC1: Met at merge 69d5340d (PR #103): src/tui/tui-shell.ts gained the onBeforeInit hook, invoked after the no-TTY / absent-dep guards and before createCliRenderer.
- 2026-07-30T16:13:14.421Z - ac-confirmed: AC2: Met at merge 69d5340d: src/commands/shell.ts passes onBeforeInit: () => rl.close(); fallback paths return before the hook and keep readline usable.
- 2026-07-30T16:13:14.503Z - ac-confirmed: AC3: Met at merge time (TUI still opt-in via --tui). Superseded by flow 067, which made the TUI own the terminal from start and become the default.
- 2026-07-30T16:13:14.587Z - ac-confirmed: AC4: Met at merge time (PR #103 CI green). Real-terminal validation was the user-facing caveat and was carried into flow 067. Re-verified today on main: keryx health run = PASS.
- 2026-07-30T16:13:14.757Z - completing: merged commit: 69d5340d343370773883319aab20689dfae6d399
- 2026-07-30T16:13:14.767Z - done: all gates passed
