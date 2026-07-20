# Acceptance Criteria — flow 075 (layout shrink fix)

- AC1: When the transcript fills the height and a scrollbar appears, the composer (input line) NO LONGER breaks/collapses. The fixed chrome (header, menu, composer, footer) has `flexShrink: 0` so it keeps its natural height; the ScrollBox has `minHeight: 0` so it clips/scrolls its overflow instead of pushing the chrome.
- AC2: The main column has `minWidth: 0` and the sidebar `flexShrink: 0`, so the row layout (main + sidebar) sizes correctly (main shrinks, sidebar keeps its fixed width) — the sidebar renders reliably.
- AC3: `runAgentTurn`, the readline shell, chat mode, and `roleLabel` are unchanged; flow-067..074 behavior preserved; `--tui` opt-in.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507). No new dependency. NOTE: the layout is validated by the user on a real terminal (fill the height + scroll).
