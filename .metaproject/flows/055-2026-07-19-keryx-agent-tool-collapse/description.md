# Flow 055 — collapsible tool output

## Problem
Tool results in agent mode show only a one-line summary (`↳ …`) with no signal
that output was truncated and no way to see the rest. Other terminal agents
render tool output as collapsible panels. Line-based equivalent: collapsed
summary with a hidden-line count + an `/expand` command to reveal the full last
output (no alt-screen, no interactive toggle — readline-safe).

## Approach
- Pure `collapseToolOutput(text, maxWidth)` in ui.ts (summary/lineCount/hidden).
- REPL retains the last tool call's full output + name; `onToolResult` renders
  the collapsed line with a `+N more (/expand)` affordance; `/expand` reprints
  the full output (gutter-indented, dim). `/help` documents it.

## Out of scope
Per-call scrollback of ALL tool calls (only the last is retained), interactive
click-to-toggle (needs a full-screen TUI), reasoning section (flow 056).
