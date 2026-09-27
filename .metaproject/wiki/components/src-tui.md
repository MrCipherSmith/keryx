---
Title: Module src/tui
Version: 2.1.2
Type: component
Status: accepted
Summary: "Implements the OpenTUI interactive shell renderer, including transcript, composer, sidebar, slash menu, and inspect modals."
---
# Module src/tui

VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:c998393f28501c48345347b819ebfb71b636193aab1551692cec5dd4c249f2d7

## Summary

`src/tui` implements the OpenTUI-based interactive shell renderer. It is the default shell on an interactive TTY; `--no-tui` opts out. The TUI replaces the readline shell’s IO layer (`createRichIo` in `src/commands/shell.ts`), but does not change the deterministic `runAgentTurn` driver.

The module provides:

- Transcript, composer, and sidebar layout
- Block navigation and incremental markdown rendering
- Slash-command menus and inspect modals, including `/status` and `/flows`
- UI overlays for choices, approvals, side-worker activity, and wiki-enrich flows

OpenTUI is an optional dependency, loaded dynamically and guarded by the capability layer. If it is unavailable or cannot initialize, the shell falls back to readline. Interactive tools and shell approval are shared with readline through `buildInteractiveAgentTools` and `evaluateShellApproval`; `web_fetch` is not specific to the TUI.

## Architecture

The module is organized into a shell backbone, a transcript block model, and supporting surfaces.

### Shell backbone: `tui-shell.ts`

This file implements the `AgentIO` hook surface and owns the OpenTUI renderer lifecycle. It does not implement `ShellIO`, which remains with the readline shell.

Responsibilities include:

- Rendering tool chrome using shared helpers from `src/lib/ui.ts`, such as `collapseToolOutput` and `summarizeToolArgs`
- Styling prose with `markdownToChunks` from `./transcript-blocks`
- Filtering `AGENT_SLASH_COMMANDS` as the user types and mounting a `SelectRenderable` in the main column
- Letting the composer textarea handle submission through `onSubmit`
- Exiting on Ctrl+C using a renderer configured with `exitOnCtrlC: true`

### Block model: `transcript-blocks.ts`

The block model has two independently testable parts.

#### Block registry

`createBlockRegistry` stores bounded, addressable block content without depending on OpenTUI. A block records its ID, kind, summary, retained `fullText`, collapse state, and line count.

The defaults are:

- `DEFAULT_MAX_BLOCKS = 64`
- `DEFAULT_MAX_RETAINED_CHARS = 400_000`

The character limit applies to retained content and counts characters, not bytes. When content is evicted, the block remains in `list()`, but is marked `retained = false` and its `fullText` is dropped. The block array itself is not bounded.

The registry supports `register()`, `toggle(id)`, `focus(id)`, `focusNext()`, `focusPrev()`, and `bodyText(id)`. `bodyText(id)` returns the payload, a payload with `TRUNCATED_BLOCK_NOTICE`, `EVICTED_BLOCK_TEXT`, or `UNKNOWN_BLOCK_TEXT`, depending on the block’s state.

#### Render layer

`createBlockView` and `createSegmentView` render blocks:

- Code and diff segments use a framed `BoxRenderable` with a language tag.
- Prose segments use an unframed `TextRenderable`.

Streaming renders incrementally: the trailing segment is repainted as tokens arrive, while earlier segments are frozen once their closing fence is found.

### Supporting surfaces

| File | Purpose | Touches OpenTUI |
|---|---|---|
| `worker-fleet.ts` | Fleet registry and glyphs | No |
| `side-worker.ts` | Side-worker prompt construction | No |
| `ask-user-bridge.ts` | Listener slot for pre-mount tools | No |
| `subagent-bridge.ts` | Listener slot for spawned subagents | No |
| `composer-choice.ts` | Choice docks for approval and wiki-enrich flows | Yes |
| `session-info.ts` | `/status` modal presenter | Via `openModal` |
| `flow-inspector.ts` | `/flows` modal presenter | Via `openModal` |
| `inspector-sources.ts` | Data source for inspect modals | No |
| `context-usage.ts` | Context usage presenter | Via `openModal` |

Supporting files use `@opentui/core` through `openModal`, rather than importing it at top level. This follows the lazy-capability contract in ADR-0005.

## Key concepts

### Stream segmentation

