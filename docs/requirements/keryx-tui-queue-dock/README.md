# TUI Main-Queue Dock Notes

Status: **PRD drafted (2026-08-18), pre-implementation.** See [prd.md](prd.md) for
the formal requirements. This README is the discovery log behind that PRD.

## Origin

Voice request (RU) 2026-08-18: while the main TUI agent is busy, a user can already
queue follow-up messages (flow 167, PR #317, merged) or route them to the "side-1"
side worker instead. The user wants a UI polish pass specifically on the **main
queue**: move its display out of the shared transcript into a dedicated block above
the composer, with clickable/keyboard Force / Edit / Delete actions per item.

## Current-state findings (code read, 2026-08-18)

- **`src/tui/main-queue.ts`** — pure, already-tested helpers: `QueuedMainQuestion`
  (`id`/`question`/`displayQuestion`), `formatMainQueueMarker(index, total)` (today's
  `> qN (p)` transcript-marker text), `removeMainQueueItem`, `editMainQueueItem`
  (pulls an item's text out, returns `{text, rest, removed}`), `reinsertMainQueueItem`
  (re-inserts at the original index — this is what already makes "edit preserves
  position" true today), `parseQueueCommand` (parses `/queue remove|edit|force [N]`).
  None of this needs to change; it's the reusable business logic layer.
- **`src/tui/tui-shell.ts`** (~2300 lines) already wires all three actions:
  `removeMainQueue(index)`, `editMainQueue(index)` (sets `pendingQueueEdit`, puts
  the text back in `input.value`), `forceMainQueue(index)` (aborts
  `mainTurnAbortController` if a turn is in flight, stashes the item as
  `priorityMainQuestion` to run next once the turn's `finally` settles, or runs it
  immediately via `runLine` if nothing is in flight). These are the exact functions
  the new UI must call — no redesign needed.
- **`paintMainQueue()`** (`tui-shell.ts`, ~line 2415) is the thing that needs to
  change: it currently renders each queue item via
  `appendUserEcho(otui, r, transcript, {...})` — i.e. paints directly into the
  shared `transcript` renderable, interleaved with real conversation turns.
- **`src/tui/composer-choice.ts`** already implements the UI *pattern* the user is
  asking for, just for a different feature (approval-gate prompts, the wiki-enrich
  page picker, `ask_user` questions): a "dock" `Box` positioned above the composer
  (not in the transcript), with rows **painted manually** rather than via OpenTUI's
  `SelectRenderable` — the file's own comment says why: "the native `SelectRenderable`
  has no per-item mouse routing, only keyboard." Manual painting is what makes each
  row mouse-clickable. This existing dock is ephemeral/single-choice (resolves once,
  then closes) — the main-queue block is different in kind: persistent, can hold
  multiple items at once, mutates as items are added/removed/forced, and must be
  able to be on screen *at the same time* as this same choice dock (an approval
  prompt can interrupt a turn while messages are already queued behind it).

## Open questions carried into the PRD

- Exact coexistence/stacking of the new queue block vs. the existing ephemeral
  choice dock when both are visible at once — PRD states the constraint (must not
  visually collide), leaves exact stacking order as a TRD/implementation call.
- Keyboard-only interaction path (no-mouse terminals/SSH) — must not be second-class
  to mouse clicks.
- Whether `/queue remove|edit|force [N]` stays as a scriptable fallback (yes,
  additive) now that a UI exists.

## Next step

TRD grounding this against the actual `tui-shell.ts` layout code (where the
composer-choice dock box is actually constructed/positioned), then a Task Manager
flow to implement.
