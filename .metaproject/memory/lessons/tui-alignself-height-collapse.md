# OpenTUI: alignSelf on a transcript box collapses its intrinsic height

Version: 1.0.0
Type: lesson
Status: accepted
Confidence: high

## Summary

In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying
`alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to
the viewport height, squeezes its children, and makes the ScrollBox under-report
`scrollHeight`. Hug content with `maxWidth` instead.

## Details

Measured headlessly on a 40x12 test renderer, one 30-line `TextRenderable`
inside a box inside `scroll.content`:

| box options | content h | box h | text h | scrollHeight |
|---|---|---|---|---|
| plain | 30 | 30 | 30 | 30 |
| `border` | 32 | 32 | 30 | 32 |
| `border` + `flexShrink: 0` | 32 | 32 | 30 | 32 |
| `alignSelf: "flex-start"` | **12** | **12** | **12** | **12** |
| `alignSelf` + `flexShrink: 0` | **12** | **12** | **12** | **12** |
| `alignSelf` + `border` | **12** | **12** | **10** | **12** |
| `alignSelf` + `width: 20` | 30 | 30 | 30 | 30 |
| `maxWidth: 11` | 32 | 32 | 30 | 32 |
| `maxWidth: 100` (> available) | 32 | 32 (w clamped) | 30 | 32 |

The trigger is `alignSelf` alone — `border` and `flexShrink` are innocent, and
ANY definite cross-axis size restores correct measurement. A row wrapper
(`flexDirection: "row"` parent, so the child hugs in the MAIN axis) does not
help: the height is then the row's cross axis and collapses the same way.

Two user-visible symptoms, both reported as separate bugs:

1. A bordered box squeezed below its natural height paints its top and bottom
   border rows over its single content row — the user sees a corrupted
   `╰─❯ text─╯` instead of a three-row box. It looks like a broken input line.
2. `scrollHeight` under-reports (23 against ~43 real rows in the shipped
   chrome), so `scrollTop` clamps early and everything below a large expanded
   block — the answer itself — is unreachable at any scroll position.

Flow 109 had already hit symptom 1 and recorded it as a "known `@opentui/core`
defect: a bordered child in a ScrollBox at `scrollTop === 2` overdraws the row
below the viewport", carving it out of an assertion. It was not upstream: the
repro's own boxes used `alignSelf`. Replacing the hug with `maxWidth` makes the
bleed disappear at every offset.

**Rule:** hug with `maxWidth: hugWidth(text, chrome)`
(`src/lib/md-blocks.ts`), never `alignSelf`. `width` is wrong too — it overflows
a terminal narrower than the value, while `maxWidth` is clamped by the parent
and therefore resize-safe. `flexShrink: 0` and "never `flexGrow`" (flow 075)
still stand.

Enforced by `src/capability/tui-layout.test.ts` (static ban over
`src/tui/**` runtime sources) plus measurement regressions in
`src/tui/tui-shell.test.ts`.

## Provenance

- Source: flow 115
- Link: .metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a
- Created: 2026-07-21
- Updated: 2026-07-21

## Related Scopes

- Module: tui
- Entity: transcript-blocks, shell-chrome
- Files: src/tui/transcript-blocks.ts, src/tui/tui-shell.ts, src/tui/chat-shell.ts, src/lib/md-blocks.ts, src/capability/tui-layout.test.ts
- Skills: gdskills/quality, testing

## Tags

opentui, layout, yoga, flexbox, scrollbox, rendering, regression

## Changelog

- 1.0.0 - Recorded from flow 115 with the measurement matrix and the corrected
  attribution of the flow-109 "upstream defect".