Streaming and final-message segmentation use different mechanisms:

1. `createStreamSegmenter` consumes lines incrementally. It shares `fenceInfo` and `stripTrailingCr` with pure helpers, but does not call `segmentMarkdown`. The trailing segment is repainted as it changes; completed segments are frozen.
2. `segmentMarkdown`, in `src/lib/md-blocks.ts`, runs once per message in `onAssistantText` to segment the finished text. It is shared by the TUI and readline shells.

### Block navigation

Ctrl+O enters a modal block-navigation mode:

- The composer blurs and the newest block receives focus.
- Up and Down move focus, clamped to the available blocks.
- Enter or Space toggles the focused block’s collapsed state.
- `y` copies the focused block’s `fullText` using OSC-52 and shows a toast. If the block has been evicted, copying is refused with a truthful toast.
- Escape exits navigation and restores composer focus, the saved scroll offset, and sticky-scroll state.

Block navigation does not activate while the slash menu or an approval or picker overlay is active.

### Structural rendering

Prose is rendered with `markdownToChunks`. Code and diff content use `payloadChunks` and `diffChunks`, including per-line classes for additions, deletions, hunks, metadata, and context.

Classification is shared with readline through the pure helpers `blockLabel` and `classifyDiffLine` in `src/lib/md-blocks.ts`. The renderers differ: the TUI emits chunks, while readline uses `renderDiff` in `src/lib/ui.ts` to produce ANSI strings. This approach follows decision **D-2** in `docs/requirements/keryx-opentui-shell/specification.md` §9.

### Worker fleet

`WorkerFleet` tracks the main agent, subagents, and side-workers. Entries contain an ID, label, status, detail, and model. Fleet status glyphs are:

| Status | Glyph |
|---|---|
| `queued` | ○ |
| `running` | ◐ |
| `done` | ● |
| `failed` | ✗ |
| `blocked` | ◼ |

`humanFleetPhase` displays `queued` as “ready.” The pure formatting helpers `formatFleetSidebar` and `humanFleetPhase` provide sidebar text. The sidebar subscribes to the fleet and repaints when entries are added, updated, or removed.

### Lazy OpenTUI capability

`@opentui/core` is optional. It is loaded with `await import()` inside `launchTuiAgentShell`, guarded by `src/capability/no-optional-imports`, and passed into the shell rather than imported at top level.

If the TTY check fails, the package is absent, or the renderer cannot initialize, `launchTuiAgentShell` returns `false` so the caller can fall back to readline.

### Inspect modals

- `/status` uses the session inspector commands (`SESSION_INFO_COMMANDS`). It always offers Status and Context tabs; Workspaces and Flow tabs appear only when the session references those objects.
- `/flows` shows a sibling list and a Detail inspector.

Both use `openModal`, with fixed 72×18 chrome, an `[x] esc` header, and a one-line footer. `/session-info` and `/info` are not aliases or commands. In readline mode or with `--no-tui`, the same facts are printed as text.

## Main flows

### User invokes a slash command

1. The user types a command, such as `/help`, in the composer.
2. On each keystroke, the slash-menu router filters `AGENT_SLASH_COMMANDS` by prefix.
3. A `SelectRenderable` is mounted in the main column.
4. Up and Down move the highlight. Enter fires `ITEM_SELECTED`, and the handler calls `runLine(opt.name)`.

`showComposerChoice` is not used for slash-command selection; it serves approval and wiki-enrich overlays.

### Assistant response streams

1. The first `write(token)` calls `startMessage()` and adds a message container to the transcript.
2. Tokens pass through `createStreamSegmenter`, which returns `{segments, frozen}`.
3. `paint()` repaints from the `frozen` index onward.
4. `createSegmentView` renders prose as `TextRenderable` content using `markdownToChunks`, and code or diffs as framed `BoxRenderable` content using `payloadChunks` and `diffChunks`.
5. When `onAssistantText` finalizes the message, the shell re-segments the finished text with `segmentMarkdown`, rebuilds the container, and releases the message reference for lazy recreation.

If there are no segments, the container is removed instead of leaving an empty frame.

### Block navigation

