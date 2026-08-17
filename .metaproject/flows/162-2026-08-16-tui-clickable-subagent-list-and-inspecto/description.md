# TUI: clickable subagent list and inspector modal

Status: ready
Source: user description + Grok Build reference (`~/goodea/misk/grok-build`)

## Problem

The OpenTUI agent shell already surfaces spawned subagents in the sidebar Status
panel (`WorkerFleet` + `formatFleetSidebar`), but the list is a single
non-interactive `TextRenderable`, truncated to ~12 lines (`… +N more`), and
finished children disappear after 15s. There is no way to open a child and
watch its work the way Grok Build does (full clickable list → overlay of the
child transcript).

## Expected Outcome

- Every session subagent (running, done, failed) stays visible in the sidebar.
- Each row is clickable (OpenTUI `onMouseDown`).
- Click opens the shared modal host with the child's task, live work log
  (tools / reasoning / text), and metadata (model, status, elapsed).
- Child `AgentIO` events feed the inspector so the modal updates while the
  child is still running.

## Out of Scope

- Grok Build's fullscreen takeover, kill buttons, or worktree isolation UI.
- Changing MAE spawn policy, child tool lists, or the 15s parent-summary bound.
- Readline-shell parity (inspector is OpenTUI-only; missing otui is a no-op).
