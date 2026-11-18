# Keryx Desktop Client — Decisions
Version: 0.2.0

All decisions below were taken by the owner on 2026-11-17 in the session
that produced this package.

## D-01 Stack: Rust on Tauri v2

Chosen: Tauri v2 — Rust owns the `keryx acp` process and macOS integration,
the UI is a web view (React + Vite, the stack `apps/hub-web` already uses).

Rejected: a native Rust UI (gpui, iced, egui) — chat, markdown, diffs and
code blocks cost far more to build there, with no product gain for M1.

## D-02 Protocol: ACP with a `shell` profile

Chosen: `keryx acp --profile shell` — the same ACP v1 wire, offering the
shell's roster, the standard `session/set_mode`, `plan`, `usage_update` and
`session_info_update` updates, and a `_keryx/*` extension namespace for what
ACP does not model. Any ACP client (Zed, for one) gets the standard part.

Rejected: a separate `keryx desktop-server` protocol over the same session
host — freer in shape, but it duplicates ACP and helps no other client.

## D-03 Scope: parity in three milestones

Chosen: M1 chat/tools/approvals/modes/sessions/models/packaging; M2
subagents, tasks, rewind, compact, queue, sidebar, every slash command,
images; M3 remote-control, Hub, signing, cask, auto-update.

Rejected: finishing the whole keryx-side protocol before starting the client.

## D-04 Where keryx comes from: bundled sidecar plus PATH

Chosen: the `.app` carries a compiled keryx binary (Tauri `externalBin`
sidecar, built with `bun build --compile`). Settings can switch to a
`keryx` found on `PATH`. The client checks `agentInfo.version` and the
`_keryx/info` profile list at `initialize` and refuses an incompatible keryx
with a message naming both versions.

Rejected: PATH only (the user must install a matching keryx first); bundled
only (no way to use a development build).

## D-05 Signing: ad-hoc first, Developer ID before a public release

Chosen: M1 builds are ad-hoc signed for the owner's own machine. The
release workflow carries the Developer ID signing and notarization step,
switched on by repository secrets, before the first public release.

## D-06 Channels: GitHub Releases `.dmg`, Homebrew cask, auto-update

Chosen: all three. A universal (arm64 + x86_64) `.dmg` on GitHub Releases;
`brew install --cask keryx-desktop` from the existing
`MrCipherSmith/homebrew-keryx` tap; `tauri-plugin-updater` reading a signed
`latest.json` from GitHub Releases. Cask and updater land in M3.

Rejected: Mac App Store (its sandbox forbids the processes keryx runs).

## D-07 Location and tags: `apps/desktop`, `desktop-v*`

Chosen: the client lives in `apps/desktop` in this repository, next to
`apps/hub-web`, with its own workflow on a macOS runner triggered by
`desktop-v*` tags and its own version. `v*` stays the npm release tag.

Rejected: a separate repository; sharing the `v*` tag and version with keryx.

## D-08 Relation to `keryx-desktop-app` — confirmed by the owner on 2026-11-17

[keryx-desktop-app](../keryx-desktop-app/README.md) (2026-11-14) plans a
Tauri shell over the Hub web and a local Hub for the task → stages → diff →
accept loop. This package is the interactive-session client over ACP. They
are two views of one desktop product, not two apps.

Chosen (proposed autonomously on 2026-11-17, confirmed by the owner the same
day): `apps/desktop` is the single Tauri application. M1 ships the
session view. The Hub work views of `keryx-desktop-app` arrive later as
another window of the same app, loading `apps/hub-web` against the local Hub
that package specifies. No second Tauri project is created.

Rejected: a separate Tauri project for the Hub work loop, which would
duplicate packaging, signing, sidecar and auto-update.

## D-09 Live sessions in the desktop app — decided 2026-11-17

Owner decision from the round-3 review (finding UX-W3-R3-002). It supersedes
the earlier rule of one active session per connection, under which opening a
session released the previous one and ended its shell tasks.

Chosen: in `keryx acp --profile shell` a connection holds several sessions at
once. Opening or creating a session releases nothing; turns, shell tasks and
MCP servers of other sessions keep running. The desktop keeps every held
session's transcript and switches locally; Stop cancels only the shown
session; dialogs queue per session; the sidebar marks busy and waiting
sessions. keryx holds at most 8 sessions and, past that, releases the least
recently used idle one (no turn, no running shell task, no request in flight)
and sends `_keryx/session_released`; the app keeps that transcript read-only
with a Reopen banner.

Rejected: one active session per connection (switching killed background work
and surprised users).

## D-10 Commands: `_keryx/command`, not prompt text — decided 2026-11-17