1. A tool call registers a block with `kind: "tool"`; its result registers a separate block with `kind: "output"`.
2. A collapsed block shows a header such as `▸ output (42 lines) · /expand · ctrl+o`.
3. Ctrl+O enters navigation through `createBlockNavController.enter()`: the composer blurs, the newest block is focused, and the scroll offset and sticky-scroll state are saved.
4. Up and Down move focus through the registry. Enter or Space toggles the block; expanding builds its body with `makeBody` and `payloadChunks`, while collapsing destroys the body view.
5. `y` copies the block text through OSC-52 and shows a toast, or refuses if the block was evicted.
6. Escape restores composer focus, scroll offset, and sticky-scroll state.

### Side worker answers while the main agent is busy

1. The user submits a question while the main agent is busy.
2. `buildSideWorkerPrompt` builds a prompt from a snapshot of the main turn (phase, detail, and elapsed seconds to one decimal place) and the last 10 messages, each truncated to 400 characters.
3. The worker runs in-process through `runAgentTurn`, with read-only tools (`risk === "read"`) and an approval callback that always returns `false`.
4. Fleet updates use IDs such as `side:<n>` and labels such as `side-<n>`.
5. The subscribed sidebar repaints as the fleet changes.
6. When the worker finishes, its status becomes `done` and its detail becomes `answered`; it is removed after a short `setTimeout`.

The subagent bridge is separate. `setSubagentFleetListener` is registered after renderer creation, and `emitSubagentFleet` is called only by `src/harness/tool/builtin/spawn-subagent-tool.ts` for real spawned subagents.

### Inspect modals

1. A slash builtin command is invoked.
2. The TUI dispatches to `openModal` with a fixed 72×18 panel.
3. `/status` always shows Status and Context. Workspaces and Flow tabs appear only if `inspector-sources` finds session-linked objects.
4. `/flows` lists packages; Up and Down select an item, and Enter or Right opens its detail view.
5. In `/status`, `c` copies the session ID.

Readline mode and `--no-tui` print the same facts as text.

<!-- keryx:reference:begin v=1 hash=d8df7d1e7c35c9a95d53b9d6901934aaddbea690160206d0b00b92d11f8d86f5 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `SIDE_WORKER_DENIED_TOOL_NAMES`
- `isToolAvailableToSideWorker` (function)
- `resolveSidebarMetadata` (function)
- `TuiSelection` (interface)
- `SelectProviderModelOptions` (interface)
- `filterConnectedDetectedProviders` (function)
- `validateOptionalWizardNumber` (function)
- `TuiAgentIo`
- `createTuiAgentIo` (function)
- `ModalTab`
- `ModalFooterAction`
- `ModalTabContext`
- `OpenModalInput`
- `ModalHandle`
- `ModalChrome`
- `BACKDROP_ALPHA`
- `MODAL_PANEL_MARGIN`
- `MODAL_PANEL_CHROME_X`
- `MODAL_PANEL_MIN_WIDTH`
- `MODAL_PANEL_MIN_HEIGHT`

### Key files

- `src/tui/tui-shell.ts` - imported by 16, imports 130
- `src/tui/modal-host.ts` - imported by 45, imports 5
- `src/tui/theme.ts` - imported by 46, imports 2
- `src/tui/shell-chrome.ts` - imported by 26, imports 8
- `src/tui/theme-text.ts` - imported by 23, imports 1
- `src/tui/chat-shell.ts` - imported by 2, imports 19

### Depends on

- `src/commands` - 33 import(s)
- `src/review` - 26 import(s)
- `src/trigger` - 25 import(s)
- `src/lib` - 23 import(s)
- `src/bus` - 15 import(s)
- `src/session` - 13 import(s)

### Depended on by

- `src/commands` - 15 import(s)
- `src/tui/games` - 5 import(s)
- `scripts` - 1 import(s)

### Dependency basis

- Production imports only: 119 import(s) from test file(s) (e.g. `src/bus/delivery.integration.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 190
- Cross-module imports: 224
<!-- keryx:reference:end -->

## Related wiki

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)

## Changelog

- 2.1.2 - Reference refreshed from the code graph (4e80355f).
- **2.1.1** — Reference refreshed from the code graph (5886c474)
- **2.1.0** — Documented `/status` and `/flows` inspect modals, shared tool/approval parity with readline, and that `/session-info` and `/info` are gone
- **2.0.0** — Prose rewritten after fact-check against code; corrected call paths and attributions
- **1.0.0** — Initial enrichment
- **0.1.0** — Generated by `keryx wiki collect`
