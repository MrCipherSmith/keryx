# TUI: provider and search-provider wizards in ModalHost, /tools and /mcp layout, mode row in sidebar, persistent splash until first message

Status: formalized
Source: operator feedback with screenshots, 2026-09-19 (after 0.2.117)

## Problem

1. `/model` renders as a ModalHost dialog (flow 269), but the rest of the
   `/provider` / `/connect` wizard and the whole `/search-provider` wizard still
   mount full-screen `overlayBox`es on the renderer root: header, sidebar and
   status disappear mid-wizard. `/tools` and `/mcp` are ModalHost dialogs but
   their rows wrap to column 0, the footer advertises connect/disconnect keys on
   the Tools tab, `shell_task_kill` reads as `read`, and a valid Grok
   `[[marketplace.sources]]` table is reported as a config problem.
2. `/plan on|off` toggles read-only mode with a toast only; nothing in the
   interface shows it (nor the `/mode` permission mode).
3. The boot animation flashes for 350 ms with loading steps that do no work.

## Expected Outcome

- Both wizards render every step in ModalHost when the shell chrome exists;
  the startup picker and the chat shell keep the overlay.
- `/tools` and `/mcp` rows wrap with hanging indentation, per-tab footers, a
  clearly labelled risk column, `~` paths; the Grok reader ignores foreign
  array-of-tables headers.
- A sidebar "Mode" row shows permission mode and read-only.
- The wordmark stays in the empty transcript until the first message.

## Out of Scope

- `/mode` and "Resume session" stay in the composer dock (operator decision).
- Approval / ask_user confirmations stay in the dock.
- Other ModalHost dialogs' content (session, flow, workspace, jobs, game).
