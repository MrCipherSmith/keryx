# Implementation Plan

Status: ready

## Approach

Keep the codebase's established shape — **pure helpers in `src/lib` + a thin
renderer module in `src/tui`** — and add the one thing that is genuinely
missing: a *retained, addressable block model* for the transcript. Everything
else (collapse, copy, code frame, diff colors) falls out of that model.

Four layers, bottom-up:

### L1 — `src/lib/md-blocks.ts` (new, pure, no OpenTUI import)

- `segmentMarkdown(md): MdSegment[]` where
  `MdSegment = {kind:"text"; text} | {kind:"code"; lang: string; body: string}`.
  Handles unterminated fences (stream in progress) by emitting the partial code
  segment; tilde fences (`~~~`) treated the same as backticks.
- `classifyDiffLine(line): "add" | "del" | "hunk" | "meta" | "context"`.
- `looksLikeUnifiedDiff(text): boolean` — requires an `@@ -a,b +c,d @@` hunk
  header (or `--- ` + `+++ ` pair) to avoid false positives on prose starting
  with `-`.
- `payloadKind(lang, lineCount): "markdown" | "diff" | "code"` — decides which
  frame a fenced segment gets. `md|markdown|prompt|txt|text` → markdown payload;
  `diff|patch` or `looksLikeUnifiedDiff(body)` → diff; else code.
- `blockLabel({kind, lineCount, collapsed, hint}): string` — the single source
  of truth for `▸ thought (14 lines) · ctrl+r`-style labels, shared by TUI and
  readline so the two never drift.

### L2 — `src/lib/ui.ts` (extend, keep back-compat)

- `renderDiff(text): string` — ANSI colorized unified diff (green `+`, red `-`,
  cyan `@@`, dim `---`/`+++`) for readline mode.
- `renderMarkdown` gains fence-aware behavior via `segmentMarkdown`: language
  tag line + dim body, and diff bodies routed through `renderDiff`.
  `collapseToolOutput` and `summarizeToolArgs` are untouched.

### L3 — `src/tui/transcript-blocks.ts` (new, extracted module)

Two independently testable halves:

