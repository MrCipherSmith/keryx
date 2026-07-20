# Acceptance Criteria — flow 069 (OpenTUI full-screen)

- AC1: The OpenTUI agent shell uses `screenMode: "alternate-screen"` (+ `clearOnShutdown`) so it owns the alternate screen buffer: the prior shell scrollback (install/git output) is cleared on launch and the terminal is restored on exit — like grok/opencode. This replaces `split-footer`, which left the launch output on screen and floated the composer mid-screen.
- AC2: The layout fills the terminal: header bar top, transcript (flexGrow) fills, composer + footer anchored to the bottom.
- AC3: `runAgentTurn`, the readline shell, chat mode, and `roleLabel` unchanged; the flow-067 clean launch + in-TUI picker + `/` dropdown + approval + scroll + flow-068 layout preserved. `--tui` opt-in; default readline.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507); headless tests unaffected (they use `createTestRenderer`). No new dependency. NOTE: the full-screen look is validated by the user via `--tui`.
