# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Execution order is TDD: **T1 → T3 (failing tests) → T2 → T5 → T4 → T6**.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Root-cause the layout defect and enrich the flow package |
| T3 | test | Failing headless regressions: measurement, scroll reach, dim body, bounded preview, /think toggle |
| T2 | implement | Half A — hugWidth + maxWidth at all six transcript sites, alignSelf guard |
| T5 | implement | Half B — dim + bounded reasoning body, /think toggle + collapse hint |
| T4 | review | code-verifier (`bun run check`), `keryx health run`, review-orchestrator; fix findings |
| T6 | docs | Memory lesson, flow-109 R4 correction, OpenTUI spec + journal |

## T1 — context (completed in Phase 1)

Reproduce headlessly against the SHIPPED factories, isolate the trigger, and
record the measurement matrices in `context.md` / `description.md`.

## T3 — test (written first; must FAIL before T2/T5)

- `src/tui/transcript-blocks.test.ts`
  - `hugWidth` unit cases including a wide-character line.
  - An expanded block body measures its intrinsic height (not the viewport), and
    every bordered box measures at least `borders + 1 content row`.
  - A reasoning block's expanded body is clipped to `MAX_THOUGHT_LINES` with the
    hidden-line notice, while `registry.bodyText(id)` still returns the full
    payload.
- `src/tui/shell-chrome.test.ts` / `src/tui/tui-shell.test.ts` (whichever mounts
  the chrome together with the block mount)
  - With a large block expanded, `scroll.scrollHeight` matches the summed child
    heights, and content registered AFTER the block is reachable by scrolling to
    the bottom (`captureCharFrame()` contains its marker).
- `src/tui/tui-shell.test.ts`
  - `/think` submitted twice through the shipped submit path expands, then
    collapses; the header carries a collapse hint while expanded.
- `src/capability/` — no `alignSelf` in `src/tui/**` runtime sources.

## T2 — implement (Half A)

`hugWidth` in `src/lib/md-blocks.ts` (pure, unit-tested) + the `maxWidth` swap at
`transcript-blocks.ts:541,732,799`, `tui-shell.ts:1351,1624`,
`chat-shell.ts:374`; recomputed on repaint; update the test-only replicas at
`tui-shell.test.ts:1050,1060`.

## T5 — implement (Half B)

`BlockViewOptions.dim` + `maxLines` + `expandedHint` in `createBlockView`;
`attachBlockIo` registers reasoning with them (`tui-shell.ts:188`); `/think`
toggles (`tui-shell.ts:1546`).

## T4 — review

`bun run check`, `keryx health run`, `review-orchestrator`. Findings become new
tasks via `keryx flow task add`, never silent fixes.

## T6 — docs

`keryx memory` lesson (the `alignSelf` measurement trap and how it was proven),
correct the flow 109 R4 guidance, update
`docs/requirements/keryx-opentui-shell/specification.md` and `journal.md`.
