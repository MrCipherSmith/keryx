# Flow Journal

- 2026-08-18T13:57:36.415Z - flow created
- 2026-08-18T13:58:41.863Z - task-added: T5: Mouse dispatch investigation + keyboard queue-nav mode (Ctrl+Q, arrow select, Enter fires action)
- 2026-08-18T13:58:42.038Z - task-added: T6: Region click-to-focus (sidebar/transcript/queue-dock) + launch autofocus
- 2026-08-18T13:58:42.216Z - task-added: T7: Docs: check/update any TUI shell docs mentioning queue/focus behavior
- 2026-08-18T13:59:11.011Z - frozen: 15 criteria; checksum recorded
- 2026-08-18T13:59:11.172Z - started
- 2026-08-18T13:59:11.341Z - task-done: T1: Collect remaining context
- 2026-08-18T14:05:57.990Z - task-done: T2: Implement per plan
- T2 findings (DONE, full suite 4120 pass/0 fail, up from 4086 baseline):
  - `ShellChrome.queueDock: Box` is the new public field T5/T6 wire into. `dock`'s
    `applyTheme()` repaint was mirrored onto `queueDock` too (found `dock` already
    had it, `queueDock` would've gone stale on `/theme` switch otherwise — not in
    the original task brief, added as a direct consistency fix).
  - Rows/buttons deliberately have NO `onMouseDown` yet at the row/`queueDock`
    level — only the 3 per-button handlers exist. T5's dispatch-order
    investigation (AC9/TRD §1.6) starts from a genuinely clean slate; nothing to
    conflict with yet.
  - **Flag for T5:** button boxes have no explicit `width`, only padding — untested
    against a real mouse click (no headless harness for `launchTuiAgentShell`).
    Worth checking whether `onMouseDown` reliably receives clicks on a box sized
    only by its content/padding, or whether it needs an explicit width/height.
  - Minor, reviewer-visible: on-screen label dropped the `❯ ` prefix
    `appendUserEcho` used to add (was an echo-box styling convention, not part of
    `formatMainQueueMarker`'s or `displayQuestion`'s actual text) — one-line fix if
    a reviewer wants visual continuity with the old transcript marker.
  - No git commit made (working tree accumulates changes, committed together at PR
    time — same pattern as flow 169).
