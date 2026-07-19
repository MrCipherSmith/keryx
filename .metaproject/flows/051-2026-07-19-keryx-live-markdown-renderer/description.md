# Flow 051 — agent live-markdown differential renderer

## Problem
Flow 050 renders agent-mode markdown once per round (buffered under the spinner)
to avoid the fragile cursor-up math that broke the flow-048 status bar. The
trade-off: no live per-token streaming. The Pi coding agent
(mariozechner.at/posts/2025-11-30-pi-coding-agent) shows the robust way to have
BOTH: a line-based, scrollback-preserving DIFFERENTIAL renderer — re-render the
block, diff against the previous paint, reposition the cursor, reprint the tail —
wrapped in synchronized-output escapes (`CSI ?2026h/l`) to avoid flicker.

## Approach
- PURE core `src/lib/live-render.ts`: width measurement (ANSI-stripped,
  wide-char aware), physical-row accounting (wrap-aware), and `computeRepaint`
  that emits the control string (cursor-up + `ESC[0J` clear + new lines, optional
  synchronized-output wrap). Deterministic, no IO — heavily unit-tested.
- `LiveMarkdownBlock`: stateful controller over injected `out`/`cols`/`render`;
  `append`/`flush`/`finalize`. Width-change mid-stream degrades to a fresh block
  (newline break) rather than a wrong cursor-up. NO SIGWINCH handler (flow-048).
- `runAgentRepl` wiring: live block when TTY+color; else the proven flow-050
  fallback verbatim. Repaints coalesced on a ~50ms timer. Driver untouched.

## Out of scope
Full retained-mode component tree (Pi's whole UI framework), chat-mode changes,
per-line minimal diffing (a whole-block repaint with correct physical-row
accounting + synchronized output is sufficient and simpler), Unicode grapheme
clustering beyond a best-effort wide-char table.
