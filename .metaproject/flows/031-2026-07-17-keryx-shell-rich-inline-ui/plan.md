# Implementation Plan

Status: formalized

## Approach

**Rich-inline rendering via a small additive IO seam + hand-rolled ANSI**
(user-chosen: rich-inline altitude, hand-rolled ANSI, route through a flow).

The `runShell` core already isolates all IO behind `ShellIO = { lines, write }`.
The blocker to a rich UI is that `write` carries a *mixed* stream (assistant
tokens + system text) with no turn boundaries. We resolve this with the smallest
principled change: extend `ShellIO` with three OPTIONAL hooks and route the
core's existing writes through them, preserving byte-identical behavior when the
hooks are absent. The visual work then lives entirely in the (untested-by-policy)
TTY wrapper plus a PURE, unit-tested `renderMarkdown` in `src/lib/ui.ts`.

### Rejected alternatives
- **Ink / OpenTUI full-screen TUI** — introduces React/framework deps; violates
  flow-022's frozen `dependencies == {}` posture and is a bigger, riskier lift.
  Deferred as a separate future decision.
- **Zero core change (style inside `write` only)** — a single `write` sink cannot
  reliably distinguish tokens from system text or detect turn boundaries, so no
  spinner and no post-turn markdown re-render. Rejected as not achievable cleanly.

## Steps

1. **Seam (core, additive):** add `onTurnStart?()`, `onTurnEnd?(full)`,
   `onSystem?(text)` to `ShellIO`. In `runShell`, call `onTurnStart` before the
   stream loop, `onTurnEnd(accumulated)` after a turn with content, and route
   error/help/connect/unknown/"not available" writes through a
   `system(t) = io.onSystem?.(t) ?? io.write(t)` helper. Token deltas keep going
   through `io.write`. No change to history/turn/selection semantics.
2. **Renderer (pure, `src/lib/ui.ts`):** `renderMarkdown(md): string` (headings,
   bold, inline code, fenced code blocks, bullet lists) + a `roleLabel(role)`
   helper, all on the existing `style`/`symbols`/`colorEnabled()`.
3. **Rich wrapper (`shellCommand`):** styled header (reuse `banner`), colored
   prompt + role marker, spinner on `onTurnStart` (timer lives ONLY here — core
   determinism untouched) clearing on first token, live raw streaming, markdown
   re-render on `onTurnEnd`, styled `onSystem` (red errors / dim notices).
4. **Tests:** unit-test `renderMarkdown` (FORCE_COLOR + NO_COLOR); extend the
   `runShell` tests to assert the hooks fire at the right points AND that omitting
   them preserves the current output. Keep the whole suite offline/deterministic.
5. **Self-review + manual live smoke** against local Ollama (`gemma4:e4b`);
   record the smoke in the journal; open a draft PR.

## Risks

- **Spinner/re-render corrupting the stream** — mitigate by confining all cursor
  control to the TTY wrapper, gating on `stdout.isTTY`, and degrading to plain
  append (no re-render) when not a TTY or `NO_COLOR` is set.
- **Markdown re-render vs wrapped lines** — clearing the streamed region must
  count wrapped rows against `stdout.columns`; if unreliable, fall back to leaving
  the streamed raw text and appending a rendered block rather than clearing.
- **Accidental behavior change in the core** — mitigated by the `?? io.write`
  fallback and the "omitting hooks is byte-identical" regression test.
