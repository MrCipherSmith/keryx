# PRD: TUI Main-Queue Dock + Region Click-to-Focus

## 1. Overview

Two related interaction improvements to the interactive OpenTUI shell:

1. Move the main-message-queue display out of the shared transcript stream and into
   a dedicated, persistent block anchored above the composer, and give each queued
   item three discoverable, directly-actionable controls — **Force** (interrupt the
   running turn and run this item next), **Edit** (pull the item back into the
   composer, preserving its queue position for re-submission), and **Delete**
   (remove it) — reachable by mouse click and by keyboard, without requiring the
   user to already know the `/queue <action> [N]` text-command syntax.
2. Clicking anywhere in the terminal routes keyboard focus to the region the user
   actually clicked (sidebar, the queue dock, or the composer), and the composer is
   focused by default the moment the shell launches — so a user can start typing
   immediately, and clicking any empty/output area gets them back to the composer
   without hunting for it.

Added 2026-08-18: item 2 (click-to-focus routing + launch autofocus) was folded into
this same PRD/TRD/flow at the operator's explicit request, after item 1 was already
confirmed — both land together, same package, same implementation pass.

## 2. Context

- **Product:** Keryx interactive shell (`keryx` CLI, OpenTUI-based)
- **Module:** `src/tui/` (`tui-shell.ts`, `main-queue.ts`, `composer-choice.ts`)
- **User Role:** Keryx operator running the interactive TUI shell, queuing follow-up
  messages while the main agent turn is busy
- **Tech Stack:** TypeScript/Bun, `@opentui/core` (optional, lazily-loaded renderer);
  readline shell is the fallback when OpenTUI is unavailable

## 3. Problem Statement

Flow 167 (PR #317, merged) already implements the main-queue's behavior: while the
main agent is busy, a submitted message can be routed to the main queue (drains FIFO
once the turn completes) or to the side-1 worker (answers immediately, in parallel).
Main-queue items can already be removed, edited (with position preserved on
re-submit), or forced (interrupts the running turn) — but only via a text command,
`/queue remove|edit|force [N]`, and the queue's on-screen representation
(`paintMainQueue()` in `tui-shell.ts`) paints each item as a marker
(`> qN (p) <text>`) directly into the shared transcript, interleaved with the actual
conversation.

Two problems follow from this:

1. **Discoverability.** Nothing on screen tells the user which three actions are
   available, or the exact command syntax — a user who doesn't already know
   `/queue force 2` cannot use the feature.
2. **Visual noise.** Queued-but-not-yet-run messages are not part of the
   conversation record; painting them into the transcript mixes "things that
   happened" with "things that are pending," and they scroll away with everything
   else instead of staying visible near the input where the user is about to act.

The codebase already has a proven UI pattern for exactly this shape of problem:
`composer-choice.ts` renders a mouse-and-keyboard-clickable option list docked above
the composer (used today for approval-gate prompts and the wiki-enrich page picker).
This PRD asks for that pattern to be applied to the main queue.

## 4. Goals

- Queued main-queue items are visible in a dedicated block anchored above the
  composer, not interleaved with the transcript.
- Each queued item exposes Force / Edit / Delete as discoverable controls — usable
  by mouse click and by keyboard — without requiring prior knowledge of the
  `/queue` text-command syntax.
- Edit preserves the item's original queue position on re-submission (already true
  today at the data layer via `reinsertMainQueueItem`; the new UI must not regress
  this).
- Force still interrupts the in-flight main turn and runs the forced item next
  (already true today via `forceMainQueue`; the new UI must not regress this).
- The block updates live as items are added (new message queued while busy),
  removed, edited, or forced, and disappears when the queue is empty.
- Clicking any region of the terminal (sidebar, queue dock, transcript/output area,
  empty space) moves keyboard focus to the control that click logically belongs to,
  instead of leaving focus wherever it happened to be.
- The composer has keyboard focus the instant the shell finishes launching, so a
  user can start typing without an extra click.

## 5. Non-Goals

- No change to the side-1/side-worker queue's behavior or its own UI — this PRD is
  scoped to the **main** queue only.
- No change to `main-queue.ts`'s pure function signatures
  (`removeMainQueueItem`/`editMainQueueItem`/`reinsertMainQueueItem`/
  `formatMainQueueMarker`/`parseQueueCommand`) unless implementation surfaces a
  genuine gap; the default assumption is these are reused as-is.
