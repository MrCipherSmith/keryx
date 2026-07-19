# Acceptance Criteria — flow 054 (agent-mode left gutter padding)

- AC1: Agent-mode output has a consistent 2-space left gutter (OpenCode/codex-style): the launch header lines, the prompt, the `● keryx` assistant header, streamed markdown body (every rendered line), tool-call/result lines, the usage line, the turn separator, and system/error + approval lines all start at column 2, not column 0.
- AC2: The gutter is applied through the LiveMarkdownBlock `render` function (each rendered line prefixed), so the differential renderer's physical-row/repaint math stays correct (padded lines counted by `physicalRows`); empty lines are NOT padded (no trailing whitespace). The non-TTY/NO_COLOR fallback path is also padded and stays escape-free.
- AC3: A pure, unit-tested `indentBlock(text, pad)` helper (in `src/lib/ui.ts`) prefixes every non-empty line with `pad` and leaves empty lines untouched. Used by both the live and fallback render paths.
- AC4: `bunx tsc --noEmit` clean; `bun test` green with no reduction from baseline (1478 pass); new `indentBlock` unit tests pass. No new runtime dependency; chat-core semantics and `roleLabel` untouched.
