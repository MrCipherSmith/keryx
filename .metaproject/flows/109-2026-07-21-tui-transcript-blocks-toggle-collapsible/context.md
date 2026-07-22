# Context

Collected via gdctx (`ctx rg` / `ctx run` / `ctx read`) plus one read-only
context worker over `src/tui`, `src/lib`, `src/commands/shell.ts` and the
OpenTUI requirements docpack. No raw `rg`/`grep` over project code.

## Impacted surface

| File | Role | Key lines |
|---|---|---|
| `src/tui/tui-shell.ts` (~2142 L) | OpenTUI renderer; `createTuiAgentIo` + the ~1520-line `launchTuiAgentShell` closure | see below |
| `src/lib/ui.ts` | pure render helpers: `renderMarkdown`, `collapseToolOutput`, `summarizeToolArgs` | `:90-131` |
| `src/lib/ui.test.ts` | pure/deterministic ANSI-substring tests | `:90-127` |
| `src/tui/tui-shell.test.ts` | headless OpenTUI tests via `createTestRenderer` | `:26-36`, `:81-140` |
| `src/commands/shell.ts` | shell entry; readline fallback; `/expand` | `:662-665`, `:766`, `:860-873`, `:1044-1049` |
| `src/commands/agent-commands.ts` | shared slash-command registry (feeds the `/`-menu) | `:15-25` |
| `src/lib/live-render.ts` | readline differential markdown renderer | — |
| `docs/requirements/keryx-opentui-shell/specification.md` | spec; already promises inline expand | `:82-84` |
| `docs/decisions/keryx-harness/ADR-0005-opentui-shell-dependency.md` | optional-dep + no-worker stance | `:21`, `:49` |

## Transcript architecture (as-is)

- **No block model.** `transcript = scroll.content` (`tui-shell.ts:833-843`,
  `ScrollBoxRenderable`, `stickyScroll:true`, `stickyStart:"bottom"`).
  `append(content)` (`:139-141`) constructs a `TextRenderable` with a throwaway
  id and drops the handle. Only two handles are retained: `active` (streaming
  assistant block) and `liveStatus` (spinner, removed in `stopBusy` `:1274-1290`
  — the sole precedent for replacing a transcript node).
- Append paths: assistant stream `:147-167`, reasoning `:170-173` / overridden
  `:881-892`, tool call `:186-190` / `:893-900`, tool result `:191-196` /
  `:901-906`, system `:197`, usage `:868-877`, user echo (bordered box,
  `alignSelf:"flex-start"`) `:1824-1835`, role header `:1836-1842`, turn footer
  `:2040-2042`.
- **Framed-block precedent already exists**: user echo `:1824-1835` and the
  side-worker question box `:1583-1599`.

## Collapse mechanics (as-is)

- Reasoning: global `lastReasoning` string; label
  `◆ thought (N lines) · /think to expand`; `/think` (`:1781-1784`) appends a new
  system line — it never expands in place, and only ever the last reasoning.
- Tool output: `collapseToolOutput` (`src/lib/ui.ts:124-131`, pure, returns
  `{summary, lineCount, hidden}`); full output discarded in TUI.
- `/expand` exists only in readline mode (`shell.ts:860-873`) and is absent from
  `AGENT_SLASH_COMMANDS`, so the TUI `/`-menu cannot even offer it.
- The spec (`specification.md:82-84`) already required "expands inline on
  select/Enter (replacing the line-based `/expand`)" — never implemented.

## Input / focus (as-is)

- `textarea.keyBindings` `:973-982` (Enter submit, Shift/Meta+Enter newline).
- Global pre-focus keypress stream via the private
  `r._internalKeyInput.onInternal("keypress", …)`, wrapped as `onKeypress(r, h)`
  `:372-375` (duplicated in `composer-choice.ts:41-52`). Handlers receive
  `{name, ctrl, meta, sequence, preventDefault, stopPropagation}` and run
  **before** the focused renderable.
- Focus is monopolized by the composer: `input.focus()` at `:1072, :1110, :1182,
  :1379, :1499, :1538, :1799, :2005, :2049, :2063, :2080`.
- Claimed keys: Ctrl+C exits (`exitOnCtrlC:true` `:661`); printables/Backspace/
  Esc are swallowed by the `/`-menu router when `menu.visible && menuNav`
  (`:2072-2101`).
- **No keyboard scroll handler exists** — scroll is mouse-wheel + sticky only.
- OpenTUI 0.4.5 does expose `focusable`, `focus()/blur()`, `onKeyDown`,
  `selectable`, `renderer.focusRenderable()`, `RenderableEvents.FOCUS`.

## Markdown path (as-is)

`markdownToChunks(otui, md)` — `tui-shell.ts:75-126`, **module-private**,
deliberately worker-free (`:70-74`). Handles ATX headings, `**bold**`,
`` `inline code` ``, `-`/`*` bullets, and fences (fence line **dropped**, body
dimmed, language **discarded**). Tables, ordered lists, blockquotes, links,
italics, HR pass through verbatim. Mirrors `renderMarkdown`
(`src/lib/ui.ts:90-118`) rule-for-rule.