- No change to the underlying turn-interruption mechanism (`mainTurnAbortController`
  abort + `priorityMainQuestion` stash-and-run-next) — Force's *effect* is
  unchanged, only *how the user triggers it* changes.
- No redesign of the existing `composer-choice.ts` ephemeral choice-dock's own
  behavior for approval prompts / wiki-enrich picker / `ask_user` — this PRD may
  reuse its rendering *technique* (manually-painted, mouse-clickable rows) but does
  not require reusing the exact same `Box` instance if that instance's ephemeral,
  single-choice lifecycle doesn't fit a persistent, multi-item block. That choice is
  left to the TRD.
- No readline-shell (non-OpenTUI, `--no-tui`) equivalent is required by this PRD;
  the readline shell has no visual dock concept today and queue text commands
  already work there unchanged.
- Click-to-focus routing does not change what any control *does* — only which
  control has keyboard focus after a click. It is not a replacement for the
  keyboard-only navigation already required by FR-8/FR-14.
- No change to `chrome.input`'s (`ComposerInput`) own text-editing behavior — this
  PRD only changes *when* it receives focus, not how it behaves once focused.

## 6. Functional Requirements

- **FR-1:** While one or more items are in the main queue, a persistent block MUST
  be visible above the composer listing every queued item in order, using the
  existing `qN (p)` numbering convention (`formatMainQueueMarker`) so position/depth
  stays legible.
- **FR-2:** Each listed item MUST expose three actions — Force, Edit, Delete —
  individually selectable/clickable, without the user needing to type a command.
- **FR-3:** Selecting Force on item at position N MUST behave exactly as
  `forceMainQueue(N)` does today: if a main turn is in flight, abort it and run the
  forced item next once the turn settles; if no turn is in flight, run it
  immediately.
- **FR-4:** Selecting Edit on item at position N MUST behave exactly as
  `editMainQueue(N)` does today: remove the item from the queue, place its text into
  the composer input (focused, ready to edit), and remember its original position so
  that re-submitting it (plain submit while busy, following the existing
  `pendingQueueEdit` mechanism) reinserts it at that same position via
  `reinsertMainQueueItem`.
- **FR-5:** Selecting Delete on item at position N MUST behave exactly as
  `removeMainQueue(N)` does today: remove the item from the queue with no other
  side effect.
- **FR-6:** The block MUST update live: a newly-queued item appears, a
  removed/forced/edited-out item disappears, and remaining items renumber
  (`qN (p)`) accordingly — matching `paintMainQueue()`'s current repaint-on-mutation
  behavior, just rendered in the new location.
- **FR-7:** When the queue is empty, the block MUST NOT occupy screen space (same
  as today: `paintMainQueue()` removes all queue blocks and clears the
  `agent:queue` fleet entry when `mainQueue.length === 0`).
- **FR-8:** Every action MUST remain reachable by keyboard (not mouse-only) — some
  terminals/SSH sessions have no mouse. The exact keyboard interaction model
  (dedicated queue-focus mode, hotkeys, arrow+enter menu, etc.) is a TRD-level
  design decision, but keyboard parity with mouse is a hard requirement, not an
  afterthought.
- **FR-9:** The existing `/queue remove|edit|force [N]` text command MUST continue
  to work unchanged as an additive, scriptable path — this PRD adds a UI, it does
  not remove the existing command surface.
- **FR-10:** When the main-queue block and the existing ephemeral choice dock
  (`composer-choice.ts`, used for approval prompts / wiki-enrich picker / `ask_user`)
  are both needed at the same time (e.g., an approval prompt interrupts a turn while
  messages are already queued), both MUST remain visible and usable without visually
  overlapping or making either one inoperable. The exact stacking/layout order is a
  TRD-level decision.
- **FR-11:** Clicking anywhere inside the sidebar MUST move keyboard focus to the
  sidebar (or the sidebar's currently-focusable element, if the sidebar itself has
  internally-focusable rows) — the click target does not have to be a specific
  interactive element for this to fire.
