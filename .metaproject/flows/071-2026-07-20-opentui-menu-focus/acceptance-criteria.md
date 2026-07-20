# Acceptance Criteria — flow 071 (OpenTUI /-menu focus nav)

- AC1: With the `/` dropdown open, the first ↑/↓ TRANSFERS focus to the menu (a `menuNav` flag + `menu.focus()`); afterwards the native SelectRenderable handles ↑/↓/Enter. A `menu.on(ITEM_SELECTED)` handler runs the highlighted command and returns focus to the composer. This fixes Enter submitting a raw `/` (the earlier manual key-routing did not work on a real terminal).
- AC2: Esc closes the dropdown and refocuses the composer; typing (without an arrow) keeps composer focus and filters live; hiding the menu resets `menuNav`.
- AC3: A submitted slash command is echoed (`❯ /help`) so it is clear which command ran. The composer is a compact single line (the flow-070 vertical padding is removed).
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507). No new dependency; `runAgentTurn`, readline, chat, `roleLabel` unchanged; flow-067..070 preserved. NOTE: keyboard behavior validated by the user on a real terminal.
