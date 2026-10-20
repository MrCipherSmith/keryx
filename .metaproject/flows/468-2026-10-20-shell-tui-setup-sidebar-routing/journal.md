# Flow Journal

- 2026-10-20T07:58:41.266Z - flow created
- 2026-10-20T08:12:40.566Z - task-done: T1: Collect remaining context
- 2026-10-20T08:12:41.323Z - task-done: T2: Implement per plan
- 2026-10-20T08:12:42.135Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-20T08:12:42.946Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-20T08:12:46.279Z - task-added: T5: A routing: red tests for the empty startup catalog, cache hygiene and every /routing visible state
- 2026-10-20T08:12:49.686Z - task-added: T6: A routing: startup detection, zero-provider cache rule, current-session row, visible fallback reasons, docs
- 2026-10-20T08:12:53.085Z - task-added: T7: A routing: operator manual check on the branch build in a throwaway project (pick persists globally)
- 2026-10-20T08:12:56.545Z - task-added: T8: A routing: PR 1 review rounds, merge into main, release
- 2026-10-20T08:13:00.195Z - task-added: T9: B setup: red tests for step model, detection, generated prompt, readable scrolling modal, copy and Run
- 2026-10-20T08:13:03.553Z - task-added: T10: B setup: step model with required/optional, full step lists, scenario detection, generated agent prompt, CLI output
- 2026-10-20T08:13:07.206Z - task-added: T11: B setup: modal layout, contrast, scroll, Copy/Optional/Run buttons, Run through external agent with main-agent fallback, docs
- 2026-10-20T08:13:10.666Z - task-added: T12: B setup: operator manual check in a throwaway project (Refresh tab, copy prompt, Run to completion)
- 2026-10-20T08:13:13.903Z - task-added: T13: B setup: PR 2 review rounds, merge into main, release
- 2026-10-20T08:13:17.857Z - task-added: T14: C sidebar: red tests for card projection, mode geometry, tui.json merge, header buttons, wide-mode modal width
- 2026-10-20T08:13:21.348Z - task-added: T15: C sidebar: geometry store, pinned header with three mode buttons and shortcut, persistence, width plumbing, modal sizing
- 2026-10-20T08:13:24.770Z - task-added: T16: C sidebar: seven cards with detail modals, attention badges, rail glyphs, theme repaint, docs
- 2026-10-20T08:13:28.788Z - task-added: T17: C sidebar: run the 80x24 pty smoke locally and the operator manual check of all three modes on a laptop screen
- 2026-10-20T08:13:32.157Z - task-added: T18: C sidebar: PR 3 review rounds, merge into main, release
- 2026-10-20T08:13:35.604Z - task-added: T19: Final: operator check in vantage-frontend on the released npm keryx (setup Refresh run, sidebar modes, routing pick)

## Operator decisions (2026-10-20, Claude Code question tool)

- Init fields: title "Shell TUI: runnable /setup plan, compact card sidebar with three widths, working /routing model picker"; base `main`; owner MrCipherSmith; no `--require-confirmation`. Origin human-request with the verbatim quote; outcome author human (the operator stated the effect: convenient metaproject update, convenient sidebar, routing works). Verification: manual testing.
- `/setup` Run executes through an external agent (Claude Code / Codex CLI via the `/delegate` path), falling back visibly to the session's main agent when none is configured. Native `spawn_subagent` was ruled out: its children have no `shell_exec`.
- Sidebar: seven themed cards (Session, Workspace, Work, Reviews, Ops, Policy, Remote), details in modals.
- Delivery: three PRs in sequence (A routing → B setup → C sidebar), one flow, closed with PR C.
- Manual checks: branch build in a throwaway project before each merge, then the released npm keryx in vantage-frontend before the flow closes.

## Notes

- Investigation used three read-only Sonnet subagents (setup, sidebar, routing); the routing root cause was re-verified in code (`shell.ts:3356-3381`, `provider-catalog.ts:244-258`, `tui-shell.ts:4179`) and on disk (`~/.local/share/keryx/provider-catalog.json`, 65 bytes, `providers: {}`, written at the screenshot session's start).
- A `keryx gdgraph build` on this checkout indexed the untracked `.worktrees/` (41,927 of 45,182 files) because `IGNORE_DIRS` in `src/gdgraph/build.ts` lacks it. The three tracked gdgraph artifacts were restored to HEAD; the local graph DB stays polluted. A separate session was proposed for the gdgraph fix (out of this flow's scope).
- 2026-10-20T08:16:54.973Z - frozen: 19 criteria; checksum recorded
- 2026-10-20T08:16:59.602Z - started
