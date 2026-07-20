# Acceptance Criteria — flow 079 (toasts)

- AC1: A transient toast area is pinned to the BOTTOM of the sidebar (a flexGrow spacer pushes it down). `showToast(msg)` renders `✓ <msg>` (green, English) and clears it after 5 seconds; a new toast resets the timer (replaces the old one).
- AC2: Copy-on-select shows `✓ Copied to clipboard` via the toast after a successful OSC52 copy.
- AC3: The OpenRouter key prompt is transparent — a note explains the key is used for this session and NOT saved to disk (get one at openrouter.ai/keys). `runAgentTurn`, readline, chat, `roleLabel` unchanged; flow-067..078 preserved.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1511). No new dependency. NOTE: the toast + copy are validated by the user on a real terminal.