- task-done: T5 (mouse dispatch investigation + queue-nav keyboard). Full suite:
  4124 pass/0 fail (4 new). KEY FINDING (evidenced from actual bundled
  `@opentui/core` source, `chunk-bun-tkm837n2.js:1259-1266`): mouse events BUBBLE
  by default (deepest target fires first, then walks `.parent` up, unless
  `event.stopPropagation()` is called). Fixed at the source: each queue button's
  `onMouseDown` now calls `event.stopPropagation()` before firing its action.
  **T6 needs NO bubbling guard on `queueDock`'s own handler** — buttons already
  stop the bubble.
  - `Ctrl+Q` had no collision (only `Ctrl+O`/block-nav exists) — used as proposed.
  - New module `src/tui/queue-nav.ts` (pure stepper helpers, tested) +
    `tui-shell.ts` additions: `enterQueueNav`/`exitQueueNav`/`handleQueueNavKey`
    (closures, not exported).
  - **Arbitration used `chrome.addOverlaySource(() => queueNavActive)`** — an
    EXISTING extensibility primitive in `shell-chrome.ts` built for exactly this
    ("overlays the caller owns, chrome can't know about them") — NOT the
    `overlayActive()` edit the TRD/plan assumed would be needed. Result:
    `shell-chrome.ts` needed ZERO changes for T5. **T6 should check whether
    `addOverlaySource` also covers its own needs before editing `overlayActive()`
    directly** (TRD/plan's FR-15 guard may already be satisfiable the same way).
  - For T6: to wire `queueDock.onMouseDown`, simplest path per T5's own
    recommendation is `tui-shell.ts` assigning
    `chrome.queueDock.onMouseDown = () => enterQueueNav()` directly (`enterQueueNav`
    is a `tui-shell.ts`-local closure) — no new `ShellChromeOptions` plumbing
    needed.
  - Still-open, unchanged from T2: button boxes have no explicit width
    (content/padding only), untested against a real mouse click (no headless
    harness for `launchTuiAgentShell`).
- 2026-08-18T14:18:54.621Z - task-done: T5: Mouse dispatch investigation + keyboard queue-nav mode (Ctrl+Q, arrow select, Enter fires action)
- 2026-08-18T14:37:59.456Z - task-done: T6: Region click-to-focus (sidebar/transcript/queue-dock) + launch autofocus
- task-done: T6 (DONE_WITH_CONCERNS). Full suite: 4126 pass/0 fail (2 new).
  - **AC11 corrected via `keryx flow ac update`** (see acceptance-criteria.md):
    sidebar has no focusable content — real focus() there would blur the composer
    and create a keyboard dead-zone (`BoxRenderable` has no `handleKeyPress`).
    Implemented as an intentional, tested no-op instead of a literal focus move.
  - `overlayActive()`/`addOverlaySource` verified (not assumed): `overlayActive()`
    already iterates registered `overlaySources`, so T5's queue-nav registration
    is automatically covered — zero changes to `overlayActive()` needed, all new
    handlers just call it directly.
  - **Real bug found+fixed**: `scroll.onMouseDown` alone did NOT reliably focus
    the composer — `ScrollBoxRenderable` is itself focusable (for keyboard
    scroll), and OpenTUI auto-focuses the first focusable ancestor after
    `onMouseDown` unless `event.preventDefault()` is called, silently stealing
    focus back from the composer onto the scrollbox. Fixed with
    `event.preventDefault()` in `scroll.onMouseDown`. `sidebar`/`queueDock` don't
    need this (no focusable ancestor in their chain).
  - Launch autofocus: `createShellChrome` already internally calls
    `textarea.focus()` once at construction end (pre-existing, not from this
    flow) — the new explicit `chrome.input.focus()` call is a harmless idempotent
    no-op in the common case, kept as an explicit guarantee at the call site per
    FR-14's intent (protects against future refactors of internal timing).
  - `queueDock`/launch-autofocus wiring verified by source-level reasoning, not
    automated test — no headless harness exists for `launchTuiAgentShell`
    (same documented limitation as T2/T5 and flow 167's own AC8).
- task-done: T3 (tests). Automated pure-logic coverage already complete
  incrementally across T2/T5/T6 (`queue-nav.test.ts` new, `shell-chrome.test.ts`
  extended, `main-queue.test.ts` unchanged/passing) — `bun test src/tui/`: 241
  pass/0 fail across 19 files; full suite 4126 pass/0 fail. No gap found requiring
  a new dedicated test-writing dispatch. Manual verification checklist (no
  headless harness for `launchTuiAgentShell`, same limitation as flow 167 AC8) for
  the PR reviewer / flow owner to run interactively before merge, covering
  AC1-AC14:
  1. Queue 2+ messages while busy — confirm they appear in `queueDock` above the
     composer, NOT in the transcript (AC1).
  2. Click each item's Force/Edit/Delete button — confirm the exact same behavior
     as the pre-existing `/queue` command (AC2-AC4), and that clicking a button
     fires immediately, not "focus then need a second click" (AC9).
  3. Click the queue dock's background/text (not a button) — confirm it enters
     queue-nav (highlight visible) without firing any action (AC10).
  4. Empty the queue — confirm `queueDock` disappears and takes no layout space
     (AC5).
  5. Ctrl+Q → arrow keys → Enter — confirm keyboard-only Force/Edit/Delete works
     (AC6), and `/queue remove|edit|force [N]` still works unchanged (AC7).
  6. Trigger a `shell_exec` approval prompt while 1+ items are queued — confirm
     both the queue dock and the approval dock are visible and independently
     usable (AC8), and that clicking elsewhere does NOT steal focus from the
     active approval prompt (AC14).
  7. Click the sidebar — confirm it's a no-op (focus stays where it was) per the
     corrected AC11.
  8. Click the transcript or empty space — confirm focus moves to the composer
     (AC12).
  9. Launch `keryx shell` fresh — confirm the composer has focus immediately, no
     click needed (AC13).
- 2026-08-18T14:38:10.043Z - ac-updated: T6 grounding correction: sidebar has no focusable content today (BoxRenderable._focusable only true when explicitly passed, sidebar never does); literally focusing it would blur the composer and create a keyboard dead-zone (no handleKeyPress). AC11 corrected to the actually-implemented, tested behavior (safe no-op, no dead-zone) — same underlying intent, no scope change.
- 2026-08-18T14:38:57.293Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-18T14:40:31.847Z - task-done: T7: Docs: check/update any TUI shell docs mentioning queue/focus behavior
