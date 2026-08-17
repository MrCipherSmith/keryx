# TUI busy-input routing: main queue + side-1 selector

Status: draft
Source: user description

## Problem

When the main agent is busy (`chrome.isBusy()`), any non-control submission
currently goes straight to the automatic read-only `side-1` worker
(`spawnSideWorker`). There is no way to:

- queue a message to the MAIN agent (so it is processed right after the
  current main turn, in the same session), or
- delete / edit / force-push (steer) a queued main message.

The user asked to add a recipient selector when submitting while busy:
**main queue** (delayed main turn, marked in the chat as `qN (n)` with
per-item commands) vs **side-1** (current behavior: read-only, outside main
history). Force = abort the current main turn and run the message as a new
priority turn.

## Expected Outcome

- Submitting a normal question while main is busy shows a selector:
  * Main queue (default) — message goes into the chat transcript marked as
    `> q1 (n) ...` with per-item commands remove / edit / force.
  * Side-1 — current behavior unchanged.
- Queued main messages drain FIFO into the main agent after its current turn
  completes.
- `edit` puts the text back into the composer; on submit it re-queues in
  place. `remove` deletes without queueing. `force` aborts the current main
  turn and runs the message as a new priority turn.
- side-1 Q/A is never written into main history (unchanged).

## Out of Scope

- New workspace / new slate for the queued topic (same session + slate).
- SLATE-19 workspace tools (workspace_create/list/propose) — not implemented yet.
- Changing the side-1 read-only provider behavior.