1. **`createBlockRegistry({maxBlocks, maxRetainedChars})`** — a *pure* state
   machine, no OpenTUI: `register(block) -> id`, `toggle(id)`, `focusNext()`,
   `focusPrev()`, `focused()`, `get(id)`, `evict()` (bounded retention: drop the
   oldest blocks' `fullText` past the cap, keep the summary). Emits change
   events; holds `{id, kind, collapsed, summary, fullText, lineCount}`.
2. **`createBlockView(otui, renderer, parent, block)`** — builds a
   `BoxRenderable` (`alignSelf:"flex-start"`, `flexShrink:0`, **no**
   unconstrained `flexGrow`) with a header `TextRenderable` (`▸`/`▾` + label)
   and a body child that is created on expand and destroyed on collapse.
   Body content is produced by L1/L2 helpers via `chunksFor(segment)`.

### L4 — `src/tui/tui-shell.ts` (wire-up)

- Export `markdownToChunks` (or move it into `transcript-blocks.ts`) so it is
  testable, and make `render()` emit **a container of sibling renderables** —
  one per `MdSegment` — instead of one flat `TextRenderable`. Streaming keeps
  the "one active renderable" fast path for the *trailing* text segment only.
- Route `onReasoning` / `onToolCall` / `onToolResult` through the registry so
  the full text is retained (bounded) instead of discarded.
- **Block navigation mode**, via the existing `onKeypress(r, …)` wrapper:
  - `Ctrl+O` enters (composer blurs, newest block focused, sticky-scroll
    suspended); `Esc` exits and restores composer focus + scroll position.
  - `↑`/`↓` move focus; `Enter`/`Space` toggle collapse; `y` copies the focused
    block's `fullText` via `copyToClipboardOSC52` + `showToast`.
  - Guarded so it never fires while `menu.visible && menuNav` or while an
    approval/picker overlay is open; a turn ending while in nav mode does not
    yank focus (`:2049` becomes conditional).
- `/think` keeps working (expands the newest reasoning block in place now);
  add `/expand` and `/copy` to `AGENT_SLASH_COMMANDS` so both shells and the
  `/`-menu offer them.

## Decisions

- **D-1 — Block registry over ad-hoc handles.** Retaining renderable handles in
  the 1520-line closure would be untestable. A registry module mirrors the
  `composer-choice.ts` / `worker-fleet.ts` extraction precedent and is unit
  testable without a terminal.
- **D-2 — Do NOT adopt `CodeRenderable`/`DiffRenderable` in this flow.** They
  spawn a tree-sitter Worker and can fetch grammars over the network at render
  time (only `js/ts/markdown/zig` are bundled). That contradicts
  `tui-shell.ts:70-74` and keryx's egress posture. We implement structural
  rendering with pure chunk helpers instead: frame + language tag + diff line
  classes, zero new deps, headless-testable, shared with readline mode.
  Revisit only if offline grammar bundling is settled (note it in the docpack).
- **D-3 — Keyboard-only, modal navigation.** A dedicated `Ctrl+O` mode avoids
  the crowded single-key namespace (printables/Esc/Backspace are already
  claimed by the `/`-menu router) and avoids fighting the composer for focus.
- **D-4 — Bounded retention.** Full text is retained for at most `maxBlocks`
  blocks / `maxRetainedChars` total; evicted blocks keep their summary and show
  `(output no longer retained)` on expand. Prevents an unbounded session leak.
  **Refined in T6 (review F2):** a SINGLE payload larger than
  `maxRetainedChars` is clipped to its head on `register` (`truncated: true`,
  body suffixed with `… (output truncated at the retention cap)`) instead of
  being admitted whole. Eviction alone could not enforce the char cap, because
  the newest retained block is deliberately never evicted — so one oversized
  tool result used to escape the bound entirely and stay resident for the
  process lifetime. Clipping keeps the head visible (a user expanding a huge
  output still sees its beginning) AND makes the cap a hard bound; the registry
  now exposes `retainedChars()` so it can be asserted.
- **D-5 — Sticky-scroll suspension.** Expanding a non-newest block suspends
  `stickyScroll` and restores the prior scroll offset, so the viewport does not
  jump to the bottom (alternate-screen mode has no scrollback to recover from).

## Steps

1. L1 pure module + unit tests (`md-blocks.test.ts`), TDD.
2. L2 `ui.ts` extension + tests; verify `ui.test.ts:90-96` expectation is
   updated intentionally, not broken silently.
3. L3 registry (pure) + tests; then `createBlockView` + headless render test.
4. L4 wire-up in `tui-shell.ts`: segmented rendering, registry routing, nav mode,
   copy, `/expand` + `/copy` registration.
5. Readline parity: `shell.ts` `/expand` unchanged in behavior but sourced from
   the shared label helper; tool output/diff colorized via `renderDiff`.
6. Headless TUI tests: `createTestRenderer` + `mockInput.pressKeys` for
   enter-nav → toggle → copy → exit-nav.
7. `code-verifier`, `keryx health run`, `review-orchestrator`.
8. Docs: update `docs/requirements/keryx-opentui-shell/specification.md`
   (§ collapse now implemented; D-2 recorded), wiki page, flow journal.

## Risks

- **R1** Streaming + segmented rendering: re-segmenting on every token could be
  O(n²). Mitigation: only the trailing segment is re-rendered; earlier segments
  are frozen once a closing fence is seen. Assert with a token-count test.
- **R2** The private `r._internalKeyInput` API gains a third consumer.
  Mitigation: route the new handler through the existing `onKeypress` wrapper
  only — do not touch the private symbol directly.
- **R3** Focus restore races with turn completion (`:2049`). Mitigation: a
  single `focusOwner` guard; `input.focus()` becomes conditional on nav mode
  being inactive. Covered by a headless test.
- **R4** Layout regression (flow 075). Mitigation: every new box gets
  `flexShrink:0` + `alignSelf:"flex-start"`, never `flexGrow`; add a resize test.
  **SUPERSEDED by flow 115 (D-1): the `alignSelf:"flex-start"` half of this
  mitigation was itself the defect.** A transcript box carrying `alignSelf`
  stops measuring its intrinsic height, collapses to the viewport, squeezes
  bordered children so their border rows paint over the content row, and makes
  the ScrollBox under-report `scrollHeight` — putting every row below a large
  expanded block out of reach. It is also what flow 109 recorded as the
  "known @opentui/core defect" at `scrollTop === 2`. Hug with
  `maxWidth: hugWidth(text, chrome)` instead; `flexShrink: 0` and "never
  `flexGrow`" still stand. Enforced by `src/capability/tui-layout.test.ts`.
- **R5** `launchTuiAgentShell` grows further. Mitigation: net new logic lands in
  `transcript-blocks.ts`; the closure only gains wiring calls.
- **R6** Optional-dep guard (`src/capability/no-optional-imports`) — the new TUI
  module must take `otui` as a parameter, never import `@opentui/core` at top
  level.
