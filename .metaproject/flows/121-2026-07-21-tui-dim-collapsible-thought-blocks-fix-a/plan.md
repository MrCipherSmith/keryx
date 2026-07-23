# Implementation Plan

Status: ready

## Approach

Two separable halves, in this order:

**Half A — the layout defect (must land first).** Replace the cross-axis
`alignSelf: "flex-start"` hug with a **`maxWidth` hug** on every transcript
renderable. `maxWidth` was measured to preserve intrinsic height measurement in
every case `alignSelf` broke, while keeping the "box hugs its content" look and
staying resize-safe:

| box options (30-line child, 40x12 renderer) | box h × w | scrollHeight |
|---|---|---|
| `alignSelf: "flex-start"` (today) | **12 × 7** | **12** |
| `maxWidth: 11` | 32 × 11 | 32 |
| `maxWidth: 100` (wider than available) | 32 × 37 (clamped) | 32 |
| `maxWidth: 36`, wrapping text, 24-col terminal | 44 × 21 (rewrapped) | 44 |
| `width: 100` | 32 × **100** (overflows) | 32 |

`width` is rejected: it overflows a terminal narrower than the value.
A row-wrapper (`flexDirection: "row"` container hugging in the main axis) was
also probed and **fails** — the box's height is then the row's cross axis and
collapses to the viewport exactly as before.

The hug width is derived from the content by a pure helper:

```
hugWidth(text, extra) = maxVisualLineWidth(text) + extra
```

where `extra` accounts for the box's own borders and horizontal padding. It is
recomputed whenever a body's content is repainted (`showBody`,
`SegmentView.update`), so a growing streamed fence widens its frame.

**Half B — the reasoning UX.** With measurement correct, a 40-line thought is
still 40 rows of screen. Reasoning becomes secondary and bounded:

- expanded reasoning bodies render through the existing dim chunk path
  (`codeChunks`) instead of `markdownToChunks`, driven by a new
  `BlockViewOptions.dim` flag — tool output and code frames are untouched;
- reasoning bodies clip to `MAX_THOUGHT_LINES` (12) instead of the shared
  `MAX_BODY_LINES` (200), reusing `clipBody`'s existing
  `… (N more lines not shown)` notice. The registry still retains the FULL
  payload, so `y` / `/copy` are unaffected (flow 109 D-4 untouched);
- `/think` becomes a toggle over the newest reasoning block, and the header
  advertises the way back via a new `expandedHint` (`blockLabel` already takes
  `collapsed`, so only the hint choice is new).

## Decisions

- **D-1 — `maxWidth` replaces `alignSelf` for hug-content boxes.** Measured
  above. `alignSelf` is removed from every transcript-mounted renderable; a
  capability-style test forbids its reintroduction there. This supersedes flow
  109's risk-R4 guidance ("every new box gets `flexShrink:0` +
  `alignSelf:"flex-start"`"), which is the direct cause of this defect —
  `flexShrink: 0` stays, `alignSelf` goes.
- **D-2 — Fix all six sites, not just the reasoning block.** The corrupted box
  in the user's screenshot is the *user-echo* box, not the thought block: the
  defect is a property of the layout idiom, so every user of the idiom is fixed
  in one pass (`transcript-blocks.ts` ×3, `tui-shell.ts` ×2, `chat-shell.ts` ×1).
- **D-3 — Bound the reasoning preview, not the retention.** Clipping is a VIEW
  concern; the registry keeps the full text so copy stays lossless. Reasoning
  gets its own cap because 200 lines of chain-of-thought is never the thing the
  user is reading.
- **D-4 — Dim via the existing `codeChunks` path.** No new styling primitive:
  `codeChunks` already emits `otui.dim` per line, and reusing it keeps one dim
  implementation.
- **D-5 — Keep flow 109 D-5 (sticky-scroll suspension) as is.** With correct
  measurement it now does what it always intended; no behavioural change.

## Steps

1. **T2 (test-first)** — headless regression tests that fail on `main`:
   measurement/scroll invariants against the shipped chrome, the dim reasoning
   body, the bounded preview, and the `/think` toggle.
2. **T3** — Half A: `hugWidth` helper + `maxWidth` at all six sites + the
   `alignSelf`-free capability guard; update the two test-only replicas.
3. **T4** — Half B: `dim` + `maxLines` options on `createBlockView`, reasoning
   registered with them, `/think` toggle + `expandedHint`.
4. **T5** — `bun run check`, `keryx health run`, `review-orchestrator`
   (frontend/logic/style domains); fix findings through the flow.
5. **T6** — docs: record the `alignSelf` lesson in project memory, correct the
   flow 109 R4 guidance reference, update the OpenTUI shell specification and
   the flow journal.

## Risks

- **R1 — Six call sites, one idiom.** A missed site keeps a latent corrupt box.
  Mitigation: the capability-style test greps `src/tui/**` for `alignSelf`, so
  "all sites" is machine-checked, not eyeballed.
- **R2 — `hugWidth` and wide characters.** CJK/emoji are wider than one column;
  a naive `.length` under-measures and the frame clips. Mitigation: reuse the
  same visual-width measurement the shell already relies on and cover a
  wide-character case in the helper's unit test. A too-small `maxWidth` degrades
  to extra wrapping, never to broken measurement.
- **R3 — Optional-dependency guard.** New code stays in modules that take
  `otui` as a parameter; no top-level `@opentui/core` import, not even in a
  comment (`src/capability/no-optional-imports`).
- **R4 — Snapshot-ish frame assertions are brittle.** Mitigation: assert
  measured heights, `scrollHeight`, and the presence of marker text after
  scrolling — not full-frame equality.
- **R5 — The bounded preview could hide the tail a user wanted.** Mitigation:
  the notice states the hidden line count and the header keeps the `y` / `/copy`
  affordance for the full payload.
