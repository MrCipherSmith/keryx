# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A message queued while the main agent is busy appears in a dedicated block
  (`queueDock`) above the composer and does NOT appear as a new entry in the
  transcript stream (PRD Gherkin "Queued messages render above the composer").
- AC2: Selecting Force on a queued item aborts the in-flight main turn and runs the
  forced item next; if no turn is in flight, it runs immediately — same behavior as
  today's `forceMainQueue`, only the trigger is new (PRD FR-3).
- AC3: Selecting Edit on a queued item removes it from the queue, places its text in
  the composer (focused), and re-submitting it while still busy reinserts it at its
  original queue position — same behavior as today's `editMainQueue`/
  `reinsertMainQueueItem` (PRD FR-4).
- AC4: Selecting Delete removes only the targeted item; other items remain queued
  and renumber correctly (PRD FR-5).
- AC5: `queueDock` becomes invisible and occupies no layout space when the queue is
  empty (PRD FR-7).
- AC6: Every one of Force/Edit/Delete is reachable via keyboard (queue-nav mode),
  not mouse-only (PRD FR-8).
- AC7: The existing `/queue remove|edit|force [N]` text command still works
  unchanged (PRD FR-9).
- AC8: When `queueDock` (2+ items) and the existing approval-gate choice-dock are
  both needed at once, both remain visible and independently usable, with no
  overlap or dead interaction (PRD FR-10).
- AC9: A click that lands on a queue item's Force/Edit/Delete button fires that
  action directly — it does not merely focus the dock and require a second click
  (PRD FR-12, the dispatch-order risk flagged in TRD §1.6, verified against real
  `@opentui/core` behavior, not assumed).
- AC10: A click on the queue dock's background/item text (not a button) moves
  keyboard focus to the queue dock without firing any action (PRD FR-12).
- AC11: A click anywhere in the sidebar is a safe no-op that does not move focus
  away from wherever it currently is (composer, queue-nav, etc.) and does not
  create a keyboard dead-zone. (Grounding correction, T6: the sidebar has no
  focusable content today — `BoxRenderable._focusable` is only true when
  `focusable: true` is explicitly passed, which nothing in the sidebar does — so
  literally "focusing the sidebar" would call `focusRenderable()`, blur the
  composer, and leave a plain non-interactive box with no `handleKeyPress`
  holding focus, a strictly worse keyboard dead-zone than today's no-op. AC11
  corrected to the behavior actually implemented and verified by test, same
  "don't create a bad state" intent as the original FR-11, not a scope cut.)
- AC12: A click anywhere in the transcript/output area, or on empty space, moves
  keyboard focus to the composer (PRD FR-13).
- AC13: The composer has keyboard focus automatically the moment the shell finishes
  launching (`keryx shell` and default interactive `keryx`), with no click required
  (PRD FR-14).
- AC14: While an approval-gate/choice-dock prompt is active and holding focus, a
  click elsewhere in the terminal does NOT move focus away from it — region
  click-to-focus defers entirely to the active overlay (PRD FR-15).
- AC15: Full `src/tui` test suite plus the existing `agent`/`shell`/`sac` regression
  suite (same scope flow 167's own evidence) stays green; `main-queue.test.ts`
  passes unmodified (NFR-1).
