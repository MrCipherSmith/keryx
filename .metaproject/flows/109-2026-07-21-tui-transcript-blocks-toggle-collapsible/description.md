# TUI transcript blocks: toggle-collapsible reasoning/tool blocks + copyable markdown/prompt renderer + code & diff rendering

Status: formalized
Source: user description (3 screenshots: Grok prompt block vs. keryx shell transcript)

## Problem

The keryx OpenTUI shell (`--tui`) renders an agent turn as a flat stream of
throwaway `TextRenderable`s. Three concrete gaps make long turns unreadable:

1. **Nothing is collapsible per block.** Reasoning renders as a single dim line
   `◆ thought (14 lines) · /think to expand`, but the full text is not attached
   to that line — only the *most recent* reasoning is kept in a module-scope
   `lastReasoning` (`src/tui/tui-shell.ts:880-892`), and `/think`
   (`:1781-1784`) appends a new line at the bottom instead of expanding the
   original block. Tool results are collapsed by `collapseToolOutput` and the
   full output is **discarded** (`:191-196`); `/expand` does not exist in TUI
   mode at all. The user cannot fold/unfold individual commands, thoughts, or
   reasoning sections.
2. **No renderer for markdown "payload" answers.** When the model returns a
   generated prompt or a markdown document (screenshot 1: a whole prompt emitted
   as an `md` block), keryx renders it as undifferentiated dim text with the
   fence dropped. There is no visual frame, no header, and no one-key way to
   copy that payload to the clipboard — even though `copyToClipboardOSC52` is
   already wired for mouse selections (`:689-699`).
3. **No code or diff rendering.** Fenced code loses its language info string and
   is flattened to `otui.dim()` (`:101-111`). Unified diffs are printed raw:
   `+`, `-`, `@@` are not colorized, hunks are not framed. Generated code and
   patches are therefore unreadable in the transcript.

## Expected Outcome

- Reasoning, tool calls, and tool results become **retained, individually
  toggleable blocks** with a `▸`/`▾` marker, expandable/collapsible from the
  keyboard without losing the composer workflow.
- Markdown payload blocks (fenced `md`/`markdown`/`prompt`/`text`, or any large
  fenced block) render as a **framed block with a header** (`kind · N lines ·
  copy hint`) whose raw source text is retained and copyable to the system
  clipboard in one keystroke, reusing the existing "Copied to clipboard" toast.
- Fenced code renders inside a frame with a **language tag**; unified diffs
  render with green `+`, red `-`, cyan `@@`, dim `---`/`+++`, whether they come
  from a ```` ```diff ```` fence or are sniffed inside tool output.
- All of it stays **dependency-free and offline**: no new npm package, no
  tree-sitter worker, no grammar download at render time.

## Out of Scope

- Native `CodeRenderable`/`DiffRenderable` adoption (WASM worker + network
  grammar fetch; revisit once offline grammar bundling is decided — see plan.md
  decision D-2).
- Real syntax highlighting (per-token keyword coloring). Structural treatment
  only: frame, language tag, gutter, diff line classes.
- Mouse-driven collapse/expand affordances (keyboard only in this flow).
- Split-view diffs; word-level intra-line diffs.
- Refactoring `launchTuiAgentShell` beyond extracting the new block module.
- Rewriting the readline shell UI. Readline mode only inherits the shared pure
  helpers and keeps its existing `/expand` behavior.
