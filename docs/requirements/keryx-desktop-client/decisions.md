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

## D-15 keryx from npm by default; the CLI installs and updates the app — decided 2026-11-17

Numbered D-15 because D-10 to D-14 were taken by the M2 work (PR #1230),
which was still open when this decision was written. Acceptance criteria
AC25-AC28 follow that PR's AC13-AC24 for the same reason.

Owner decision of 2026-11-17; the specification below was confirmed by the
owner on 2026-11-18 (auto source with the one-time migration, `.app.tar.gz` +
`SHA256SUMS`, the check through `keryx app status`, work based on main). It amends D-04 (the default keryx source) and the update
channel of D-06 for as long as there is no Developer ID (D-05): a browser
download of an ad-hoc signed app is quarantined and refused by Gatekeeper,
while a file the keryx CLI fetches is never quarantined.

Chosen:

- **Default source `auto`**: `keryx` on the login-shell `PATH` first (the
  npm-installed CLI, so `npm i -g keryx` updates the agent without a new
  app), the bundled sidecar as the fallback. `bundled`, `path` and `custom`
  stay selectable. A settings file written before D-15 (no
  `settingsVersion`) holding `keryxSource: "bundled"` is read as `auto`
  once, because the old app stored its default on every save.
- **`keryx app install|update|build|status`** in the CLI:
  - `install` / `update` read the `desktop-v*` releases of
    `MrCipherSmith/keryx` on GitHub, take the newest non-draft one
    (pre-releases only with `--pre`), download
    `Keryx_<version>_<arch>.app.tar.gz` for the host arch (`aarch64` /
    `x64`, else `universal`), verify its SHA-256 against the release's
    `SHA256SUMS` asset, unpack it into a staging folder next to the target
    and swap it into `/Applications/Keryx.app` (`--dir` overrides) by
    rename: old app → backup, staged → target, backup removed; a failed swap
    restores the backup. It refuses while the app runs, unless
    `--wait-pid <pid>` (the app's own hand-off) is given; `--relaunch` opens
    the new app afterwards. `update` does nothing when the installed
    `CFBundleShortVersionString` is already the newest.
  - `build` runs `scripts/desktop/build.sh` from the keryx repository
    checkout of the cwd and refuses outside one; it is for development, as
    `bun run desktop:build` is.
  - `status` (`--json`) reports the installed app version and path, the
    newest release, whether an update exists, the running keryx version and
    whether this keryx needs a newer app.
- **Release assets**: `desktop-release.yml` also uploads
  `Keryx_<version>_universal.app.tar.gz` (the signed `.app`, packed with
  `tar` so the bundle's symlinks and modes survive) and `SHA256SUMS` over it
  and the `.dmg`. The `.dmg` stays the browser download.
- **Compatibility both ways**: the app keeps refusing a keryx below its
  floor (D-04). keryx adds `minDesktopVersion` to `initialize._meta.keryx`
  and to `app status`; an app below it shows the banner as required. A keryx
too old for the app keeps the existing incompatible-keryx dialog, which now
names `npm i -g @mrciphersmith/keryx`.
- **Update banner**: at startup, and at most every 6 hours while open, the
  app runs `<resolved keryx> app status --json`, so the release lookup
  lives in one place, the CLI. A newer release, or a keryx that needs a
  newer app, shows a banner with **Update and relaunch**: the app starts
  `keryx app update --wait-pid <its pid> --relaunch` detached and quits. A
  keryx without `app status` (older than this change) shows no banner.

Integrity, not authenticity: the checksum comes from the same release over
TLS, so it catches a broken download, not a compromised release. Developer
ID signing with the signed updater of D-06 replaces this channel once D-05
is switched on.

Rejected: `tauri-plugin-updater` now (it needs a signed manifest and still
meets Gatekeeper on an ad-hoc app); mounting the `.dmg` with `hdiutil` in
the CLI (a macOS-only path the Linux CI cannot test); the app querying
GitHub itself (a second copy of the release logic, in Rust).
