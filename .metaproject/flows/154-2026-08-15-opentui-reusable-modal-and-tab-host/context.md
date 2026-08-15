# Context

## Requirements (source of truth)

- `docs/requirements/keryx-opentui-modal-tabs/README.md`
- `docs/requirements/keryx-opentui-modal-tabs/prd.md` (MT-1…MT-9, AC-1…AC-6)
- `docs/requirements/keryx-opentui-modal-tabs/specification.md`

## Existing TUI

- `src/tui/shell-chrome.ts` — `overlayActive`, `withOverlay`, `addOverlaySource`
- `src/tui/tui-shell.ts` — `overlayBox` (full-screen; do not reuse as the host)
- `src/tui/composer-choice.ts` — SelectRenderable overlay
- `src/tui/shell-chrome.test.ts` — overlay suppresses `/`-menu
- Wiki: `.metaproject/wiki/components/src-tui.md`

## Grok reference (pattern only)

Extensions modal: `/hooks|/plugins|/marketplace|/skills` share one host,
different `initialTab`. Steal-Esc. Not Grok source — user-guide only.

## Constraints

- Zero top-level `@opentui/core` import.
- Isolation worktree; branch `feat/tui-modal-tabs`.
- Draft PR required to close the flow.

## T1 findings (verified in this worktree)

- Overlay guard: `overlayDepth` / `dock.visible` / `addOverlaySource` predicates. Menu key router returns immediately when `overlayActive()`.
- `withOverlay` is for async runs; modal lifetime should register `addOverlaySource(() => hostOpen)`.
- `overlayBox` is `position:absolute; width/height 100%` with opaque `#0a1414` — do not reuse.
- Headless: `createTestRenderer`, `captureCharFrame`, `mockInput.pressEscape` (wait 20ms for Esc parser), `pressArrow`, `pressTab`.
- `findDescendantById` / `getChildren` exist on renderables. Box supports `opacity`, `title`, `maxWidth`.
- `alignSelf` is banned in `src/tui/**` runtime sources (`tui-layout.test.ts`).
- No `/session-info` in `src/commands` today; do not add one.
