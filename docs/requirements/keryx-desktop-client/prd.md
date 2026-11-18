# Keryx Desktop Client — PRD
Version: 0.1.1

## Problem

keryx's richest surface is `keryx shell`, a full-screen terminal UI. A
terminal is the wrong home for long agent sessions that people want beside
their editor, with real windows, native file pickers, notifications and
clickable approvals. The existing non-terminal surfaces do not fill the gap:
`keryx acp` is a narrowed editor agent (no web tools, modes, `ask_user`,
plan or background tasks), `keryx serve` runs chat-only turns with no tools,
`keryx serve-mcp` offers tools with no conversation, and the VS Code
extension is a status layer over `keryx serve`.

## Goal

A macOS application, installed from a `.dmg`, that runs keryx agent sessions
with the same tools, approvals and permission modes as `keryx shell`, reached
in three milestones, without moving any agent logic out of keryx.

## Users

- The owner and keryx users on macOS who run long agent sessions today in
  `keryx shell`.
- Users of other ACP clients (Zed and others), who gain the shell profile
  through the same `keryx acp` wire.

## Requirements

R1. `keryx acp --profile shell` offers the shell's tool roster built by
`buildInteractiveAgentTools`, minus the tools listed as M2 in the
specification. The default profile stays `editor` and unchanged.
Verification: exec `bun test src/acp/shell-profile.test.ts`

R2. In the `shell` profile, `session/new` and `session/load` advertise the
modes `ask`, `trust`, `auto`; `session/set_mode` switches them and the gate
behaves as the shell's permission modes do.
Verification: exec `bun test src/acp/shell-profile-modes.test.ts`

R3. The `editor` profile's roster and answers are unchanged.
Verification: invariant `bun test src/acp/editor-profile-golden.test.ts`

R4. In the `shell` profile keryx sends `plan`, `usage_update` and
`session_info_update` session updates, and forwards `ask_user` to a client
that advertised it.
Verification: exec `bun test src/acp/shell-profile.test.ts`

R5. `initialize` reports the real keryx version and the supported profiles,
so a client can refuse an incompatible keryx.
Verification: exec `bun test src/acp/shell-profile.test.ts`

R6. The desktop app opens a project folder, starts a session, streams the
answer with reasoning and tool calls, and answers approvals and `ask_user`
questions in native dialogs.
Verification: judged

R7. The desktop app lists, loads and starts sessions, switches model and
permission mode, and shows the execution plan and token usage.
Verification: judged

R8. An incompatible keryx is refused with both versions named.
Verification: exec `cd apps/desktop/src-tauri && cargo test`

R8a. The app bundles a compiled keryx sidecar and can be switched to a keryx
on `PATH` in settings.
Verification: exec `test -x apps/desktop/src-tauri/target/release/bundle/macos/Keryx.app/Contents/MacOS/keryx`

R9. One command builds an installable `.dmg` on the owner's Mac.
Verification: exec `bun run desktop:build`

R10. A `desktop-v*` tag builds a universal `.dmg` on a macOS runner and
attaches it to a GitHub release; signing and notarization run when the
Developer ID secrets exist.
Verification: none — the workflow cannot run before the first `desktop-v*` tag is pushed; it is reviewed by reading it.

## Success Criteria

### Release criteria (M1)

- R1–R5 tests pass and `bun test src/acp/` stays green.
- `cargo test` passes in `apps/desktop/src-tauri`.
- `bun run desktop:build` produces `Keryx.app` and a `.dmg` on arm64.
- The installed app completes a real turn against a configured provider, with
  at least one approved `shell_exec`.

### Outcome criteria

- The owner uses the desktop app instead of `keryx shell` for day-to-day
  sessions within two weeks of M1. Observation: the owner's own report, and
  `acp:` sessions outnumbering TUI sessions in `/sessions` over that window.
- Another ACP client uses the shell profile. not measured — there is no
  telemetry, and keryx will not add any for this.

## Risks

- **Untrusted tool results over ACP.** `web_fetch`/`web_search` mark results
  untrusted, and the approve-before-announce path has no live ACP test. M1
  adds that test before the tools are offered.
- **Lease conflicts.** A session held by a running `keryx shell` cannot be
  loaded; the client must offer fork rather than fail silently.
- **Compiled-binary gaps.** `bun build --compile` does not trace three
  optional-dependency imports (embedding, PII NER, injection detector); those
  features fall back exactly as in the released standalone binary.
- **Unsigned M1 build.** Gatekeeper warns on other machines until D-05's
  Developer ID step is switched on.
- **Image prompts slip.** They depend on flow 493, not yet on main.

## Recommendation

Build M1 now: the `shell` profile on the keryx side and the Tauri client in
`apps/desktop`, with a local `.dmg` build. Defer every M2/M3 item until the
owner has used M1 for real sessions.
