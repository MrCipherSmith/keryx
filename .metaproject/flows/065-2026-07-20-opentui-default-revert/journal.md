# Flow Journal

- 2026-07-20T10:02:45.139Z - flow created
- 2026-07-20T10:03:17.197Z - task-added: T5: revert default gate to --tui opt-in
- 2026-07-20T10:03:17.282Z - task-added: T6: verify + smokes
- 2026-07-20T10:03:17.366Z - frozen: 4 criteria; checksum recorded
- 2026-07-20T10:03:17.444Z - started
- 2026-07-20T10:03:17.522Z - task-done: T1: Collect remaining context

## Phase 2/3 — implement + verify (orchestrator)
- shell.ts: reverted the flow-064 default flip — the agent-branch gate is `tuiFlag && !noTuiFlag && isTTY` again (OpenTUI opt-in via --tui). readline is the default; --no-tui still overrides; TUI code (tui-shell.ts) unchanged. Known-issue report.md records the stdin-handoff root cause + planned fix.
- Verify: tsc CLEAN; `bun test` **1506 pass / 3 skip / 0 fail**; default `--agent` (no --tui) → readline (smoke). No new dependency.
- AC1-AC4 satisfied.
- 2026-07-20T10:04:25.773Z - task-done: T2: Implement per plan
- 2026-07-20T10:04:25.862Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-20T10:04:25.944Z - task-done: T5: revert default gate to --tui opt-in
- 2026-07-20T10:04:26.031Z - task-done: T6: verify + smokes
- 2026-07-30T16:12:31.701Z - task-done: T4: Self-review and prepare draft PR
- 2026-07-30T16:12:42.576Z - completing: merged commit: 95cab284df636d413c7c04767915f43b191c3754
- 2026-07-30T16:12:42.585Z - completion-failed: acceptance-criteria: unconfirmed: AC1, AC2, AC3, AC4
- 2026-07-30T16:13:14.009Z - ac-confirmed: AC1: Met at merge 95cab284 (PR #102): src/commands/shell.ts launch gating reverted to readline-by-default, TUI behind --tui. Superseded on 2026-07-20 by flow 067 (OpenTUI owns the terminal from start), which re-flipped the default by design.
- 2026-07-30T16:13:14.090Z - ac-confirmed: AC2: Met at merge 95cab284: --tui still reaches the OpenTUI shell; readline fallback on no-TTY / absent dep / init failure preserved; tui-shell.ts untouched in that PR (diff: shell.ts only).
- 2026-07-30T16:13:14.171Z - ac-confirmed: AC3: Met: .metaproject/flows/065-2026-07-20-opentui-default-revert/report.md records the DA/DSR handoff leak, root cause and the planned fix, which became flow 066.
- 2026-07-30T16:13:14.251Z - ac-confirmed: AC4: Met at merge time (PR #102 CI green). Re-verified today on main: keryx health run = PASS, score 93, no gate conditions.
- 2026-07-30T16:13:14.667Z - completing: merged commit: 95cab284df636d413c7c04767915f43b191c3754
- 2026-07-30T16:13:14.676Z - done: all gates passed
