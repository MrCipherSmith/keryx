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
