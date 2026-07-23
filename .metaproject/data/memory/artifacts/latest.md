# Memory search: flow id allocation worktree

Results: 1

### 1. OpenTUI: alignSelf on a transcript box collapses its intrinsic height  (score 1.746)
- type: lesson | status: accepted | confidence: high
- matched 1/4 terms; status accepted; confidence high
- scopes: module:tui, entity:transcript-blocks, shell-chrome
- provenance: flow 115
- summary: In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
- entry: lessons/tui-alignself-height-collapse.md
