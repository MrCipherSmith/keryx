# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `/session-info`, `/status`, and `/info` appear in agent and chat slash menus and are handled without calling `provider.stream`.
- AC2: TUI open calls `openModal` from the shared host package; there is no new full-screen `overlayBox` inspector.
- AC3: Session tab shows id, project path, and provider/model matching the live session (including after a `/model` change).
- AC4: Forked sessions show a Parent row; non-forks omit it.
- AC5: `c` copies `summary.id`; `y` copies a multi-line block that includes that id.
- AC6: Readline/`--no-tui` prints the same rows without opening OpenTUI.
- AC7: Invoking the command mid-turn does not cancel the turn and does not queue a user message.
- AC8: When context tokens are estimated, the UI labels them as an estimate.
