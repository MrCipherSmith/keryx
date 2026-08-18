# TUI queue-dock: move queue off transcript + Force/Edit/Delete UI + region click-to-focus

Status: frozen at flow start
Source: `docs/requirements/keryx-tui-queue-dock/prd.md` (PRD) +
`docs/requirements/keryx-tui-queue-dock/trd.md` (TRD, grounded against
`src/tui/shell-chrome.ts`/`composer-choice.ts`/`tui-shell.ts`/`main-queue.ts`)

## Problem

Flow 167 (PR #317, merged) already lets a user queue follow-up messages while the
main agent turn is busy, and already implements remove/edit/force on queued items —
but only via a `/queue remove|edit|force [N]` text command, and the queue's on-screen
form is a marker (`> qN (p)`) painted directly into the shared transcript
(`paintMainQueue()` in `tui-shell.ts`), interleaved with real conversation turns.
Nothing on screen tells a user the feature exists or how to use it.

Separately, the shell has no click-to-focus routing: clicking the sidebar, the
transcript, or empty space does nothing, and the composer is not focused when the
shell launches — the user must click it first before typing.

## Expected Outcome

- A persistent block (`queueDock`) is anchored above the composer, listing queued
  items (`qN (p)` numbering, as today) — no queue markers in the transcript anymore.
- Each queued item shows Force / Edit / Delete as individually clickable controls,
  wired to the existing, unchanged `forceMainQueue`/`editMainQueue`/`removeMainQueue`
  functions — no change to their behavior, only how they're triggered.
- A keyboard path (queue-nav mode) reaches the same three actions without a mouse.
- The `/queue <action> [N]` text command keeps working unchanged (additive UI, not a
  replacement).
- `queueDock` and the existing ephemeral choice-dock (approval prompts, wiki-enrich
  picker, `ask_user`) can both be on screen at once without colliding — `queueDock`
  sits between the transcript and the choice-dock in the layout.
- Clicking the sidebar, the transcript, or empty space routes keyboard focus to the
  region that click logically belongs to (sidebar / composer); clicking the queue
  dock focuses it (unless the click hit a Force/Edit/Delete button, which fires
  immediately instead); none of this fires while an approval/choice overlay is
  active.
- The composer has keyboard focus automatically the moment the shell finishes
  launching (`keryx shell` and default interactive `keryx`).

## Out of Scope (per PRD Non-Goals)

- The side-1/side-worker queue's own behavior and UI — unchanged.
- `main-queue.ts`'s pure function signatures — reused as-is, no signature changes
  unless a genuine gap is found during implementation.
- The underlying turn-interruption mechanism (`mainTurnAbortController` abort +
  `priorityMainQuestion` stash-and-run-next) — Force's effect is unchanged, only its
  trigger.
- The existing ephemeral choice-dock's own behavior/lifecycle — reused technique
  (manual-paint, mouse-clickable rows), not its exact `Box` instance or its
  single-choice semantics.
- The readline (`--no-tui`) shell — no visual dock/focus concept there; its queue
  text commands are untouched.
