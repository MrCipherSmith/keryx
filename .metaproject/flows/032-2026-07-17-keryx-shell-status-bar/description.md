# Flow 032 — keryx shell persistent status bar

Status: formalized
Source: user request (compare vs grok/opencode TUI: "почему keryx не умеет
показать в какой он папке"). Follow-on to flow 031 (rich-inline rendering);
stacked on branch `feature/031-keryx-shell-rich-inline-ui`. Approved approach
(user): **hand-rolled ANSI scroll-region — no new dependencies**
(`dependencies` stays `{}`); NOT a full-screen TUI framework (Ink/OpenTUI).

## Problem

The `keryx` shell shows no persistent context: unlike grok/opencode — which pin a
status bar with the working directory, provider/model, and key hints — keryx never
displays its cwd (it *knows* `process.cwd()`; it just doesn't render it). A one-off
header line scrolls away after the first turn, so there is no always-visible
anchor telling the user where they are and what they're talking to.

## Expected Outcome

The rich TTY shell (flow 031) pins a one-line status bar to the BOTTOM of the
terminal that stays visible while chat output scrolls above it:

1. **Pinned bottom bar** — using an ANSI scroll-region (DECSTBM `ESC[<top>;<bottom>r`)
   the shell reserves the last terminal row; normal streamed output scrolls only
   in the rows above it, and the bar is redrawn in the reserved row. Content shown:
   the working directory (`$HOME`→`~` collapsed, middle-truncated to width),
   `provider/model`, and a short key/`/help` hint.
2. **Live + robust** — the bar reflects the CURRENT provider/model (updates after
   `/model` / `/provider` switches) and the current terminal size (redraws on
   `SIGWINCH`). On exit — normal `/exit`, EOF, `SIGINT`, or an error — the shell
   ALWAYS restores the full scroll region and cursor so the terminal is never left
   in a broken state (try/finally + signal cleanup).
3. **Safe degradation** — the status bar and all scroll-region control are active
   ONLY for an interactive TTY with color enabled; under `NO_COLOR`, a non-TTY
   sink, or when the terminal is too short, the shell falls back to the plain
   flow-031 behavior with NO scroll-region escapes emitted.

## Out of Scope

- **No full-screen TUI framework / no new dependency** — `dependencies` REMAINS
  `{}`; hand-rolled ANSI only (no Ink/OpenTUI/blessed).
- **No multi-pane / mouse / alt-screen app** — a single pinned status line only,
  not a scrollback pane, side panel, or mouse handling.
- **No change to the flow-031 `runShell` core semantics or its ShellIO hooks** —
  the status bar is built in the TTY wrapper on top of the existing hooks; the
  deterministic core stays untouched.
- Token-usage accounting in the bar is best-effort/deferred if the provider
  stream does not already surface usage; the bar must not fabricate numbers.
- Frozen requirements package, canonical schemas, ADRs, `src/eval/`,
  `src/contracts/` — read/cite only.
