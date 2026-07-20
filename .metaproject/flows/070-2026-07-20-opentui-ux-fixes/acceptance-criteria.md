# Acceptance Criteria — flow 070 (OpenTUI UX fixes)

- AC1: The in-TUI model picker shows model names — the model SelectRenderable sets `showDescription: false` (the default `true` reserved an empty 2nd line per item and hid the name) and a sensible height.
- AC2: The `/` command dropdown is keyboard-navigable from the composer: a GLOBAL internal key handler (`_internalKeyInput.onInternal("keypress", …)`, which runs before the focused Input) routes ↑/↓ to `menu.moveUp/moveDown`, Enter to run the highlighted command, Esc to close — each `preventDefault()`+`stopPropagation()` so the Input cursor does not also move / submit. Typing still filters (unhandled keys pass through).
- AC3: The bordered composer is taller (vertical padding). `runAgentTurn`, the readline shell, chat mode, and `roleLabel` are unchanged; flow-067/068/069 behavior preserved; `--tui` opt-in.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507). No new dependency. NOTE: keyboard nav + look validated by the user on a real terminal.
