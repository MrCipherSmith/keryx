# Keryx OpenTUI Session Info
Version: 0.1.0

## Purpose

Add Grok-style `/session-info` (aliases `/status`, `/info`) to the keryx
OpenTUI shell: a **read-only inspector** of the current session, mounted
inside the reusable modal+tabs host. Operators see identity, model,
turn/message counts, and context usage without leaving the transcript.

## Status

`spec ready` · **future**. Blocked on
[keryx-opentui-modal-tabs](../keryx-opentui-modal-tabs/README.md).
No runtime implementation is claimed.

## Document index

- [Product requirements](prd.md)
- [Technical specification](specification.md)

## Scope

- Slash commands `/session-info`, `/status`, `/info` in both agent and
  chat TUI modes.
- One modal, at least a **Session** tab (v1). Extra tabs only if they
  have real keryx data (Usage).
- Fields derived from `SessionSummary`, live provider/model, and usage /
  `estimateContextTokens`.
- Keyboard copy of session id (`c`) and of the whole block (`y`) using
  the existing OSC-52 / clipboard path.
- Readline fallback: a compact text dump of the same fields (no modal).

## Non-goals

- Building the modal/tab host (sibling package).
- Session picker (`/sessions`, `/resume`) rewrite.
- Grok-only fields keryx does not have: SuperGrok OAuth vs API-key
  lecture, model hash, sandbox profile, `grok login` upsell.
- Click-to-copy / drag-select (mouse). v1 is keyboard-first.
- Mutating the session from this surface (rename, fork, compact).
- Migrating `/model` onto the host (later consumer of the host package).

## Related modules

- [Modal and tabs](../keryx-opentui-modal-tabs/README.md) — required host.
- [OpenTUI shell](../keryx-opentui-shell/README.md) — slash registry,
  chrome, clipboard.
- Code: `src/commands/agent-commands.ts`, `src/session/store.ts`
  (`SessionSummary`), `src/tui/tui-shell.ts` (`estimateContextTokens`,
  `onUsage`), `src/commands/sessions.ts`.
