# Keryx Desktop Client — Implementation Plan
Version: 0.2.0

## Milestones

| Milestone | Content | Status |
|---|---|---|
| M1 | `shell` profile (roster, modes, plan/usage/info updates, `_keryx/ask_user`, `_keryx/info`); Tauri client (chat, tools, approvals, modes, sessions, models, plan, usage, settings); sidecar; local `.dmg`; release workflow; Flows board ([flows-board.md](flows-board.md)); browser dev mode | implemented on the branch; owner acceptance pending (see README status) |
| M2 | images (after flow 493), subagent inspector events (`spawn_subagent` itself is in the shell roster since M1), background task list/output/kill, rewind, compact, queue, sidebar cards, full slash-command set via `_keryx/command` | future |
| M3 | remote-control and Hub toggles, Developer ID signing on, Homebrew cask, auto-update | future |

## Parity matrix

| Shell capability | Milestone | Mechanism |
|---|---|---|
| Streaming answer, reasoning, tool calls | M1 | existing ACP updates |
| Approvals (once / always) | M1 | `session/request_permission` |
| ask / trust / auto | M1 | `session/set_mode` |
| `ask_user` picker | M1 | `_keryx/ask_user` |
| Execution plan panel | M1 | `plan` update |
| Token usage | M1 | `usage_update` |
| Sessions list / resume / new | M1 | `session/list`, `session/load`, `session/new` |
| Model and reasoning | M1 | config option `model`, `/reasoning` |
| Web tools, shell tasks, workspace, Slate, MCP | M1 | shell roster |
| Images | M2 | `promptCapabilities.image` |
| Subagent dispatch (`spawn_subagent`) | M1 | shell roster |
| Subagent inspector | M2 | `_keryx/subagent` notifications |
| Background tasks panel | M2 | `_keryx/tasks/*` |
| Rewind, compact, queue | M2 | `_keryx/command` |
| Sidebar cards, flows | M2 | `_keryx/state` (state snapshot) |
| Every slash command | M2 | `_keryx/command` + `available_commands_update` |
| Remote-control, Hub share | M3 | `_keryx/command` |

## M1 tasks

| Task | Lane | Files |
|---|---|---|
| T1 `--profile` flag, `_keryx/info`, real version | keryx | `src/commands/acp.ts`, `src/acp/server.ts`, `src/acp/protocol.ts` |
| T2 shell-profile roster with session-scoped registries | keryx | `src/acp/roster.ts`, `src/acp/server.ts` |
| T3 modes and mode-aware gate | keryx | `src/acp/permission.ts`, `src/acp/server.ts` |
| T4 plan / usage / session info updates | keryx | `src/acp/agent-io.ts`, `src/acp/server.ts` |
| T5 `_keryx/ask_user` | keryx | `src/acp/client-requests.ts`, `src/acp/server.ts` |
| T6 Rust core | client | `apps/desktop/src-tauri/` |
| T7 web view | client | `apps/desktop/src/` |
| T8 sidecar build, `desktop:build`, release workflow | packaging | `scripts/desktop/`, `package.json`, `.github/workflows/desktop-release.yml` |
| T9 end-to-end check against the built app | all | — |
