# Flow Journal

- 2026-11-20T14:55:58.641Z - flow created
- 2026-11-20T14:56:41.249Z - origin-set: unknown -> human-request; quote: "В одном фло"; source: Codex conversation, 2026-11-20 (Desktop settings and Review account requirements)
- 2026-11-20T14:56:41.529Z - task-added: T5: Group Settings, restore previous view and split light and dark palettes
- 2026-11-20T14:56:41.815Z - task-added: T6: Bind GitHub account to project and route board, fetch and watcher through it
- 2026-11-20T14:56:42.102Z - task-added: T7: Connect GitHub accounts in Integrations, Project Settings and Activity
- 2026-11-20T14:56:42.378Z - task-added: T8: Verify desktop layout, account isolation, Git fetch and detached watcher
- 2026-11-20T14:56:42.651Z - frozen: 7 criteria; checksum recorded
- 2026-11-20T14:56:42.916Z - started
- 2026-11-20T14:56:43.197Z - task-done: T1: Collect remaining context
- 2026-11-20T14:56:55.989Z - task-done: T2: Implement per plan
- 2026-11-20T14:56:56.257Z - task-depends-set: T3: dependsOn T8 (was empty) — Test and capture acceptance after all changes
- 2026-11-20T14:56:56.520Z - task-depends-set: T4: dependsOn T3 (was empty) — Review after verification
- 2026-11-20T14:56:56.783Z - task-attempt: T5: started (attempt 1) — Settings navigation and appearance implementation
- 2026-11-20T14:56:57.050Z - task-attempt: T6: started (attempt 1) — Project identity and Review integration
- 2026-11-20T15:03:13.736Z - task-attempt: T7: started (attempt 1) — Native bridge and project account UI integration
- 2026-11-20T15:09:34.504Z - task-done: T5: Group Settings, restore previous view and split light and dark palettes

## Desktop verification

- Settings and appearance implementation reached commit 931b47188. The Desktop build and all 508 Desktop tests passed.
- Production-preview Chrome at 660px showed no horizontal overflow for Light and Dark settings. All six tested foreground/background combinations for each new light palette met a 4.5:1 ratio.
- The native bridge passed 217 Rust tests and Clippy. The bridge assembles a fixed device sign-in command and does not pass credentials back to the webview.
- Two existing GitHub identities were bound to temporary projects for a private repository and Keryx. Both returned the configured viewer through the Review board and authenticated an HTTPS Git ref read. Both opt-in launchd timers recorded a successful poll without a Desktop window, using the same local GitHub account store and without switching its active account. The temporary projects and timers were removed. Browser sign-in to add a new account was not exercised live.
- 2026-11-20T15:10:56.005Z - task-done: T6: Bind GitHub account to project and route board, fetch and watcher through it
- 2026-11-20T15:12:03.189Z - task-done: T7: Connect GitHub accounts in Integrations, Project Settings and Activity
- 2026-11-20T15:12:03.524Z - task-attempt: T8: started (attempt 1) — Desktop visual and native tests plus two real GitHub account launchd polling

- Review CLI, project binding, credential isolation and scheduled account controls reached commit f640a2a23. The focused Review suite passed 108 checks. A test account change leaves failed access decisions and previous configuration consistent, and a disconnected watcher is fenced from queued work.
- The Desktop integration reached commit 43810f59f. A DOM fixture exercised first-open account choice, returning from Settings to Review with the board still loaded, changing the account through the project menu and preserving an unsent draft.
- A second read-only GitHub run fetched actual Git objects over HTTPS in temporary repositories under both chosen identities. The active system account did not change during live testing. Automated fixtures also changed the ambient account credential without affecting bound project identities.
- For a first manual test of adding a new account through the Desktop browser button, run Desktop with the matching CLI from this branch. Neither released binary was changed.
- 2026-11-20T15:13:14.348Z - origin-set: human-request; quote: "В одном фло"; source: Codex conversation, 2026-11-20 -> human-request; quote: "3 Таба integrations и там можно подключать аккаунты, причем несколько гитхаба, пока ограничимся гитхабом."; source: Codex conversation, 2026-11-20 (Record the original Desktop and GitHub integration request)
- 2026-11-20T15:13:14.642Z - task-done: T8: Verify desktop layout, account isolation, Git fetch and detached watcher

- Expanded the Desktop navigation fixture to cover entry into Integrations from onboarding, a mocked browser sign-in, refreshing the account list and continuing account selection. The fixture passed on commit 6e700d548.
- Independent Code Health over the branch passed. The strict changed test command initially hit the system Git template's author hook in temporary fixture repositories. An isolated-config rerun passed 1,837 tests and timed out one unchanged TUI test at Bun's five-second boundary. The entire TUI file passed 10/10 on two isolated retries. The original full command and the rerun did not have a zero exit code.
- The live watcher check used two real account identities, distinct from the active identity in at least one project, while leaving the active account untouched. The fixture also exercised a changed ambient token.
- 2026-11-20T15:23:59.096Z - task-done: T3: Add/adjust tests and make them pass

- The final run reused all 108 paths selected by the strict Keryx gate, with neutral per-process Git settings and Bun's per-test timeout raised to 15 seconds for this run. Bun's root configuration executed 1,838 tests across 93 files, all passed. Desktop's own suite ran separately and passed 508 tests.
- Implementation and test evidence are complete. The operator was asked to select standard review and draft PR, a live browser sign-in check, or an open flow for manual acceptance.

- Operator selected standard review and a draft PR. The primary checkout holds the live Flow record. A versioned snapshot travels with the implementation branch.
