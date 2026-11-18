# Keryx Desktop Client — Implementation Plan
Version: 0.3.0

## Milestones

| Milestone | Content | Status |
|---|---|---|
| M1 | `shell` profile (roster, modes, plan/usage/info updates, `_keryx/ask_user`, `_keryx/info`); Tauri client (chat, tools, approvals, modes, sessions, models, plan, usage, settings); sidecar; local `.dmg`; release workflow; Flows board ([flows-board.md](flows-board.md)); browser dev mode | implemented on the branch; owner acceptance pending (see README status) |
| M2a | every shell slash command via `_keryx/command` (text answers and generic views for picker/modal commands; `/queue` client-side, `/delegate`), command palette, `/connect` Providers dialog over `_keryx/providers/*` (api key, device code, custom), `spawn_subagent` + `_keryx/subagent` + Subagents tab, `_keryx/tasks/*` + Tasks tab (specification §3.9, §4.2.1, AC13–AC19) | implemented on `feat/desktop-client-m2` 2026-11-17 (as-built deviations: specification §3.9.5a); owner acceptance pending |
| M2b | images (after flow 493), model-chosen external subagent runtimes, per-subagent cancel, sidebar cards via `_keryx/state` | future |
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

## M2a tasks (order confirmed: commands → tasks → subagents)

| Task | Lane | Files |
|---|---|---|
| T10 served command table from `AGENT_SLASH_COMMANDS`; move OpenTUI-free text runners out of `src/tui/` where needed; `_keryx/command` with busy rules; `available_commands_update` `_meta.keryx` | keryx | `src/acp/commands.ts`, new `src/acp/shell-commands.ts`, `src/acp/server.ts`, `src/acp/profile.ts` |
| T10b view commands: add the missing shared text subcommands for each TUI modal action (§3.9.1 list), `_meta.keryx.view` builders | keryx | `src/commands/*`, `src/tui/*-command.ts` (neutral modules), `src/acp/shell-commands.ts` |
| T11 `_keryx/providers/*` and `_keryx/search_providers/*` over the existing auth/provider functions; login challenge notification; key redaction | keryx | new `src/acp/providers.ts`, `src/lib/oauth/*` (reuse), `src/acp/server.ts` |
| T12 palette, command card, generic view renderer (rows, actions with confirm, form), client queue + `/queue`, Providers dialog | client | `apps/desktop/src/session/Composer.tsx`, new `session/CommandCard.tsx`, new `session/ProvidersDialog.tsx`, `acp/types.ts`, `session/useAcpSession.ts` |
| T13 job registry `onEvent` → `_keryx/tasks/event`; `_keryx/tasks/list/output/kill` | keryx | `src/acp/server.ts`, new `src/acp/shell-tasks.ts` |
| T14 Activity panel, Tasks tab | client | new `session/ActivityPanel.tsx`, `session/reducer.ts`, `session/SessionView.tsx` |
| T15 shared spawn-deps factory from `makeAgentDeps`; `toolCallId` in `InteractiveToolContext`; `spawn_subagent` in the roster; `_keryx/subagent` | keryx | `src/commands/shell.ts` (extract), `src/harness/tool/builtin/{interactive-tools,spawn-subagent-tool}.ts`, `src/acp/shell-roster.ts`, `src/acp/server.ts` |
| T16 Subagents tab, link from the tool card | client | `session/ActivityPanel.tsx`, `session/Transcript.tsx`, `session/reducer.ts` |
| T17 dmg build and click-through in the installed app; report what was not checked by hand | all | — |

## Side panels (D-13), branch `feat/desktop-side-panels`, stacked on M2a

| Task | Lane | Files |
|---|---|---|
| T20 PTY manager: spawn in the project root with the login env, ring buffer, resize, write, kill the process group on tab/window close and quit | client | new `src-tauri/src/pty.rs`, `lib.rs` |
| T21 right panel, Terminal tab (xterm.js + fit), tabs, title-bar toggles, shortcuts | client | new `src/panels/*`, `shell/AppShell.tsx`, `session/SessionView.tsx`, `lib/prefs.ts` |
| T22 Run button on shell code blocks and `execute` tool calls | client | `components/Markdown.tsx`, `session/Transcript.tsx`, `src/panels/panelBus.ts` |
| T23 browser child webviews: tabs, URL bar, back/forward/reload, per-project store, navigation policy, bounds follow the panel | client | new `src-tauri/src/browser.rs`, `src/panels/BrowserPanel.tsx`, `Cargo.toml` (`unstable`) |
| T24 panel MCP: socket server + `--panel-mcp` relay, terminal and browser tools, `mcpServers` entry in `session/new`/`session/load` | client | new `src-tauri/src/panel_mcp.rs`, `main.rs`, `src/session/useAcpSession.ts` |
| T25 tests (cargo, happy-dom), dmg, click-through in the installed app | all | — |
