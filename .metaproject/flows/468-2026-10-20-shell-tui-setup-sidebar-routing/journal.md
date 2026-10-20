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
- 2026-10-20T08:17:24.983Z - task-attempt: T5: started (attempt 1) — 468-T5 tests-creator dispatch (sonnet)
- 2026-10-20T08:27:09.507Z - task-done: T5: A routing: red tests for the empty startup catalog, cache hygiene and every /routing visible state
- 2026-10-20T08:27:13.753Z - task-attempt: T6: started (attempt 1) — 468-T6 task-implementer dispatch (sonnet)

### T6 result (DONE_WITH_CONCERNS), accepted after orchestrator re-check

- Re-check: result contract valid; 9 test files (4 T5 files + classifier source, commands/routing, spawn-subagent-tool, cli-reference coverage, catalog cache) 225 pass / 0 fail; `tsc --noEmit` clean.
- behavior_changes answered by the operator (question tool, 2026-10-20):
  - Problem display on `/routing`: keep the implemented status rows above the picker and the reason inside the category line ("provider list unavailable" / "provider not connected" / "model not in <p>'s list, falling back to …"). Alternatives declined: one footer line; a detail line under the cursor only.
  - Auth-failed providers: keep them listed, marked "auth failed — /connect", not selectable. Alternative declined: hide them as before.
  - Redetect fallback when the cache is empty or stale (`/routing` and the turn classifier's loader): not operator-visible, accepted.
- Noticed, not touched (decided: no fix task in this flow): `routing-classifier-source.ts:143,178` and `review.ts:1545` do not take the session pair. With the root cause fixed, their provider list is no longer empty after a saved-provider start, so the case they leave is a genuinely empty or stale list, which flow 411's tests pin as "no routing". `keryx routing list` keeps the generic fallback wording; only `/routing` shows the reasons. Both are candidates for a later flow, not scope growth here.
- 2026-10-20T08:37:49.287Z - task-done: T6: A routing: startup detection, zero-provider cache rule, current-session row, visible fallback reasons, docs
- 2026-10-20T08:47:13.037Z - ac-updated: AC5: "(operator-only) On the branch build in a throwaway project, the operator opens `/routing`, sees openai-codex and the other connected providers with their models, picks a model for `coding`, and sees the category show it after reopening. The agent does not confirm this criterion. [verify: judged]" -> "(operator-only) After PR 1 is released and keryx is installed from npm (`keryx --version` shows that release), the operator opens `/routing` in a real project, sees openai-codex and the other connected providers with their models, picks a model for `coding`, and sees the category show it after reopening. The agent does not confirm this criterion. [verify: judged]" (operator 2026-10-20: manual checks happen only after release and npm install, not on a branch build)
- 2026-10-20T08:47:17.293Z - ac-updated: AC11: "(operator-only) On the branch build in a throwaway project that already has a `.metaproject/`, the operator opens `/setup`, lands on Refresh, reads the plan without squinting, copies the prompt, presses Run, and the external agent completes the required steps. The agent does not confirm this criterion. [verify: judged]" -> "(operator-only) After PR 2 is released and keryx is installed from npm, in a project that already has a `.metaproject/`, the operator opens `/setup`, lands on Refresh, reads the plan without squinting, copies the prompt, presses Run, and the external agent completes the required steps. The agent does not confirm this criterion. [verify: judged]" (operator 2026-10-20: manual checks happen only after release and npm install, not on a branch build)
- 2026-10-20T08:47:21.387Z - ac-updated: AC18: "(operator-only) On a laptop screen with the branch build, the operator sees the default mode without scrolling in a typical session, switches to wide and rail with the header buttons, opens a few cards' modals, and finds them good-looking and complete. The agent does not confirm this criterion. [verify: judged]" -> "(operator-only) After PR 3 is released and keryx is installed from npm, on a laptop screen, the operator sees the default mode without scrolling in a typical session, switches to wide and rail with the header buttons, opens a few cards' modals, and finds them good-looking and complete. The agent does not confirm this criterion. [verify: judged]" (operator 2026-10-20: manual checks happen only after release and npm install, not on a branch build)
- 2026-10-20T08:47:25.090Z - task-added: T20: A routing: operator check after the PR 1 release, keryx installed from npm
- 2026-10-20T08:47:25.837Z - task-added: T21: B setup: operator check after the PR 2 release, keryx installed from npm
- 2026-10-20T08:47:26.843Z - task-added: T22: C sidebar: run the 80x24 pty smoke locally before merge
- 2026-10-20T08:47:27.604Z - task-added: T23: C sidebar: operator check after the PR 3 release on a laptop screen, keryx installed from npm
- 2026-10-20T08:47:31.094Z - task-depends-set: T8: dependsOn T6 (was T7) — operator 2026-10-20: no manual check on the branch build; PR 1 review follows the implementation directly
- 2026-10-20T08:47:31.970Z - task-depends-set: T13: dependsOn T11 (was T12) — operator 2026-10-20: no manual check on the branch build; PR 2 review follows the implementation directly
- 2026-10-20T08:47:32.840Z - task-depends-set: T18: dependsOn T22 (was T17) — the 80x24 pty smoke (T22) stays a pre-merge gate; the operator's manual check moved after the release (T23)
- 2026-10-20T08:47:33.590Z - task-depends-set: T19: dependsOn T23 (was T18) — the final vantage-frontend check follows the post-release sidebar check
- 2026-10-20T08:47:37.064Z - task-done: T7: A routing: operator manual check on the branch build in a throwaway project (pick persists globally)
- 2026-10-20T08:47:37.863Z - task-done: T12: B setup: operator manual check in a throwaway project (Refresh tab, copy prompt, Run to completion)
- 2026-10-20T08:47:38.762Z - task-done: T17: C sidebar: run the 80x24 pty smoke locally and the operator manual check of all three modes on a laptop screen

### Operator decision: manual checks only after release (2026-10-20)

- Operator, verbatim: «Я проверь только после выпуска релиза и установки.» — supersedes the earlier "branch build first, then release" answer.
- Effect: AC5, AC11 and AC18 rewritten through `flow ac update` to name the post-release npm install; the branch-build verify tasks T7 and T12 are skipped, T17 is split into T22 (pre-merge 80×24 pty smoke, still an agent gate) and T23 (operator check after the PR 3 release); new post-release verify tasks T20 (A) and T21 (B). PR reviews now follow the implementation directly (T8 ← T6, T13 ← T11, T18 ← T22).
- Consequence stated to the operator: a defect found in a post-release check costs a fix PR and another release.
