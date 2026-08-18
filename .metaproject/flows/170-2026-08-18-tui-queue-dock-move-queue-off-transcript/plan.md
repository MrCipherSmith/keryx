# Implementation Plan

Status: adopted from TRD (`docs/requirements/keryx-tui-queue-dock/trd.md`) — layout
and interaction decisions already resolved through code grounding.

## Approach

Two related changes to `src/tui/shell-chrome.ts` + `src/tui/tui-shell.ts`, both
reusing existing primitives (no new dependency, no change to `main-queue.ts`'s pure
logic, no change to `forceMainQueue`/`editMainQueue`/`removeMainQueue`'s behavior):

1. A new persistent `queueDock` Box replaces the transcript-embedded queue markers.
2. Region `onMouseDown` handlers + one launch-time `.focus()` call add click-to-focus
   routing and autofocus.

## Steps

1. **`queueDock` construction** (`shell-chrome.ts`) — mirror `dock`'s construction
   (`shell-chrome.ts:480-493`: `flexShrink: 0`, rounded border, theme panel/border
   colors), insert via `main.add(queueDock)` between `main.add(scroll)` and
   `main.add(dock)`. Expose as `readonly queueDock: Box` on `ShellChrome`'s public
   interface, next to `dock`.
2. **Per-item row with 3 buttons** (`tui-shell.ts`) — rewrite `paintMainQueue()` to
   build, per queue item, a `flexDirection: "row"` container: label text (reuses
   `formatMainQueueMarker` + `displayQuestion`, same text as today) + three
   `BoxRenderable` buttons (Force/Edit/Delete), each `onMouseDown` calling the
   existing `forceMainQueue(index)`/`editMainQueue(index)`/`removeMainQueue(index)`.
   Mount rows into `chrome.queueDock` instead of `transcript`; drop the
   `appendUserEcho(..., transcript, ...)` call entirely. `queueDock.visible =
   mainQueue.length > 0`, mirrored from `dock`'s existing visibility pattern.
3. **Keyboard queue-nav mode** (`tui-shell.ts`) — new `onKeypress`-subscribed
   handler, entry key `Ctrl+Q` (verify no collision with existing `ctrl &&`
   bindings in this file first), active only while `mainQueue.length > 0`: ↑/↓ move
   `selectedQueueIndex`, ←/→ move the selected action, Enter fires the same
   function the matching mouse button calls, Esc exits queue-nav. Extend
   `overlayActive()` (`shell-chrome.ts:502-509`) to also return true while
   queue-nav is active, so the `/`-menu router stays inert during it — same pattern
   `dock.visible` already uses.
4. **Verify OpenTUI mouse dispatch order** (implementation-time investigation,
   flagged as a real risk in TRD §1.6) — confirm whether a click on a nested
   button also fires its parent row's/`queueDock`'s `onMouseDown`. If it bubbles,
   guard `queueDock`'s own handler to no-op when the click already resolved to a
   button (check `@opentui/core`'s event target/propagation API). Do this BEFORE
   writing the region click-to-focus handlers in step 5, since the same dispatch
   question applies there (row text vs. row buttons vs. `queueDock` background).
5. **Region click-to-focus** (`shell-chrome.ts`) — `onMouseDown` on `sidebar`
   (focus sidebar), `scroll`/transcript (focus composer via `chrome.input.focus()`),
   `queueDock` (enter queue-nav, per step 4's dispatch-order fix). Each handler
   early-returns when `overlayActive()` is true (FR-15 — don't steal focus from an
   active approval/choice overlay).
6. **Launch autofocus** (`tui-shell.ts`) — one `chrome.input.focus()` call
   immediately after `createShellChrome()` resolves (~line 1536), before the main
   input loop starts accepting keystrokes.
7. **Tests** — unit tests for any new pure helpers extracted for testability
   (mirroring how `main-queue.ts`'s originals were extracted); manual/interactive
   verification per PRD §11 (no headless harness exists for `launchTuiAgentShell`,
   same documented limitation as flow 167's own AC8) — queue 2+ items, exercise
   Force/Edit/Delete by mouse and by keyboard, confirm transcript stays clean,
   confirm coexistence with an approval-gate prompt, confirm autofocus on launch,
   confirm each region's click-to-focus, confirm an active approval prompt is
   undisturbed by clicks elsewhere.
8. **Docs** — no external-facing docs currently describe this interactive-only
   surface in detail beyond flow 167's own PR; check whether a brief mention is
   warranted anywhere docs already describe the TUI shell's queue/side-worker
   behavior, and update if so (light-touch, matching prior flows' convention of
   keeping docs current with code).

## Risks

- The `Ctrl+Q` keyboard entry point for queue-nav (step 3) was proposed in the TRD
  as a recommendation, not confirmed against every existing binding in
  `tui-shell.ts` — implementer must re-verify no collision at build time and pick a
  different key if one exists.
- OpenTUI's mouse dispatch/bubbling behavior for nested `onMouseDown` handlers
  (step 4) is the one piece of this plan not already proven by an existing code
  pattern in this repo — budget real investigation time for it, first, before the
  rest of steps 2/5 depend on the answer.
- Region click-to-focus (step 5) must not regress the existing approval-gate/
  choice-dock/block-nav keyboard-ownership arbitration (`overlayActive()`) — test
  the overlay-active guard explicitly, not just the happy path.
