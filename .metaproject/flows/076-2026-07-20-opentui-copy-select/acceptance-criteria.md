# Acceptance Criteria — flow 076 (copy-on-select)

- AC1: The OpenTUI shell enables mouse (`useMouse: true`) so OpenTUI tracks drag-selection (the alternate screen otherwise disables the terminal's native selection).
- AC2: On a selection change (`CliRenderEvents.SELECTION`), the selected text (`renderer.getSelection()?.getSelectedText()`) is copied to the SYSTEM clipboard via `copyToClipboardOSC52` — copy-on-select, matching grok/opencode; works locally and over SSH. Best-effort: failures (clipboard access denied) are ignored.
- AC3: `runAgentTurn`, the readline shell, chat mode, and `roleLabel` are unchanged; flow-067..075 behavior preserved; `--tui` opt-in.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1507). No new dependency. NOTE: validated by the user on a real terminal (select text with the mouse → paste elsewhere). The terminal must permit clipboard access (e.g. iTerm2 setting).
