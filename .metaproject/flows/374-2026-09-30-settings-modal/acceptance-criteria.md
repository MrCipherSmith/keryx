# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/tui/settings-model.ts` builds the settings rows from a plain state snapshot with no I/O; a unit test covers every row, its group, its value text and its scope label (session, saved, restart).
- AC2: in the TUI, `/settings` opens a modal in the `/connect` style listing the rows by group with On/Off buttons (or value buttons for multi-value settings); arrow keys move between rows and buttons, Enter activates, Escape closes (modal test with `@opentui/core/testing`).
- AC3: each button runs the existing handler of its slash command (`/mode`, `/plan`, `/reasoning`, `/theme`, `/think`, `/guard`, `/route`, `/external`, `/editguard`, `/external-agents`); no settings logic is duplicated, and after every action the row shows the new value (test).
- AC4: selecting `auto` for permission mode needs a second Enter to confirm, like Disconnect in `/connect`; a single keypress never reaches `auto` (test).
- AC5: `/mode` and `/plan` rows are labelled session and write nothing to disk; persisted rows are labelled saved; a setting overridden by project or environment, or restart-only, shows its effective value and scope.
- AC6: in the readline shell `/settings` prints a table of the same rows and values from the same model (test).
- AC7: `/settings` is in the slash command registry, the help groups and the composer menu, and the sidebar points at it (test).
- AC8: README or docs site, `commands-by-task` and CHANGELOG describe `/settings`; version bumped to 0.3.46 (0.3.45 was taken by another release on main).
- AC9: live smoke with the installed release: open the TUI in a scratch project, run `/settings`, toggle plan and think display, observe the rows change; the keryx repo working tree gains no generated files.