- **FR-12:** Clicking anywhere inside the queue dock (FR-1's new block), when it is
  visible, MUST move keyboard focus to the queue dock (entering the same keyboard
  interaction mode FR-14/queue-nav describes) — unless the click landed on a
  specific Force/Edit/Delete button, in which case that action's own behavior
  (FR-3/FR-4/FR-5) takes precedence and fires immediately rather than merely
  focusing.
- **FR-13:** Clicking anywhere in the transcript/output region (where the agent's
  turns render), or on any other empty/non-interactive area of the terminal, MUST
  move keyboard focus to the composer — there is nothing to focus *in* the
  transcript itself, and returning focus to the composer is the useful default.
- **FR-14:** The composer MUST have keyboard focus automatically the moment the
  shell finishes its startup/launch sequence, before any user input — both for
  `keryx shell` and the default interactive `keryx` launch — so the user can begin
  typing immediately with no click required.
- **FR-15:** Click-to-focus routing (FR-11..FR-13) MUST NOT interfere with or
  override an active modal/overlay/picker that is already holding focus (e.g. the
  approval-gate choice dock from FR-10, a full-screen picker, block-nav mode) — a
  click while one of those owns the keyboard follows that surface's own existing
  click handling, not this PRD's region-routing.

## 7. Non-Functional Requirements

- **NFR-1:** No change in the underlying data model or interruption semantics for
  Force/Edit/Delete — this is a presentation-layer change. Existing unit tests for
  `main-queue.ts`'s pure functions (`main-queue.test.ts`) MUST continue to pass
  unmodified.
- **NFR-2:** The new block's rendering MUST NOT introduce a new dependency beyond
  `@opentui/core` (already an optional, lazily-loaded dependency) — no new npm
  package.
- **NFR-3:** Mouse-click routing for the new block's rows follows the same
  established technique as `composer-choice.ts` (manual per-row painting, not
  `SelectRenderable`, which has no per-item mouse routing) — consistency with the
  existing pattern, not a new one.
- **NFR-4:** The change must not regress the readline (`--no-tui`) shell's queue
  behavior, which has no dock/visual concept and is out of this PRD's scope (see
  Non-Goals) — its text-command path must keep working exactly as today.

## 8. Constraints

- Must reuse `main-queue.ts`'s existing pure functions and `tui-shell.ts`'s existing
  `removeMainQueue`/`editMainQueue`/`forceMainQueue` wiring — this PRD is a
  presentation/interaction change layered on an already-correct, already-tested
  data/behavior layer, not a rewrite of that layer.
