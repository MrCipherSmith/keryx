# Implementation Plan

Status: formalized

## Approach

**Hand-rolled ANSI scroll-region** (user-chosen over a full TUI framework). Reserve
the terminal's last row via DECSTBM so streamed output scrolls above a pinned
status line — no new dependency, and the deterministic flow-031 core is untouched.

Keep the terminal logic behind PURE, unit-testable string builders and confine the
stateful terminal wiring (region setup, signal handlers, redraw) to the
not-unit-tested wrapper, mirroring flow 031's split.

### Rejected alternatives
- **Ink / OpenTUI full-screen TUI** — closest to grok but pulls a framework into
  `dependencies` and rewrites the shell's whole IO; rejected (revisits the frozen
  no-deps posture).
- **One-off header line only** — scrolls away; does not meet "always visible".

## Steps

1. **Pure helpers (`src/lib/statusbar.ts` + test):**
   - `formatStatusBar({ cwd, provider, model, columns })` → the styled bar string:
     `$HOME`→`~` collapse, middle-truncate the cwd to fit `columns`, join
     `cwd · provider/model · /help`. Plain (no ANSI) when color disabled.
   - `scrollRegion(rows)` → `{ enter, drawAt(row, text), exit }` CSI builders
     (DECSTBM set/reset, save/restore cursor, clear line). Pure `→ string`.
2. **Wire into the flow-031 wrapper (`shellCommand`/`createRichIo`):** when
   `colorEnabled() && stdout.isTTY && rows >= MIN_ROWS`, enter the scroll-region,
   draw the bar, and redraw it after each turn and on provider/model switch. Read
   the live provider/model (thread current selection to the bar).
3. **Robust lifecycle:** redraw on `SIGWINCH` (recompute rows/cols); on `/exit`,
   EOF, `SIGINT`, and the wrapper's `finally`, reset the region (`ESC[r`), restore
   the cursor, and remove the listeners — the terminal is never left broken.
4. **Tests:** unit-test `formatStatusBar` (home-collapse, truncation, NO_COLOR
   plain) and `scrollRegion` (correct CSI codes; reset present). The terminal
   wiring/signals stay not-unit-tested (manual smoke).
5. **Self-review + manual live smoke** in a real TTY (bar pinned while streaming,
   survives resize, terminal restored on exit); record in the journal; stacked
   draft PR onto flow 031.

## Risks

- **Terminal left broken if cleanup is skipped** — mitigate with try/finally +
  `SIGINT`/`exit` handlers that always reset the region and show the cursor;
  never enable the region unless it can be reset on every exit path.
- **Resize races (SIGWINCH)** — debounce/recompute rows on each event and redraw
  idempotently; clamp to a minimum height (disable the bar below it).
- **Readline echo vs reserved row** — input happens inside the scroll region;
  verify the prompt/echo never write into the reserved row.