Chosen: the desktop runs a slash command with the `_keryx/command` request.
It is not a turn: it does not take the prompt slot, stays out of the model's
history and can run during a turn under the shell's own busy rules
(`busy-dispatch.ts`). The command set is the shell's `AGENT_SLASH_COMMANDS`
(the owner chose every command, pickers included), never a second
vocabulary. A picker or modal command answers with a generic view (rows,
actions, form) whose every action is another command line, so each TUI modal
action gets a shared text subcommand instead of a desktop-only dialog. Commands
whose meaning is a client surface (`/new`, `/resume`, `/interrupt`, `/mode`,
`/model`, `/connect`) are advertised with `surface: client|dialog` and handled
by the app. `session/prompt` slash text stays for editors (§3.7).

Rejected: sending commands as `session/prompt` text (blocks while a turn runs,
mixes command output into the session as if it were a turn); a bespoke
desktop dialog per TUI modal (two implementations of each action).

## D-11 Provider login without a terminal — decided 2026-11-17

Chosen: `/connect` is an in-app dialog over `_keryx/providers/*`. API keys
are typed into a password field and sent once to keryx over the stdio pipe;
device-code logins (openai-codex, github-copilot, grok) show the code in the
app and open the verification URL in the system browser while keryx polls.
Every step reuses the functions the TUI already calls; only the orchestration
(`runProviderConnectSequence`) is re-expressed. No provider in the catalogue
needs a terminal; a browser PKCE loopback flow, if one is added later, runs in
keryx with the app opening the URL the same way.

Rejected: opening Terminal with `keryx auth login` (leaves the app, no
feedback); keeping keys in the web view's storage (keys stay in keryx's
`auth.json` only).

## D-12 Subagents over ACP — decided 2026-11-17

Chosen: `spawn_subagent` with native children (plus `/delegate` external
runs), sent as the shell's own fleet events in
`_keryx/subagent` per session, linked to the spawning tool call by a new
`toolCallId` in the tool context. Spawn deps come from one factory shared
with `keryx shell`. Children keep never asking the user. Cancel is per turn.
The desktop keeps a session's subagents until `/new` (owner, 2026-11-17),
not per turn as the TUI does; they are not persisted across a reload.

Rejected: reusing the TUI's module-global subagent bridge (it cannot tell
sessions apart); a model-chosen external runtime and per-subagent cancel in
M2a (M2b).

## D-13 Side panels: terminal and browser — decided 2026-11-18

Owner answers 2026-11-18 (question cards; the research of 2026-11-17 compared
the Claude desktop Code tab, the Codex app, Cursor, Warp and Zed). The brief
named D-11, but M2 had already used D-10..D-12.

Chosen:
- **One right-side panel per project window** with two tabs, Terminal and
  Browser. Title-bar toggles; `Ctrl+\`` opens the terminal, `Cmd+Shift+B` the
  browser. While open, the panel takes the place of the info/activity dock.
- **Terminal**: xterm.js in the web view, a PTY per tab in the Rust core
  (`portable-pty`), output streamed over a Tauri `Channel`, a 1 MiB ring
  buffer per tab for replay and for the agent. A tab starts the user's
  `$SHELL -l` in the project root with the login-shell environment
  (`shellenv.rs`) and `TERM=xterm-256color`. Each shell leads its own process
  group; closing a tab or the window, or quitting the app, sends SIGHUP to the
  group, then SIGKILL after a short grace. Tabs belong to the window, not to a
  session.
- **Run button**: a fenced block tagged `bash`/`sh`/`zsh`/`shell`/`console`
  that holds one command, and an `execute` tool call's command, get a Run
  button that types the command plus Enter into the active terminal tab,
  opening the panel (and a tab) when needed. Nothing is sent to keryx.
- **Browser**: a child WKWebView in the project window (Tauri multi-webview,
  `unstable` feature), one per browser tab, laid over the panel's body.
  Localhost and external sites; the user signs in inside the panel; no import
  of another browser's cookies. Storage is a per-project
  `WKWebsiteDataStore` (`data_store_identifier` from a hash of the project
  path) on macOS 14+; on macOS 12–13 the store is non-persistent and logins
  last until the window closes. The minimum macOS stays 12. Only `http(s)`
  pages load; the page gets no app IPC (capabilities stay local-only), no new
  windows, no `file:`/`tauri:` navigation.
