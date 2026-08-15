# Keryx OpenTUI Modal and Tabs — PRD
Version: 0.1.0

## Problem

Grok Build's TUI opens most operator surfaces as **one reusable modal** with
tabs. `/hooks`, `/plugins`, `/marketplace`, and `/skills` are the same
extensions modal, just a different starting tab. `/session-info` is a tabbed
inspector. `/model` and `/settings` are the same overlay class.

Keryx's TUI has no such host. Overlays are one-off full-screen `overlayBox`
trees (`selectProviderModelInTui`, approval dock, wiki-enrich picker). Each
new surface copies backdrop, Esc, and `overlayActive` wiring. There is no
tab strip, so a session inspector and a model picker cannot share chrome.

## Goal

Ship a reusable OpenTUI **modal host + tab strip** that:

1. Owns presentation (backdrop, title, tabs, focus trap, Esc, overlay guard).
2. Does **not** own feature content — callers mount a body per tab.
3. Is the required substrate for `/session-info` and a later model picker.

## Users

- Operator in `keryx shell` (TTY OpenTUI): opens inspect/pick surfaces
  without losing the transcript underneath.
- Implementer of a slash command: mounts a tabbed body instead of a new
  full-screen overlay.
- Test author: drives the host through a headless OpenTUI renderer.

## Requirements

| ID | Requirement |
|---|---|
| MT-1 | A modal is a centered (or max-width) panel over a dimmed backdrop. It does not replace the transcript tree; the shell remains mounted. |
| MT-2 | Opening a modal registers with `shell-chrome` `overlayActive` / `withOverlay` so the `/`-menu router, composer submit, and Ctrl+O block-nav stay inert. |
| MT-3 | `Esc` (and an explicit Close control if rendered) dismisses the modal, restores composer focus, and unregisters the overlay source. Nested pickers inside a tab may steal Esc first (same steal-Esc order as Grok). |
| MT-4 | A modal may declare an ordered list of tabs `{ id, label }`. Opening may set `initialTab`. Only one tab's body is mounted at a time. |
| MT-5 | Tab change is `←` / `→` (and `Tab` / `Shift+Tab` when focus is on the strip). Optional `1`…`9` jump to the nth tab when the body is not capturing digits. |
| MT-6 | A command may open the **same** host on a different initial tab (Grok: `/hooks` vs `/plugins`). Switching tabs does not close the modal. |
| MT-7 | The host API is presentation-only: `openModal({ title, tabs, initialTab, renderTab })`. Feature data fetching lives in the caller. |
| MT-8 | Zero top-level `@opentui/core` import (same capability gate as `launchTuiAgentShell`). Missing OpenTUI → the host is not offered; readline is unchanged. |
| MT-9 | Headless tests cover open, initial tab, tab change, Esc dismiss, overlay-guard true-while-open, and focus restore. |

## Success criteria

- Two independent callers (session-info in the sibling package; a fixture /
  stub second tab or a documented model-picker adapter) can open the same
  host with different titles, tab lists, and bodies.
- While the modal is open, typing `/` does not reopen the slash menu.
- Esc from the top of the modal returns to the composer with the draft
  preserved.
- No new production npm dependency.

## Risks

- Copying Grok's mouse/drag selection into the host would over-scope v1;
  keep keyboard-first.
- A full-screen `overlayBox` is easier than a true modal; the host must not
  become another full-screen picker in disguise (panel + backdrop, not
  100% replacement of chrome).
- Tab bodies that open nested pickers can deadlock focus if they do not
  participate in steal-Esc. Document the nesting contract.
- Migrating `/model` in this package would block session-info; migration is
  a later consumer, not a v1 requirement.

## Recommendation

Implement the host first, behind no user-facing slash command except a
dev/test harness if needed. Do not ship `/session-info` until this package
is accepted. Keep `selectProviderModelInTui` as-is until a follow-up flow
remounts it inside the host.
