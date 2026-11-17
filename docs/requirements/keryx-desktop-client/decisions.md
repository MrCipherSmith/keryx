# Keryx Desktop Client — Decisions
Version: 0.1.1

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
