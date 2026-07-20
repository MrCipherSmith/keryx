# Acceptance Criteria — flow 072 (OpenTUI /-menu auto-focus + style)

- AC1: The `/` dropdown is FOCUSED the moment it opens (`refilter` calls `menu.focus()` + sets `menuNav`), so ↑/↓/Enter drive it immediately — no first-arrow-to-focus step.
- AC2: Typing still filters while the menu is focused: printable single characters and Backspace are re-routed (via `_internalKeyInput.onInternal`) into the composer value and re-filter live; Esc closes and returns focus to the composer; selecting (ITEM_SELECTED) runs the command and refocuses the composer.
- AC3: The dropdown is restyled toward grok: explicit colors (dark bg, subtle selected bg, accent selected text, dim descriptions), a scroll indicator, wrap-around selection, and a taller height.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507). No new dependency; `runAgentTurn`, readline, chat, `roleLabel` unchanged; flow-067..071 preserved. NOTE: keyboard + look validated by the user on a real terminal.
