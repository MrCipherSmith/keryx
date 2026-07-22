# Module src/tui

Version: 2.0.0
Type: component
Status: accepted

## Summary

`src/tui` groups 11 file(s). Depends on `src/lib`, `src/commands`, `src/harness/tool/builtin`. Exposes 17 public symbol(s).

## Overview

`src/tui` implements the OpenTUI-based interactive shell renderer. It is the default shell on an interactive TTY (`--no-tui` opts out) and replaces the readline shell's IO layer (`createRichIo` in `src/commands/shell.ts`). The deterministic driver `runAgentTurn` is unchanged by this layer. The **pure render helpers in `src/lib` are not frozen**, though: flow 109 made `renderMarkdown` fence-aware and added `src/lib/md-blocks.ts`, so that both shells classify markdown, fences and diffs through one shared implementation — see decision **D-6** in `docs/requirements/keryx-opentui-shell/specification.md` §9.

The module owns layout and composition (transcript scrollbox + split-footer composer + sidebar), block navigation (a modal Ctrl+O interface for toggling and copying), incremental markdown segmentation during streaming, and the UI overlays (choice docks, the approval gate, side-worker activity, wiki-enrich pickers). `@opentui/core` is an optional dependency loaded only via dynamic `import()` and guarded by the capability layer; the shell falls back to readline when it is absent or unusable.

## How it works

The module is organized in three layers.

The **shell backbone** (`tui-shell.ts`, ~2300 lines) implements the `AgentIO` hook surface — *not* `ShellIO`, which stays with the readline shell — and owns the OpenTUI renderer lifecycle. Tool chrome comes from the shared `src/lib/ui.ts` helpers (`collapseToolOutput`, `summarizeToolArgs`); prose styling comes from `markdownToChunks`, which lives in `./transcript-blocks` rather than `src/lib` because it produces OpenTUI chunks rather than ANSI strings. The `/`-menu router filters `AGENT_SLASH_COMMANDS` by prefix and mounts a `SelectRenderable` directly into the `main` column (the separate `choiceDock` belongs to the approval and wiki-enrich overlays). The composer textarea owns submission via `onSubmit`; Ctrl+C is not a composer concern — the renderer is created with `exitOnCtrlC: true`, so it exits the shell, and block-nav mode deliberately leaves that binding alone.

The **block model** (`transcript-blocks.ts`, ~1000 lines) is two independently testable halves. A pure registry (`createBlockRegistry`) stores bounded, addressable blocks (id, kind, summary, `fullText` clipped to the retention cap, collapse state, line count) with no OpenTUI involvement at all. A render layer (`createBlockView` / `createSegmentView`) paints the block: a **code or diff** segment gets a framed `BoxRenderable` with a language tag, while a **prose** segment is a bare unframed `TextRenderable`. Streaming is incremental — the trailing segment repaints per token and earlier segments freeze once their closing fence line arrives, so the buffer is never re-segmented from scratch.

The **supporting surfaces** differ in kind and should not be lumped together. `worker-fleet.ts` and `side-worker.ts` are pure state and formatting (fleet registry and glyphs; side-worker prompt construction) and never touch OpenTUI. `ask-user-bridge.ts` and `subagent-bridge.ts` are module-level listener slots that let tools built before the TUI mounts reach it afterwards. `composer-choice.ts` is the only supporting file that renders, and correspondingly the only one that takes `otui` as a parameter. What all of them share — and what ADR-0005's lazy-capability contract actually requires — is that none imports `@opentui/core` at top level.

## Key concepts

