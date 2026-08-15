# Context

## Requirements

- `docs/requirements/keryx-opentui-session-info/README.md`
- `docs/requirements/keryx-opentui-session-info/prd.md` (SI-1…SI-9)
- `docs/requirements/keryx-opentui-session-info/specification.md`
- Host: `docs/requirements/keryx-opentui-modal-tabs/` and flow 154

## Existing code

- `src/commands/agent-commands.ts` — `AGENT_SLASH_COMMANDS` (no session-info)
- `src/commands/shell-slash-registry.test.ts` — slash must not stream
- `src/session/store.ts` — `SessionSummary`
- `src/tui/tui-shell.ts` — `estimateContextTokens`, `onUsage`, `TuiSelection`
- `src/commands/sessions.ts` — list/export only

## Dependency

This flow **must** import `openModal` from the host (flow 154). If the host
is not on the current branch, stack on `feat/tui-modal-tabs` or wait; do
**not** fork a private overlay.

## Constraints

- Isolation worktree; branch `feat/tui-session-info` (stack on modal-tabs if present).
- Draft PR required. User pre-selected completion A.

## Collected (T1)

- Registry: `src/commands/agent-commands.ts`. Add `/session-info`, `/status`, `/info` on `BOTH`.
- Slash-must-not-stream: `src/commands/shell-slash-registry.test.ts` `chatOutput` already asserts `streamCalls.count === 0`.
- Agent TUI dispatch: `runLine` in `src/tui/tui-shell.ts`. Busy path currently defers every slash except `/exit`, `/help`, `/interrupt` — session-info must be allowed mid-turn (read-only).
- Chat TUI: `createChatBridge.submit` defers all slash mid-turn. Session-info must return `local` (not queued, not deferred) and `mountChatShell` intercepts to `openModal`.
- Readline chat: handle in `runShell`. Readline agent: handle in `runAgentRepl`. Both print `formatSessionInfoText`.
- Clipboard: `r.copyToClipboardOSC52` + `chrome.showToast` (same as `/copy` / nav `y`).
- Host: sibling worktree is on `feat/tui-modal-tabs`; `src/tui/modal-host.ts` not landed yet. Do not fork `overlayBox`. Stack when host exists.
- Fields: `SessionSummary` + live `TuiSelection` + last `NormalizedUsage` + `estimateContextTokens`. No auth/sandbox/hash rows. Parent row only when `parentSessionId` is set. Label estimates.
