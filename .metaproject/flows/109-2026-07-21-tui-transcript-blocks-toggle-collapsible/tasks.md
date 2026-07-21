# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Transcript/render/input/test surface map (DONE — see context.md) |
| T2 | test | Failing tests for pure layer: md segmentation, diff classification, block registry |
| T3 | implement | L1 `src/lib/md-blocks.ts` + L2 `src/lib/ui.ts` diff/code rendering |
| T4 | implement | L3 `src/tui/transcript-blocks.ts` + L4 `tui-shell.ts` wiring (blocks, nav mode, copy) |
| T5 | test | Headless TUI tests + readline parity; verify + review + docs |

## T1 — context (kind: context)

Map the transcript architecture, collapse mechanics, input/focus routing,
markdown path, code/diff capability, clipboard surface, test harness, and risks.
**Completed** by the read-only context worker; result is `context.md`.

## T2 — test (kind: test)

TDD first pass. Write failing unit tests, `src/lib/ui.test.ts` style
(deterministic, `forceColor()`, exact `toEqual` where possible):

- `src/lib/md-blocks.test.ts`
  - `segmentMarkdown`: text/code interleaving; unterminated fence (streaming);
    `~~~` fences; fence with and without an info string; nested backticks in
    prose; empty input.
  - `classifyDiffLine` / `looksLikeUnifiedDiff`: `@@` hunks, `---`/`+++` pairs,
    `+`/`-` body lines, and **negative** cases (a markdown bullet list starting
    with `-` must NOT be classified as a diff).
  - `payloadKind`: `md|markdown|prompt|txt|text` → markdown; `diff|patch` →
    diff; sniffed diff body without a lang → diff; anything else → code.
  - `blockLabel`: collapsed vs expanded marker, singular/plural line count,
    hint text.
- `src/tui/transcript-blocks.test.ts` (registry half only — pure, no OpenTUI)
  - `register`/`toggle` is **per block**: toggling one leaves others untouched.
  - `focusNext`/`focusPrev` clamp at the ends; focus survives new registrations.
  - Bounded retention: past `maxBlocks`/`maxRetainedChars` the oldest blocks
    drop `fullText` but keep `summary`, and expanding an evicted block yields
    the documented `(output no longer retained)` marker.

Constraint: these tests must fail before T3/T4 and pass after, without being
weakened.

## T3 — implement (kind: implement)

- Create `src/lib/md-blocks.ts` per plan L1. Pure; **no** `@opentui/core`
  import, direct or type-level.
- Extend `src/lib/ui.ts` per plan L2: `renderDiff`, fence-aware `renderMarkdown`
  (language tag + dim body, diff bodies through `renderDiff`).
  `collapseToolOutput` / `summarizeToolArgs` signatures unchanged.
- Update `src/lib/ui.test.ts:90-96` **intentionally** (the current assertion
  pins "fence dropped, body dimmed") and state the change in the journal.

## T4 — implement (kind: implement)

- Create `src/tui/transcript-blocks.ts` per plan L3: `createBlockRegistry`
  (pure) + `createBlockView(otui, renderer, parent, block)`. `otui` is a
  parameter — never a top-level optional-dep import.
- Wire `src/tui/tui-shell.ts` per plan L4:
  - export/move `markdownToChunks`; segmented rendering (one renderable per
    `MdSegment`, trailing-segment fast path for streaming);
  - route reasoning / tool call / tool result through the registry (retain full
    text, bounded);
  - block navigation mode via the existing `onKeypress` wrapper: `Ctrl+O` enter,
    `Esc` exit, `↑`/`↓` move, `Enter`/`Space` toggle, `y` copy
    (`copyToClipboardOSC52` + `showToast("Copied to clipboard")`);
  - suspend `stickyScroll` and restore scroll offset when expanding a non-newest
    block; make the turn-end `input.focus()` conditional on nav mode;
  - `/think` expands the newest reasoning block in place; register `/expand` and
    `/copy` in `src/commands/agent-commands.ts`.
- Every new box: `flexShrink:0` + `alignSelf:"flex-start"`, no unconstrained
  `flexGrow`.

## T5 — test + verify + review + docs (kind: test)

- Headless TUI tests in `src/tui/tui-shell.test.ts` following `loadOpenTui()`
  skip-when-absent shape: enter nav mode → toggle a block → copy → exit;
  fenced code renders with a language tag; a `diff` fence renders `+`/`-`
  colorized; a resize does not break the composer (flow-075 regression).
- Readline parity check in `src/commands/shell.ts`: `/expand` still works and
  now shares the label helper; tool-output diffs colorized.
- Run `bun test` for the touched scope, then `code-verifier`,
  `keryx health run`, and `review-orchestrator` (frontend/logic/clean-code +
  project conventions).
- Docs: update `docs/requirements/keryx-opentui-shell/specification.md`
  (inline expand now implemented; record decision D-2 about
  `CodeRenderable`/`DiffRenderable` + tree-sitter), refresh the wiki page for
  the TUI component, and append the run to `journal.md`.