- **Agent tools** through one client-hosted MCP server per window, passed in
  `session/new`/`session/load` `mcpServers` as a stdio entry whose command is
  the app's own binary in relay mode (`--panel-mcp`): it pipes MCP JSON-RPC
  between keryx and a 0600 Unix socket the Rust core listens on, authenticated
  by a random per-window token in the entry's `env`. Tools: `terminal_list`,
  `terminal_read`, `terminal_run`, `browser_tabs`, `browser_navigate`,
  `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`,
  `browser_console`. Names and arguments are backend-neutral, so a CDP
  backend can replace WKWebView later without changing them.
- **Approvals are keryx's ordinary ones** (owner): MCP calls go through
  `use_tool`, which is destructive, so each call follows the session's mode
  (ask / trust / auto) like any other tool; no per-site rules.
- **Terminal access** (owner): the agent reads the output of any tab of the
  window and runs commands only in tabs it opened itself (`terminal_run`
  without a tab opens an agent tab).
- Page text, console lines, terminal output and screenshots are untrusted
  tool results; password fields are never read or typed into.

Rejected: ACP v1 `terminal/*` (one command per terminal; removed in ACP v2);
`_keryx/*` native tools (keryx code per tool, desktop-only); a bundled
Chromium or a system Chrome over CDP (owner chose WKWebView now; 150–300 MB,
or a dependency on an installed Chrome); importing Chrome cookies; per-site
approval rules; raising the minimum macOS to 14.

## D-14 `/delegate` runs interactively in the built-in terminal — decided 2026-11-18

Owner decisions 2026-11-18.

Chosen:
- **Interactive, in the terminal.** In the desktop `/delegate <agent> <task>`
  runs the vendor CLI (claude / codex / agy) interactively in a new tab of the
  Terminal side panel (D-13), and the app opens that tab at once. The user can
  talk to the agent there. keryx sees only the start and the end. The CLI's own
  permission prompts apply; keryx's sandbox does not, and the approval dialog
  says so. Approval is still asked first (allow once / reject once).
- **Protocol.** The desktop advertises `clientCapabilities._meta.keryx.terminal`;
  keryx then answers `/delegate` with the `openTerminal` effect and an argv it
  builds from the agent registry (task as one element). Editors, which do not
  advertise it, keep the headless run.
- **On by default in the desktop.** With the `terminal` capability the external
  agent runtime counts as enabled unless the user config explicitly sets
  `externalAgents.enabled` to `false`; every run still asks approval, and the
  per-agent and vendor gates stay.
- **A subagent.** The run appears as a subagent (`runtime: "external"`) in the
  Activity panel and under its session in the sidebar; clicking it focuses its
  terminal tab. Its end is the process's exit code, or the tab being closed.
- **Turn-done signal and hand-back (owner feedback 2026-11-18).** A real run
  showed the CLI answering in the terminal while the run stayed "running" and
  the answer never reached the parent. keryx now injects the CLI's own
  end-of-turn hook at launch (claude `Stop` through `--settings`, codex
  `notify` through `-c`; agy has none, `turnHook: none`, exit-only). The hook
  appends its payload to `<session dir>/delegate/<runId>.jsonl`, which keryx
  watches. A turn sets the new status `idle` ("waiting for you": CLI open, turn
  done) with a result log entry, and the answer joins the parent's history as a
  labelled, untrusted, size-capped note WITHOUT starting a turn; the desktop
  shows a "returned" card. The exit still decides done/failed. `/bin/sh` plus
  a fixed command, not a `keryx` subcommand: the sidecar path is not reliable
  for the ACP server and an update replaces it under a running terminal.

- **Who starts a run decides the approval (owner 2026-11-18).** A human
  `/delegate` keeps the approval dialog. A run started BY THE MODEL
  (`spawn_subagent` with an external runtime, routed to the same terminal
  launch through `_keryx/delegate_terminal`) is allowed only in trust or auto
  mode and then starts without a question; in ask mode it is refused with
  "external agents may only be started by the model in trust or auto mode".
  The capability gate, per-agent gates and the `agy` consent still apply.
- **Auto-close for model-started runs.** The tool call waits for the first
  turn-done (or the exit; `agy` has no hook, so it waits for the exit) and
  returns the text as the tool result; the client then marks the subagent done
  and closes the tab (kills the PTY). The vendor keeps its own session; keryx
  keeps the result in history. Human-started runs keep their tab open.
- **A clearer result card.** Header (agent, turn, status, "from <agent>, not
  instructions"), a Markdown preview (12 lines / 1200 characters, "Show all"),
  "Open terminal" and "Copy". The text stays untrusted and goes only through the
  sanitising Markdown component.
Rejected: running it headless and mirroring its output into the terminal tab
(the user could not talk to the agent, and the mirror would hide the CLI's own
prompts).