## Code / diff (question 3) — evidence

- Fenced code with language-aware styling: **NO**. Info string dropped at
  `tui-shell.ts:101-104`; flat `otui.dim()`. Pinned by `src/lib/ui.test.ts:90-96`.
- Unified diff colorization: **NO**. Zero diff-aware code in `src/`;
  `ctx rg "CodeRenderable|DiffRenderable|MarkdownRenderable|TreeSitter"` returns
  4 hits, all comments (`tui-shell.ts:7,73,130`, `ADR-0005:21`).
- `@opentui/core@0.4.5` *does* ship `CodeRenderable`, `DiffRenderable`
  (parses unified diff itself, `view:"unified"|"split"`), and `SyntaxStyle` —
  **but** highlighting runs through a `TreeSitterClient` that spawns a Worker,
  bundles only `javascript, markdown, markdown_inline, typescript, zig`, and
  otherwise falls back to `DownloadUtils.downloadOrLoad` → a **network fetch at
  render time**. That collides with the no-worker rationale (`:70-74`), with
  keryx's egress posture, and with the flow-084 build externalization.

## Clipboard

`r.on(otui.CliRenderEvents.SELECTION, …)` → `r.getSelection()?.getSelectedText()`
→ `r.copyToClipboardOSC52(text)` → `showToast("Copied to clipboard")`
(`tui-shell.ts:689-699`, `useMouse:true` `:669`). The API
`copyToClipboardOSC52(text: string): boolean` takes an **arbitrary string** —
it is programmatically callable for a block's retained source. `showToast`
(`:801-810`, sidebar-bottom, 5s) is the ready-made confirmation.

## Test surface

- `tui-shell.test.ts` uses **real headless OpenTUI**: `loadOpenTui()` `:26-36`
  returns `undefined` and every TUI test silently skips when the optional dep is
  absent — new tests must copy that shape.
  Harness: `otui.testing.createTestRenderer({width,height})` →
  `{renderer, flush, captureCharFrame, mockInput, resize}`; assertions are
  substring checks on `captureCharFrame()`; input via
  `await mockInput.pressKeys([...])`.
- `launchTuiAgentShell` is **never** invoked by tests — everything inside the
  1520-line closure is untested. Only `createTuiAgentIo` is exercised end-to-end.
- `ui.test.ts` is the pattern for pure helpers (`forceColor()`, raw ANSI
  substrings, exact `toEqual`).

## Risks / constraints (drive the plan)

1. **No retained block state** — the core blocker. Needs a block registry with
   bounded retention (a long session would otherwise hold every tool output).
2. **Composer monopolizes focus**; a nav mode must save/restore focus and
   survive a turn ending mid-navigation (`:2049` yanks focus back).
3. **Key-namespace pressure**; the global handler is a *private* OpenTUI API
   already consumed from two files.
4. **Alternate-screen mode** (`:666-667`) — no terminal scrollback; expanding an
   older block with `stickyScroll:"bottom"` will yank the viewport unless sticky
   is suspended and the scroll offset restored.
5. **Layout rules (flow 075)**: `flexGrow:1/minWidth:0` on `main`,
   `flexGrow:1/minHeight:0` on `scroll`, `flexShrink:0` on all bottom chrome.
   New nested containers must not add unconstrained `flexGrow`;
   `alignSelf:"flex-start"` is the established framed-block idiom.
6. **Readline fallback duplication** (`shell.ts:1044-1049`, flows 065/066) —
   keep logic in pure `src/lib` helpers so both paths stay in sync.
7. **`@opentui/core` is an optional dep** loaded via dynamic `import()`; new
   renderable types must be reached as `otui.X` / `InstanceType<OpenTui["X"]>`,
   never a top-level import (guard: `src/capability/no-optional-imports`).
8. `markdownToChunks` is not exported (`:75`) — must be exported/moved before
   segmentation logic can be unit-tested.
9. `launchTuiAgentShell` is a ~1520-line closure (`:619-2142`); extracting
   `src/tui/transcript-blocks.ts` follows the `composer-choice.ts` /
   `worker-fleet.ts` precedent and is what makes the feature testable.

## Prior art in-repo

Flows 055 (collapsible tool output), 056 (reasoning capture), 061 (chrome
parity), 062 (slash registry), 073/074 (`/think`, sidebar), 075 (layout
flexShrink), 076 (OSC52 copy-on-select), 079 (toasts), 084 (build
externalization of `@opentui/core`).

## Baseline

Code Health gate: **pass** as of 2026-07-20T23:07:55Z (refresh with
`keryx health run`). Do not regress.

## Memory

`keryx memory search "TUI collapse reasoning markdown render"` → 0 results. No
prior lesson constrains this work; a lesson should be written at completion.
