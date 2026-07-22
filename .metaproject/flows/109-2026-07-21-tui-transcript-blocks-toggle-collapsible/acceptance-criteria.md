# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Reasoning, tool-call and tool-result entries are registered as addressable transcript blocks that retain their full text (subject to AC8 bounds); a headless test proves a tool result's full output is recoverable after render, which is impossible today because `src/tui/tui-shell.ts:191-196` discards it.
- AC2: Collapse state is per block: a test toggles one block and asserts every other block's collapsed state is unchanged, and that the collapsed header shows a `▸` marker plus a line count while the expanded header shows `▾`.
- AC3: A keyboard block-navigation mode exists in the TUI: `Ctrl+O` enters it (composer loses focus), `↑`/`↓` change the focused block, `Enter` or `Space` toggles it, `Esc` exits and returns focus to the composer. A headless `createTestRenderer` + `mockInput.pressKeys` test drives this full sequence and asserts the rendered frame changes accordingly.
- AC4: Navigation mode never fires while the `/`-command menu is open in nav state or while a picker/approval overlay is active, and a turn completing while nav mode is active does not steal focus back to the composer; both are covered by tests.
- AC5: Assistant markdown is segmented into text and fenced segments, and a fenced segment renders as a framed block with a header carrying its language tag and line count; a headless test asserts the language tag of a ```` ```ts ```` block appears in the captured frame — today the info string is discarded at `src/tui/tui-shell.ts:101-104`.
- AC6: The focused block's raw source text can be copied to the system clipboard with a single key (`y`) via `copyToClipboardOSC52`, confirmed by the existing `Copied to clipboard` toast; a `/copy` slash command copies the newest markdown-payload block and is registered in `src/commands/agent-commands.ts` alongside `/expand`.
- AC7: Unified diffs render with distinct styling for added, removed, hunk-header and file-header lines, both for a ```` ```diff ```` fence and for tool output sniffed by `looksLikeUnifiedDiff`; a markdown bullet list beginning with `-` is proven NOT to be misdetected as a diff.
- AC8: Retention is bounded: the block registry caps retained full text by block count and total characters, evicted blocks keep their summary and expand to a documented `output no longer retained` marker, and a unit test proves the cap is enforced.
- AC9: No new runtime npm dependency is added, and no tree-sitter worker or grammar network fetch is introduced: `package.json` dependency lists are unchanged and `keryx ctx rg "CodeRenderable|DiffRenderable|MarkdownRenderable|TreeSitterClient"` returns no new runtime usage in `src/` (comments excluded). The new pure module `src/lib/md-blocks.ts` has no `@opentui/core` import at any level.
- AC10: Readline (non-TUI) mode still works: `/expand` behaves as before and shares the collapsed-label helper with the TUI, and diff colorization is provided by the shared `src/lib` helper rather than duplicated.
- AC11: Layout does not regress (flow 075): every new transcript container uses `flexShrink: 0` with `alignSelf: "flex-start"` and no unconstrained `flexGrow`, and a headless resize test asserts the composer and footer remain visible after expanding a large block.
- AC12: Expanding a block that is not the newest does not jump the viewport to the bottom: sticky scroll is suspended and the prior scroll offset restored, asserted by a test on the scroll offset before and after a toggle.
- AC13: `bun test` passes for `src/lib/md-blocks.test.ts`, `src/lib/ui.test.ts`, `src/tui/transcript-blocks.test.ts` and `src/tui/tui-shell.test.ts`; `keryx health run` reports a gate no worse than the recorded pass baseline; `review-orchestrator` findings are either resolved or recorded with an explicit disposition in `journal.md`.
- AC14: `docs/requirements/keryx-opentui-shell/specification.md` is updated so the previously unimplemented inline-expand requirement (spec lines 82-84) matches the delivered behavior, and decision D-2 (why `CodeRenderable`/`DiffRenderable` were rejected) is recorded in the docpack.
