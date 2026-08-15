# Keryx OpenTUI Session Info — PRD
Version: 0.1.0

## Problem

Grok Build's `/session-info` (`/status`, `/info`) opens a modal on a
**Session info** tab and shows title, version, auth, session id, cwd,
model, backend, sandbox, and context-window use. Values are copyable
(`c` = id, `y` = whole block).

Keryx has the data (`SessionSummary`, footer provider/model, per-turn
`onUsage`, `estimateContextTokens`) but **no inspector**. The slash
registry has `/sessions` (list/switch) and `/resume`, not `/session-info`.
The only usage signal is a dim `↑in ↓out tokens` line after a turn and a
footer counter. An operator cannot answer “which session, which model,
how full is context?” without leaving the shell.

## Goal

Match Grok's **operator outcome**, not its catalog: from the TUI, one
slash command opens a modal inspector of the **current** session. The
modal is the shared host from
[keryx-opentui-modal-tabs](../keryx-opentui-modal-tabs/prd.md).

## Users

- Operator mid-turn or idle in `keryx shell` who needs identity + usage.
- Agent following a user “what's this session?” — the command is a
  builtin, never a model turn (same rule as other slash commands).
- Headless / readline users who still need the same facts as text.

## Requirements

| ID | Requirement |
|---|---|
| SI-1 | Register `/session-info` with aliases `/status` and `/info` in `AGENT_SLASH_COMMANDS` for **both** `agent` and `chat` modes. |
| SI-2 | In TUI, the command opens the shared modal host with title `Session` and `initialTab` `session`. It must **not** invent a third overlay stack. |
| SI-3 | Session tab fields (v1, only if the value exists): title, keryx version (`package.json`), session id, project path / cwd, provider, model, parent session id (if fork), created/updated, message count, archive message count, compact count, context usage. |
| SI-4 | Context usage: prefer last provider `usage` (input+output or reported window if present). Else `estimateContextTokens(history)`. Show used and, when known, total + percent. Never invent a Grok-style 128k window. |
| SI-5 | Missing/unknown values render as an explicit `—` / `unknown`, not guessed auth or sandbox rows. |
| SI-6 | `c` copies the full session id; `y` copies the rendered block as text. Both use the same clipboard path as `/copy` / block-nav `y`. Toast on success. |
| SI-7 | The command is a slash builtin: it never calls `provider.stream`. Mid-turn it still opens (read-only). |
| SI-8 | Readline / `--no-tui`: print the same fields as a fixed-width text block; no modal. |
| SI-9 | Optional v1 second tab **Usage**: last-turn ↑/↓ tokens and the estimate. Omit the tab if there is no usage yet **or** ship it with `—`. Pick one and test it; recommendation: always show the tab with `—`. |

## Success criteria

- `/session-info`, `/status`, and `/info` appear in the TUI `/` menu in
  both modes and run the same handler.
- Opening the command while a turn is running does not start a second
  model call and does not cancel the turn.
- Displayed id/path/model match `SessionSummary` + live selection.
- `c` / `y` produce clipboard payloads that match the painted id / block.
- A focused test asserts the slash line never reaches `provider.stream`
  (same pattern as `shell-slash-registry.test.ts`).

## Risks

- Building this **before** the modal host would recreate `overlayBox`
  and block reuse for `/model`. Delivery order is host → this package.
- Copying Grok's OAuth/sandbox rows would lie. Only paint keryx-owned
  facts.
- `estimateContextTokens` is ≈4 chars/token and will disagree with
  billed tokens; label it `estimate` when that path is used.
- `/status` might be confused with `keryx status` (modules). The slash
  alias is session-scoped inside the shell; CLI `keryx status` is
  unchanged.

## Recommendation

Implement only after the modal+tabs host is merged. v1 is one Session
tab plus a Usage tab of placeholders/last-turn numbers. Do not port
Grok mouse selection or billing UI. Leave `/model` on
`selectProviderModelInTui` until a later host migration.