- Must follow this codebase's established convention for composer-anchored,
  mouse-clickable UI (`composer-choice.ts`'s manual-paint pattern) rather than
  introducing a second, different UI paradigm for a very similar problem.
- Must not change `forceMainQueue`'s interruption mechanism
  (`mainTurnAbortController.abort()` + `priorityMainQuestion` stash) — Force's
  visible trigger changes, its effect does not.

## 9. Edge Cases

- **Queue transitions from empty to non-empty while the block is not yet mounted:**
  the first queued item while busy must cause the block to appear, matching
  `paintMainQueue()`'s current behavior of creating/removing blocks on every
  mutation.
- **Force fires while no turn is in flight** (e.g., the previous turn just settled
  microseconds before Force is triggered): must fall through to running the item
  immediately (`runLine`), exactly as `forceMainQueue`'s existing `else` branch does
  today.
- **Edit is triggered, then the user submits an unrelated new message before
  re-submitting the edited one:** existing `pendingQueueEdit` semantics govern this
  today (only the *next* plain-text submit while busy consumes the pending edit,
  per `main-queue.ts`'s header comment); the new UI must not change this contract.
- **Approval-gate dock opens while 2+ items are already queued:** both the queue
  block and the choice dock must be visible and independently operable (FR-10);
  neither may be silently hidden or made unreachable by the other appearing.
- **A queued item's text is very long (pasted multi-line content):** the block must
  degrade the same way the current transcript marker does today (existing
  `displayQuestion`/`summarizeSubmittedLine`-style truncation for display, full text
  preserved for actual submission) — no new truncation policy invented here.
- **Terminal has no mouse (SSH without mouse-reporting, some CI/headless
  wrappers):** every action must still be reachable via keyboard (FR-8) — this is
  not an edge case to degrade gracefully but a first-class supported path.
- **Click inside the queue dock but not on a button** (e.g. on the item's text, or
  padding between rows): must focus the queue dock (FR-12), not silently do
  nothing and not misfire an action.
- **Click while an approval-gate/choice-dock prompt is active:** per FR-15, that
  surface's existing click handling governs; region click-to-focus must not steal
  the click or move focus away from the active prompt.
- **Shell launches directly into a resumed session with existing transcript
  content:** autofocus (FR-14) still applies — focus goes to the composer
  regardless of whether the transcript starts empty or already has history.
- **User clicks the sidebar while the queue dock is also visible:** each region's
  click-to-focus is independent and click-target-scoped (FR-11 vs FR-12) — clicking
  the sidebar must not also shift focus to the queue dock or vice versa.

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: TUI main-queue dock

  Scenario: Queued messages render above the composer, not in the transcript
    Given the main agent turn is busy
    And the user submits a follow-up message routed to the main queue
    Then the message appears in a dedicated block above the composer
    And the message does NOT appear as a new entry in the transcript stream

  Scenario: Force interrupts the running turn and runs the item next
    Given one item is queued in the main-queue block
    And the main agent turn is currently running
    When the user selects Force on that item
    Then the running main turn is aborted
    And the forced item runs next, ahead of anything else queued

  Scenario: Edit preserves the item's original queue position
    Given three items are queued, and the user selects Edit on the second item
    Then the second item's text is removed from the queue and placed in the composer, focused
    And the remaining two items renumber accordingly
    When the user edits the text and submits it while still busy
    Then the edited item is reinserted at its original position (second)

  Scenario: Delete removes an item with no other side effect
    Given two items are queued
    When the user selects Delete on the first item
    Then only the first item is removed
    And the second item remains queued, renumbered to position one

  Scenario: The block disappears when the queue empties
    Given one item is queued and visible in the block
    When that item is forced, edited away, or deleted
    And no other items are queued
    Then the block is no longer shown and occupies no screen space

  Scenario: Keyboard-only interaction reaches every action
    Given a terminal session with no mouse reporting
    And one or more items are queued
    Then the user can select and trigger Force, Edit, and Delete using only the keyboard

  Scenario: The text-command fallback keeps working
    Given one or more items are queued
    When the user types `/queue force 1` (or `remove`/`edit`) instead of using the UI
    Then the action executes exactly as it does today

  Scenario: The queue block and an approval-gate prompt coexist
    Given two items are queued in the main-queue block
    And a `shell_exec` command triggers an approval-gate prompt mid-turn
    Then both the queue block and the approval prompt are visible and independently usable

  Scenario: The composer is focused automatically on launch
    Given the user runs `keryx shell` (or the default interactive `keryx` launch)
    When the shell finishes its startup sequence
    Then the composer has keyboard focus with no click required
    And the user can immediately start typing

  Scenario: Clicking the sidebar focuses the sidebar
    Given the shell is running with focus currently on the composer
    When the user clicks anywhere inside the sidebar
    Then keyboard focus moves to the sidebar

  Scenario: Clicking the queue dock focuses it, without misfiring an action
    Given one or more items are queued and the dock is visible
    When the user clicks on the dock's background or an item's text, not a button
    Then keyboard focus moves to the queue dock
    And no Force/Edit/Delete action is triggered

  Scenario: Clicking a queue item's button fires that action, not just focus
    Given one item is queued
    When the user clicks that item's Force button
    Then the Force action executes (per the earlier Force scenario)
    And this happens as a single click, not click-to-focus-then-second-click

  Scenario: Clicking the transcript or empty space returns focus to the composer
    Given keyboard focus is currently on the sidebar
    When the user clicks anywhere in the transcript/output area, or empty space
    Then keyboard focus moves to the composer

  Scenario: An active approval prompt is not disturbed by region click-to-focus
    Given an approval-gate choice dock is currently active and holding focus
    When the user clicks elsewhere in the terminal
    Then the click is handled by the approval prompt's own existing behavior
    And region click-to-focus does not move focus away from it
```

## 11. Verification

- Unit tests: no change expected to `main-queue.test.ts` (pure logic layer
  untouched); new rendering/interaction code gets its own unit tests for the parts
  that are pure (e.g., any new formatting/selection helpers extracted the same way
  `main-queue.ts`'s original helpers were extracted for testability).
- Manual/interactive verification (this file, like `tui-shell.ts`'s other
  interactive-only surfaces, has "no headless integration harness" per the existing
  documented pattern — see flow 167's AC8 precedent): queue 2+ items, exercise
  Force/Edit/Delete by mouse and by keyboard, confirm transcript stays clean of
  queue markers, confirm coexistence with an approval-gate prompt.
- Regression: full `src/tui` test suite plus the existing `agent`/`shell`/`sac`
  regression suite (same scope flow 167's own AC8 evidence cited) must stay green.
- Click-to-focus + autofocus: manual verification only (same "no headless
  integration harness" limitation) — launch the shell and confirm the composer is
  focused with no click; click each region (sidebar, queue dock with/without a
  button, transcript, empty space) and confirm focus lands correctly; confirm an
  active approval prompt is untouched by clicks elsewhere.
