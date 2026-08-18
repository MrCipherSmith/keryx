# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Context already complete via PRD/TRD — no context-collector dispatch needed; verify nothing new surfaced since 2026-08-18 before closing. |
| T2 | implement | `queueDock` Box construction (mirrors `dock`, `shell-chrome.ts`) inserted between transcript and `dock`; retarget `paintMainQueue()` from `transcript` to `chrome.queueDock`; per-item row gains Force/Edit/Delete `BoxRenderable` buttons wired to unchanged `forceMainQueue`/`editMainQueue`/`removeMainQueue`. Plan steps 1-2. |
| T5 | implement | Investigate OpenTUI's nested `onMouseDown` dispatch/bubbling behavior (real risk, don't assume); keyboard queue-nav mode (`Ctrl+Q` entry — verify no key collision first, ↑↓ select item, ←→ select action, Enter fires, Esc exits); extend `overlayActive()` for queue-nav. Plan steps 3-4. |
| T6 | implement | Region click-to-focus: `sidebar`/`scroll`(transcript)/`queueDock` `onMouseDown` handlers, each guarded by `overlayActive()` (FR-15); one `chrome.input.focus()` call at launch, right after `createShellChrome()` resolves. Plan steps 5-6. |
| T3 | test | Unit tests for any new pure helpers; manual/interactive verification script per PRD §11 (no headless harness exists for `launchTuiAgentShell`) covering: queue UI mouse+keyboard, transcript-cleanliness, choice-dock coexistence, launch autofocus, each region's click-to-focus, overlay-active guard not stolen from. Plan step 7. |
| T7 | docs | Check/update any TUI shell docs that describe queue/focus behavior (light-touch, matching prior flows). Plan step 8. |
| T4 | review | Self-review + code-verifier + review-orchestrator + prepare PR. |
