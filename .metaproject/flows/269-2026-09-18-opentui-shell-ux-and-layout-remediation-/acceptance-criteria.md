# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: ModalHost renders an opaque backdrop filling its bounding box so columns 1–4 from underlying transcript text do not bleed through.
- AC2: ModalHost bounds dialog width strictly within main pane width, preventing right border collision with the sidebar separator.
- AC3: The `/model` picker mounts inside ModalHost preserving shell header, sidebar, and status bar, with functional filter and arrow navigation.
- AC4: The `/sessions` picker mounts inside ModalHost preserving shell chrome, with single non-duplicated footer instructions.
- AC5: Submitting text in the composer automatically scrolls transcript viewport to the bottom and sets stickyScroll to true.
- AC6: Exiting block navigation mode (Ctrl+O -> Esc) does not force scrollTop back to savedScrollTop when user intentionally scrolled down.
- AC7: Modals compute adaptive height based on content rows plus padding, capped at 85% of terminal height.
- AC8: Empty /review modal renders a compact dialog and hides action hotkeys (a, d, y, arm) from footer hints.
- AC9: Multi-line command descriptions in /help render with hanging indentation matching the description column.
- AC10: All tests in bun test src/tui pass with zero regressions and new test coverage for modal isolation, scroll follow, and picker mounting.
