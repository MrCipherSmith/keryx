# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

These four are created by `keryx flow init` as a default checklist. Add your
own with `keryx flow task add`; a scaffold row your plan supersedes is closed
with `--disposition skipped --reason "<why>"`, not left open.

| ID | Kind | Title | Depends | Notes |
|----|------|-------|---------|-------|
| T1 | context | Collect remaining context | — | Done by the orchestrator: context.md "Agent Findings". |
| T2 | implement | Implement per plan | — | Superseded by T5, T6, T7 (skipped). |
| T3 | test | Add/adjust tests and make them pass | — | Superseded: each implement task writes its tests first (tdd-workflow) (skipped). |
| T4 | review | Self-review and prepare draft PR | T5–T9 | Phase 3 `review-orchestrator` round(s); the PR only on the owner's completion choice. |
| T5 | implement | Host: `pty_open_command` and `pty_tail` with Rust tests and TS wrappers | — | AC2. Files: `apps/desktop/src-tauri/src/{pty,panels,lib or main}.rs`, `apps/desktop/src/platform/panels.ts`. |
| T6 | implement | keryx: `terminalResults` prompt meta, untrusted notes, floor, replay, `initialize` meta, system-instruction guidance | — | AC5, AC6, AC7 (server half), AC10. Files: new `src/acp/terminal-result.ts` + tests `src/acp/terminal-result*.test.ts`, `src/acp/server.ts`, `src/acp/profile.ts`, `src/commands/agent.ts`. |
| T7 | implement | Desktop: run tracking, delivery on idle, run card and replay | T5, T6 | AC1, AC3, AC4, AC7 (client half), AC8, AC9. Files: `apps/desktop/src/panels/{panelBus,TerminalPanel}.ts(x)`, `components/Markdown.tsx`, `session/{Transcript,reducer,useAcpSession}.ts(x)`, new `session/terminalRuns.ts` + tests `session/terminalRun*.test.ts(x)`, `panels/RunButton.dom.test.tsx`. |
| T8 | docs | Spec: run tab, wire meta, waiting rule in the desktop specification | T7 | AC12. `docs/requirements/keryx-desktop-client/specification.md` §4.4 and next to §3.9.5a. |
| T9 | verify | Live check in the installed desktop app (owner) | T7 | AC13, judged; installing a build needs the owner's OK to quit the running Keryx. |

T5 and T6 touch disjoint files and can run in parallel.
