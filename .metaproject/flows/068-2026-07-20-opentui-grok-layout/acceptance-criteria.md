# Acceptance Criteria — flow 068 (grok-style TUI layout)

- AC1: The OpenTUI agent shell has a grok-style layout: a header bar (`keryx · agent · provider/model` left, a cumulative token counter right), the scrollable transcript, the `/` dropdown, a BORDERED rounded composer (input inside a `borderStyle:"rounded"` box), and a dim footer hint line — using OpenTUI flexbox (justifyContent/padding/border).
- AC2: Token usage accumulates into the header counter (`↑<in> ↓<out>`, compact K via a pure `fmtTokens`) instead of per-turn transcript lines. User messages render inside a rounded bordered box.
- AC3: `runAgentTurn`, the readline shell, chat mode, and `roleLabel` are unchanged; the flow-067 clean-terminal launch + in-TUI picker + `/` dropdown + approval + scroll are preserved. `--tui` opt-in; default readline.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1506); a `fmtTokens` unit test passes. No new dependency. NOTE: the real-terminal look is validated by the user via `--tui`.
