# Keryx OpenTUI Session Info
Version: 0.2.0

## Purpose

A **read-only inspector** of the current interactive session, mounted
inside the reusable modal+tabs host. Operators see identity, model,
turn/message counts, context usage, and (when the session actually
referenced them) SAC workspaces and flows — without leaving the
transcript.

## Status

`implemented` · shipped in 0.2.36 / 0.2.37. Slash token is **`/status`**
only. `/session-info` and `/info` are **not** aliases.

## Document index

- [Product requirements](prd.md)
- [Technical specification](specification.md)

## Scope

- Slash command `/status` in both agent and chat modes (TUI and
  readline / `--no-tui`).
- One modal titled `/status`. Always-on tabs: **Status**, **Context**.
  **Workspaces** and **Flow** appear only when the session referenced a
  SAC workspace or a flow (`runLink.sessionId` or an explicit `flow 154`
  / `/flows 154` mention).
- Fields derived from `SessionSummary`, live provider/model, last
  `onUsage`, and a labelled `estimateContextTokens` — never a guessed
  window.
- `c` copies the session id (OSC-52 / existing clipboard path).
- Readline fallback: a compact text dump of the same fields (no modal).
- Sibling slash `/flows` (same host, list + Detail) is documented in
  operator docs; it is not this package's command.

## Non-goals

- Building the modal/tab host (sibling package; already implemented).
- Session picker (`/sessions`, `/resume`) rewrite.
- Grok-only fields keryx does not have: SuperGrok OAuth vs API-key
  lecture, model hash, sandbox profile, `grok login` upsell.
- Click-to-copy / drag-select (mouse). Keyboard-first.
- Mutating the session from this surface (rename, fork, compact).
- Restoring `/session-info` / `/info` as aliases.
- Migrating `/model` onto the host (later consumer of the host package).

## Related modules

- [Modal and tabs](../keryx-opentui-modal-tabs/README.md) — required host.
- [OpenTUI shell](../keryx-opentui-shell/README.md) — slash registry,
  chrome, clipboard.
- Code: `src/commands/agent-commands.ts`, `src/tui/session-info.ts`,
  `src/tui/inspector-sources.ts`, `src/tui/context-usage.ts`,
  `src/session/store.ts` (`SessionSummary`), `src/tui/tui-shell.ts`,
  `src/commands/shell.ts`.