- **Block registry** — a pure state machine (`createBlockRegistry`) storing id, kind, summary, fullText (clipped on register if it exceeds the cap), collapse state, and line count. Blocks are never removed from `list()`; eviction only sets `retained = false` and drops `fullText`. Defaults: `DEFAULT_MAX_BLOCKS = 64` and `DEFAULT_MAX_RETAINED_CHARS = 400_000` — note these bound the *retained* set and are counted in characters, not bytes; the block array itself is unbounded. Provides `register()`, `toggle(id)`, `focus(id)`, `focusNext()`/`focusPrev()`, and `bodyText(id)`, which has four branches: the payload, the payload plus `TRUNCATED_BLOCK_NOTICE`, `EVICTED_BLOCK_TEXT`, and `UNKNOWN_BLOCK_TEXT` for an id that was never registered.
- **Stream segmentation** — two distinct things that are easy to conflate. During streaming, `createStreamSegmenter` consumes lines incrementally and shares only `fenceInfo`/`stripTrailingCr` with the pure helpers — it never calls `segmentMarkdown`. The trailing segment repaints per token; a segment joins `frozen[]` the moment its closing fence arrives and is never revisited. `segmentMarkdown` (`src/lib/md-blocks.ts`, which also defines `MdSegment`) runs exactly **once per message**, in `onAssistantText`, to re-segment the finished text; the same helper backs the readline shell so both classify identically.
- **Block navigation mode** — a modal keyboard interface entered via Ctrl+O (composer blurs, newest block focused). ↑/↓ move focus (clamped), Enter/Space toggle collapse, y copies the focused block's fullText via OSC-52 + toast, Esc exits (restores composer focus and scroll offset). Guarded so it never fires while the `/`-menu is active or an approval/picker overlay is up.
- **Structural rendering** — prose via `markdownToChunks`; code and diffs via `payloadChunks`/`diffChunks`, which paint a language tag and per-line classes (add / del / hunk / meta / context) instead of spawning a tree-sitter worker. The *classification* is shared with the readline shell through the pure helpers `blockLabel` and `classifyDiffLine` in `src/lib/md-blocks.ts`, so the two shells cannot drift; the *emitters* differ by necessity — the TUI needs chunks, while `renderDiff` (`src/lib/ui.ts`) returns ANSI strings and is readline-only. The rationale is decision **D-2**, which lives in `docs/requirements/keryx-opentui-shell/specification.md` §9 (ADR-0005 ratifies the dependency itself and has no `D-n` decisions).
- **Worker fleet** — a mutable registry (`WorkerFleet`) of the main agent plus subagent and side-worker entries (id, label, status, detail, model). Status glyphs: `queued` ○, `running` ◐, `done` ●, `failed` ✗, `blocked` ◼; `humanFleetPhase` renders `queued` as "ready". Pure formatting (`formatFleetSidebar`, `humanFleetPhase`) turns status plus detail into the sidebar Activity panel; the sidebar subscribes to the fleet and repaints on upsert/remove.
- **Lazy capability** — `@opentui/core` is an optional dependency, loaded only via `await import()` inside `launchTuiAgentShell`, guarded by `src/capability/no-optional-imports`. The shell always takes `otui` as a parameter, never at top level. If the TTY check fails, the package is absent, or the renderer fails to initialize, `launchTuiAgentShell` returns `false` and the caller falls back to readline.

## Main flows

**Flow 1 — User invokes a `/`-command (e.g., `/help`)**
User types `/help` in the composer. On each keystroke the `/`-menu router in `tui-shell.ts` sees the leading `/`, filters `AGENT_SLASH_COMMANDS` (`src/commands/agent-commands.ts`) by prefix via `filterCommands`, and shows a `SelectRenderable` mounted in the `main` column. Focus transfers to the menu, so ↑/↓ move the highlight; Enter fires `SelectRenderableEvents.ITEM_SELECTED`, whose handler calls `runLine(opt.name)`. `showComposerChoice` is **not** on this path — it serves the approval and wiki-enrich overlays and their `choiceDock`.

**Flow 2 — Streaming assistant response with segmented rendering**
The first `write(token)` calls `startMessage()`, which adds the message container to the transcript up front. Each token is pushed through `createStreamSegmenter`, which consumes complete lines and returns `{segments, frozen}`; `paint()` then repaints only from index `frozen` onward, so a token costs one trailing-segment repaint rather than a re-segmentation of the buffer. `createSegmentView` renders a prose segment as a plain `TextRenderable` (`markdownToChunks`) and a code or diff segment as a framed `BoxRenderable` with a language tag (`payloadChunks` → `diffChunks` for diff bodies). When `onAssistantText` finalizes, the text is re-segmented **once** with the pure `segmentMarkdown` and the container rebuilt; the container is then released (`message = undefined`) and lazily re-created on the next `write`. An empty segment list removes the container instead of leaving a blank frame.

