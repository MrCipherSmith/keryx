# Context

Collected deterministically by `keryx flow init` at 2026-07-21T23:04:33.038Z.
Enriched by flow-orchestrator (Phase 1).

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

`keryx gdgraph affected src/tui/transcript-blocks.ts` returns no dependencies or
dependents — the graph has no edges recorded for `src/tui/**`, so the blast
radius below was established by `keryx ctx rg` over `alignSelf` plus direct
reads, not by the graph.

## Code Health

- gate: pass (as of 2026-07-20T23:07:55.416Z)
- refresh: `keryx health run`

## Testing

- runner: `bun test`; gate: `bun run check` (`tsc --noEmit && bun test`).
- The OpenTUI tests mount the SHIPPED factories on
  `@opentui/core/testing`'s `createTestRenderer` and assert over
  `captureCharFrame()`:
  `src/tui/shell-chrome.test.ts`, `src/tui/tui-shell.test.ts`,
  `src/tui/chat-shell.test.ts`, `src/tui/transcript-blocks.test.ts`.
- `@opentui/core` is optional: every TUI test module loads it once at module
  scope and uses `test.skipIf` so an absent dependency SKIPS rather than
  silently passes.

## Enabled Metaproject Modules

- gdgraph, gdctx, gdskills, memory, tasks, health, testing, gdwiki, security

## Agent Findings

### Blast radius — every live `alignSelf: "flex-start"` in a scrolled transcript

| File:line | Renderable |
|---|---|
| `src/tui/transcript-blocks.ts:541` | fenced-code segment frame (`createSegmentView`) |
| `src/tui/transcript-blocks.ts:732` | block container (`createBlockView`) |
| `src/tui/transcript-blocks.ts:799` | expanded block body frame (`createBlockView`) |
| `src/tui/tui-shell.ts:1351` | (agent shell box) |
| `src/tui/tui-shell.ts:1624` | user-echo box — the one visibly corrupted in the report |
| `src/tui/chat-shell.ts:374` | chat-mode user-echo box |

Test-only replicas that must move with the fix: `src/tui/tui-shell.test.ts:1050`,
`:1060`.

### Measured evidence (headless, shipped factories)

Mounting `createShellChrome` (70x16) + `createBlockMount`, registering a
30-line `thought` block and expanding it:

```
scroll-box-content h=23      <- real content is ~43 rows
  ub1  h=2                   <- bordered user-echo box, natural height 3
  w1   h=1
  blkv1 h=25
    blkv1-b h=25             <- body frame, natural height 32
      blkv1-bt h=23          <- text, natural height 30
  ub2  h=2                   <- bordered user-echo box, natural height 3
scrollHeight 23 · scrollTop clamped to 12
```

A bordered box measured at h=2 draws border rows over its content row — the
reported corrupted `❯ добавляй` box.

Isolation matrix (40x12 renderer, 30-line text child, ScrollBox content parent):

| box options | content h | box h | text h |
|---|---|---|---|
| plain | 30 | 30 | 30 |
| `border` | 32 | 32 | 30 |
| `border` + `flexShrink: 0` | 32 | 32 | 30 |
| `alignSelf: "flex-start"` | **12** | **12** | **12** |
| `alignSelf` + `flexShrink: 0` | **12** | **12** | **12** |
| `alignSelf` + `border` | **12** | **12** | **10** |
| `alignSelf` + `width: 20` | 30 | 30 | 30 |
| `maxWidth: 30` (no alignSelf) | 30 | 30 | 30 |

So the trigger is `alignSelf` alone; `border`/`flexShrink` are innocent, and an
explicit cross-axis size restores correct measurement.

### Current behaviour of the touched code

- `createBlockView.showBody` (`transcript-blocks.ts:785`) paints
  `payloadChunks(otui, clipBody(text))` with no language and no tone → normal
  brightness for every block kind. `BlockViewOptions.tone` currently styles the
  HEADER only (`:742`).
- `MAX_BODY_LINES = 200` (`transcript-blocks.ts:358`) bounds every expanded
  body, reasoning included.
- `/think` → `setBlockCollapsed(thought.id, false)` (`tui-shell.ts:1546`), never
  collapses. `/expand` (`:1555`) has the same one-way shape.
- `blockLabel` (`src/lib/md-blocks.ts`) owns the header text and its `hint`;
  the reasoning block is registered with `hint: "/think · ctrl+o"`
  (`tui-shell.ts:188`).
- `createBlockNavController.setCollapsed` (`transcript-blocks.ts:998`) already
  preserves the viewport for non-newest blocks (flow 109 D-5) — that logic is
  correct and stays.

### History

- flow 075 — composer no longer breaks when the transcript scrolls
  (`flexShrink: 0` on chrome, `minHeight: 0` on scroll).
- flow 109 — transcript blocks; its risk R4 mitigation prescribed
  "every new box gets `flexShrink:0` + `alignSelf:"flex-start"`", which is the
  origin of this defect. That guidance must be corrected in this flow.
- flow 112 — chrome extracted to `shell-chrome.ts`, shared by both shells.
- `keryx memory search "OpenTUI layout scroll composer"` → 0 results; no prior
  recorded lesson.

## Reference material

- Comparable shells (grok-build / Claude Code / opencode) render reasoning as
  dim secondary text, bounded to a short preview, with an explicit toggle
  affordance — the target behaviour for AC5/AC6.
