# Flow 050 — agent-mode UI polish

## Problem
Agent mode (`keryx shell --agent`) streams the model's raw markdown (users see
literal `**bold**`, `-` bullets, backtick code), roles/turns are plain, there is
no token/cost feedback (relevant for the metered OpenRouter budget), and tool
calls dump the raw JSON input. The user asked to "проработать UI" and selected:
markdown rendering, role/turn styling, a token counter, and tool-call styling.

## Approach
Small, robust, no cursor math (flow 048 removed the scroll-region status bar
because it fought node:readline — do not reintroduce that class of bug).

- **Markdown**: add `onAssistantText(text)` to `AgentIO`; the driver calls it once
  per round after finalizing the assistant text. The rich REPL buffers streamed
  tokens under the existing "thinking…" spinner and prints `renderMarkdown(text)`
  once per round. Trade-off: no token-by-token live paint, but correct markdown
  and zero fragile in-place re-render.
- **Token counter**: add `onUsage(usage)`; the driver forwards `usage_update`
  events; the REPL prints a dim `↑in ↓out tokens` line per turn when reported.
- **Role/turn styling**: styled assistant header (`● assistant`) + dim separator,
  done in the REPL wrapper (NOT in the test-locked `roleLabel`).
- **Tool styling**: pure `summarizeToolArgs(input)` in `ui.ts` renders compact
  `k=v` args; the REPL shows `⚙ name(args)`.

## Out of scope
Live streamed markdown (would need cursor math), chat-mode changes, cost pricing
tables (only raw token counts).
