# Acceptance Criteria — flow 073 (OpenTUI UX refinement)

- AC1: Reasoning is COLLAPSED — `onReasoning` renders a one-line dim `◆ thought (N lines)` marker instead of dumping the full chain-of-thought (grok/opencode style; declutters the screen).
- AC2: Each turn shows a dim `worked for Xs` timing line after the answer (timed in the TUI wrapper via Date.now — the deterministic core is untouched).
- AC3: The palette is muted: the user-message box uses a muted border and dim text (was bright cyan). The footer is a row with hints on the left and `provider/model` on the right (grok/opencode-style status).
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507). No new dependency; `runAgentTurn`, readline, chat, `roleLabel` unchanged; flow-067..072 preserved. NOTE: the look is validated by the user on a real terminal.
