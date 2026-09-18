# OpenTUI shell UX and layout remediation: modal bleed, pickers, scroll and typography

Status: ready
Source: live PTY / tmux review & PRD (docs/requirements/keryx-tui-ux-remediation/)

## Problem

Live testing of `keryx shell` in tmux (120x40 PTY) surfaced multiple visual, interaction, and ergonomic defects:
1. **Modal background bleed-through:** Opening modals (`/status`, `/theme`, `/flows`, `/review`) fails to clear the background in columns 1–4, causing previous transcript text and composer box borders to show through the dialog boundaries.
2. **Destructive pickers (`/model`, `/sessions`):** Invoking `/model` or `/sessions` destroys `ShellChrome` (header, sidebar, status) and dumps unstyled text with 30+ blank lines, giving the impression of an unhandled shell crash.
3. **Scroll offset trap & invisible stream:** When scrolled up (e.g. after `/help`), submitting a prompt leaves the viewport frozen at the top. New messages stream off-screen with no auto-scroll and no "new output" indicator. Exiting block navigation (`Ctrl+O` -> `Esc`) unconditionally resets `scrollTop = savedScrollTop`, throwing the user back to the top.
4. **Massive empty modals & confusing shortcuts:** Modals maintain ~85% height even when empty (e.g. `/review` with 0 items, `/status` Context tab with 0 tokens). In `/review`, inactive hotkeys (`a d accept/decline`, `arm -> confirm`) remain visible.
5. **Jagged text wrapping:** In narrow viewports, sidebar versions (`0.2.114 → 0.\n2.115`) and MCP tables wrap awkwardly without table alignment, and `/help` descriptions lack hanging indents.

## Expected Outcome

1. All modals render with an opaque, solid backdrop strictly bounded within `chrome.main.width`, with zero column 1–4 bleed-through and no sidebar divider collision.
2. `/model` and `/sessions` mount cleanly inside `ModalHost`, preserving shell chrome.
3. Submitting input scrolls to bottom and re-enables sticky scroll; exiting block nav preserves user scroll position.
4. Modals scale height adaptively to content; empty states render compactly and hide inactive action shortcuts.
5. Command listings display clean hanging indentation and tabular text truncates safely with ellipsis.
6. All automated tests in `src/tui/` pass with new regression coverage.

## Out of Scope

- Modifying the upstream `@opentui/core` C/Zig binaries or adding new npm dependencies.
- Mouse-first navigation (retains keyboard-first OpenTUI interaction).
- Changes to the readline fallback mode (`--no-tui`).
