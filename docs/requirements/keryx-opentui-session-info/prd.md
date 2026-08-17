# Keryx OpenTUI Session Info — PRD
Version: 0.2.0

## Problem

Grok Build's `/session-info` (`/status`, `/info`) opens a modal on a
**Session info** tab and shows title, version, auth, session id, cwd,
model, backend, sandbox, and context-window use. Values are copyable
(`c` = id, `y` = whole block).

Keryx already has the data (`SessionSummary`, footer provider/model,
per-turn `onUsage`, `estimateContextTokens`). The shipped inspector
matches Grok's **operator outcome** (identity + usage without leaving
the shell), not Grok's catalog: one slash token, keryx-owned rows only.

## Goal

From `keryx shell`, `/status` opens a modal inspector of the **current**
session on the shared host from
[keryx-opentui-modal-tabs](../keryx-opentui-modal-tabs/prd.md).
Readline / `--no-tui` prints the same facts as text.

## Users

- Operator mid-turn or idle in `keryx shell` who needs identity + usage.
- Agent following a user “what's this session?” — the command is a
  builtin, never a model turn (same rule as other slash commands).
- Headless / readline users who still need the same facts as text.

## Requirements

| ID | Requirement |
|---|---|
| SI-1 | Register **`/status` only** in `AGENT_SLASH_COMMANDS` for **both** `agent` and `chat`. `/session-info` and `/info` are not aliases and must not appear in the `/` menu. |
| SI-2 | In TUI, the command opens the shared modal host with title `/status` and `initialTab` `status`. It must **not** invent a third overlay stack. |
| SI-3 | Status tab fields (only if the value exists): title, keryx version (`package.json`), session id, project path / cwd, provider, model, parent session id (if fork), created/updated, message count, archive message count, compact count. |
| SI-4 | Context tab: prefer last provider `usage`. Else `estimateContextTokens(history)`. Label estimates. Never invent a Grok-style 128k window. |
| SI-5 | Missing/unknown values render as an explicit `—` / `unknown`, not guessed auth or sandbox rows. |
| SI-6 | `c` copies the full session id via the same clipboard path as `/copy` / block-nav `y`. Toast on success. Whole-block `y` is **not** required on this surface. |
| SI-7 | The command is a slash builtin: it never calls `provider.stream`. Mid-turn it still opens (read-only). |
| SI-8 | Readline / `--no-tui`: print the same fields as a fixed-width text block; no modal. |
| SI-9 | Always show **Status** and **Context**. Show **Workspaces** / **Flow** only when the session actually referenced a SAC workspace or a flow. |

## Success criteria

- `/status` appears in the TUI `/` menu in both modes. `/session-info`
  and `/info` do not.
- Opening the command while a turn is running does not start a second
  model call and does not cancel the turn.
- Displayed id/path/model match `SessionSummary` + live selection.
- `c` produces a clipboard payload that matches the painted session id.
- A focused test asserts the slash line never reaches `provider.stream`
  (same pattern as `shell-slash-registry.test.ts`).

## Risks

- Copying Grok's OAuth/sandbox rows would lie. Only paint keryx-owned
  facts.
- `estimateContextTokens` is ≈4 chars/token and will disagree with
  billed tokens; label it `estimate` when that path is used.
- `/status` might be confused with `keryx status` (modules). The slash
  command is session-scoped inside the shell; CLI `keryx status` is
  unchanged.

## Recommendation

Keep `/status` as the only token. Do not port Grok mouse selection or
billing UI. Leave `/model` on `selectProviderModelInTui` until a later
host migration. Browse all project flows through `/flows`, not this
inspector.
