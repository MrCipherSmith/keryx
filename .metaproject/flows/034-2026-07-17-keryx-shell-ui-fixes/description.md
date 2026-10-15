# Flow 034 — keryx shell UI fixes

Status: formalized
Source: user feedback on the flow-031/032 shell UI (screenshots): a large empty
block appears between the header and the first prompt, and the layout wants more
breathing room.

## Problem

`shellCommand` prints the header (`printHeader`) and THEN enters the status-bar
scroll region (`enterBar`). `scrollRegion(rows).enter` ends with `CSI {rows-1};1H`,
which jumps the cursor to the bottom row after the region is set. The header stays
at the top while the prompt/input lands near the bottom, leaving a big blank gap
between them (visible in the user's terminal). The layout is also cramped.

## Expected Outcome

1. **No header/prompt gap** — `scrollRegion(rows).enter` sets the DECSTBM region
   `1..rows-1` WITHOUT forcing the cursor to the bottom row; it preserves the
   current cursor position (DECSC/DECRC save/restore around the region set) so the
   prompt flows directly below the header and content grows downward toward the
   pinned bar.
2. **Breathing room** — a blank line of vertical padding in the header so the
   shell reads less cramped.
3. **No behavior/regression change** — chat and agent modes otherwise unchanged;
   status bar still pins to the bottom and restores cleanly on exit.

## Out of Scope

- No new dependency; no full-screen TUI; no change to tool/agent logic.
