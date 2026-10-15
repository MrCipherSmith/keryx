# Flow 054 — agent-mode left gutter padding

## Problem
Agent-mode content is flush against column 0 (see screenshot) — cramped vs.
codex/claude, which indent the whole conversation with a small left
gutter. User asked to "добавить падингов". Design goal: a
consistent left gutter + breathing room.

## Approach
- Pure `indentBlock(text, pad)` in ui.ts (prefix non-empty lines).
- 2-space gutter applied across agent-mode chrome: header, prompt, assistant
  header, tool lines, usage, separator, system/approval, and the markdown body
  (via LiveMarkdownBlock's `render` and the fallback render). Padded lines flow
  through the flow-051 differential renderer unchanged (physicalRows counts them).

## Out of scope
Chat-mode body indentation (chat streams raw tokens without the differential
renderer — indenting mid-stream is the flow-051 problem; header/prompt still
share the gutter), collapsible tool panels, theme/padding config.