**Flow 3 — User navigates and toggles tool output blocks (Ctrl+O flow)**
A tool call registers a block with `kind: "tool"` and hint `ctrl+o`; the tool *result* registers a separate block with `kind: "output"` and hint `/expand · ctrl+o`, so its collapsed header reads `▸ output (42 lines) · /expand · ctrl+o`. User presses Ctrl+O: `createBlockNavController.enter()` blurs the composer, focuses the newest block, saves `scrollTop` and disables `stickyScroll`. ↓ calls `registry.focusNext()` (clamped at the ends) and repaints via `paintAll()`. Space or Enter toggles the focused block: expanding builds the body through `makeBody` → `payloadChunks`, collapsing destroys it. `y` copies `registry.bodyText(id)` over OSC-52 and toasts — and refuses, with a truthful toast, when the block's payload was evicted. Esc exits: composer refocused, scroll offset restored, sticky scroll re-enabled.

**Flow 4 — Side worker answers user question while main agent is busy**
User types a question while the main agent is busy. `buildSideWorkerPrompt` builds the prompt from a snapshot of the main turn (phase, detail, elapsed seconds to one decimal) plus the last 10 messages, each truncated to 400 characters. The worker runs in-process through `runAgentTurn` with read-only tools (`risk === "read"`) and an approval callback hard-wired to `false`, so it cannot execute a shell command — but it does write into the visible transcript.

Fleet updates here are **direct**: the side worker calls `fleet.upsert(...)` with id `side:<n>` and label `side-<n>`, and the sidebar repaints because it subscribes to the fleet. It does not go through the subagent bridge. That bridge is a separate path — `setSubagentFleetListener` is registered after the renderer is created, and `emitSubagentFleet` is called only by `src/harness/tool/builtin/spawn-subagent-tool.ts`, for real spawned subagents. `SubagentFleetEvent` carries `detail`, not `phase`. On completion the side worker is marked `status: "done", detail: "answered"` and then removed by a short `setTimeout`, so the finished slot stays visible for a moment.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `TuiSelection`
- `createTuiAgentIo`
- `BlockSink`
- `BlockIoChrome`
- `attachBlockIo`
- `isShellApproved`
- `ShellApprovalChoice`
- `WikiEnrichChoice`
- `fmtTokens`
- `COMPOSER_MIN_ROWS`
- `COMPOSER_MAX_ROWS`
- `composerHeightForLines`
- `estimateContextTokens`
- `selectBoxHeight`
- `KeypressEvent`
- `onKeypress`
- `launchTuiAgentShell`

### Key files

- `src/tui/tui-shell.ts` - imported by 2, imports 17
- `src/tui/tui-shell.test.ts` - imported by 0, imports 5
- `src/tui/transcript-blocks.ts` - imported by 3, imports 1
- `src/tui/ask-user-bridge.ts` - imported by 2, imports 0
- `src/tui/side-worker.ts` - imported by 2, imports 0
- `src/tui/subagent-bridge.ts` - imported by 2, imports 0

### Depends on

- `src/lib` - 6 import(s)
- `src/commands` - 6 import(s)
- `src/harness/tool/builtin` - 1 import(s)
- `src/harness/provider` - 1 import(s)
- `src/session` - 1 import(s)
- `src/wiki` - 1 import(s)

### Depended on by

- `src/commands` - 2 import(s)
- `src/harness/tool/builtin` - 1 import(s)

### Graph signals

- Files: 11
- Cross-module imports: 16

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)

## Changelog

- 2.0.0 - Prose rewritten after a claim-by-claim fact-check against the code. The 1.0.0 prose asserted 15 things the code does not do — three of the four Main flows described call paths that do not exist (a `/`-menu routed through `showComposerChoice`, per-token `segmentMarkdown` re-segmentation, side-worker fleet updates attributed to the `spawn_subagent` bridge with a fabricated event payload), plus `ShellIO` implementation, `markdownToChunks` placed in `src/lib`, `renderDiff` used by the TUI, D-2 attributed to ADR-0005, a non-existent `chunksFor`, and "pure render helpers remain unchanged" — which decision D-6 was written specifically to contradict. Mechanical claims (line counts, glyphs, key bindings and guards, retention constants, the never-remove-only-evict invariant, the `launchTuiAgentShell` return contract) were correct and are retained.
- 1.0.0 - Prose sections enriched by gdwiki enrich workflow. Claimed verification against tui-shell.ts, transcript-blocks.ts, specification.md and ADR-0005; the 2.0.0 fact-check found that claim not credible.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-21T18:34:17.412Z. Prose sections are drafts for the gdwiki enrich workflow.
