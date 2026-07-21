# Keryx OpenTUI Interactive Shell — Technical Specification
Version: 0.1.0

Status: `draft`. Concrete OpenTUI API names below marked `(SPIKE)` are to be
confirmed in Phase 0 against `@opentui/core`; the architecture does not depend on
their exact spelling.

## 1. Guiding principle — swap the IO layer, keep the brain

The keryx shell already separates concerns cleanly:

- **Deterministic driver** — `runAgentTurn(io, deps, history, userLine)` in
  `src/commands/agent.ts` reaches NO real stdio; it emits through the `AgentIO`
  hook surface and consumes an injected `ProviderPort` + tools. `runShell` is the
  chat analogue over `ShellIO`.
- **Pure render helpers** — `renderMarkdown`, `indentBlock`, `collapseToolOutput`,
  `summarizeToolArgs` (`src/lib/ui.ts`), the differential renderer
  (`src/lib/live-render.ts`), and reasoning capture (flow 056) are all pure and
  unit-tested.
- **IO implementations** — today `createRichIo` + `runAgentRepl` (`src/commands/
  shell.ts`) implement the hooks against `process.stdout` + `node:readline`.

This migration replaces ONLY the IO implementation with an OpenTUI renderer. The
driver, helpers, provider, policy, and metaproject port are untouched. This is the
crux that keeps the change bounded and testable.

```
            unchanged                         REPLACED
  ┌───────────────────────────┐   ┌─────────────────────────────┐
  │ runAgentTurn / runShell   │──▶│ TuiShell (OpenTUI)          │
  │ (driver, port-based)      │   │  implements AgentIO/ShellIO │
  └───────────────────────────┘   └─────────────────────────────┘
            │  reuses                         │ renders via
            ▼                                 ▼
  renderMarkdown · indentBlock ·      @opentui/core renderer
  collapseToolOutput · live-render      (transcript + composer)
```

## 2. OpenTUI facts (verified) and spike items

Verified from OpenTUI docs/repo:

- Packages: `@opentui/core` (imperative API + primitives) and `@opentui/react`
  (React reconciler). We target **`@opentui/core`** — no React runtime, closest to
  keryx's imperative shell.
- Renderer bootstrap: `const renderer = await createCliRenderer(); renderer.root.add(node)`.
- The native core is Zig-compiled; the build "creates platform-specific libraries
  automatically loaded by the TypeScript layer" — prebuilt binaries via npm, so end
  users should not need Zig.
- Proven in a Bun coding-agent TUI (`superagent-ai/grok-cli`).

`(SPIKE)` to confirm in Phase 0 (R1–R5 in the PRD):

- Exact primitives: text/box/group, a text **input** primitive, a **select/list**
  for the dropdown, and a **scrollable** region.
- Keyboard + focus API (key event subscription, focus routing to the composer).
- Inline vs alt-screen (full-screen) mode and scrollback behaviour.
- Resize handling.
- Prebuilt-binary platform coverage + the license.

## 3. Component tree (target)

```
CliRenderer.root
└── ShellView (column layout, full height)
    ├── TranscriptView   (scrollable, grows)  ← conversation history + live turn
    │   └── TurnBlock*   (user | assistant | tool | reasoning | system)
    └── Composer         (fixed, bottom)
        ├── PromptInput  (the ❯ input line; owns keystrokes)
        └── CommandMenu  (overlay; visible only while a `/…` query is active)
```

- **TranscriptView** holds an append-only list of rendered blocks. The active
  assistant turn streams into the last block; instead of the hand-rolled flow-051
  cursor math, we set the block's text to `renderMarkdown(pending)` each flush and
  let OpenTUI's buffered renderer diff. `live-render.ts` may be retired for the TUI
  path (kept for the readline fallback).
- **TurnBlock** variants map 1:1 to the current chrome:
  - user → the echoed input line.
  - assistant → `● keryx` header + markdown body (gutter via `indentBlock` or a
    component padding prop `(SPIKE)`).
  - tool → `⚙ name(args)` (`summarizeToolArgs`) + a collapsed summary
    (`collapseToolOutput`). **Delivered in flow 109:** reasoning, tool-call and
    tool-result entries are registered as addressable **collapsible blocks**
    (`src/tui/transcript-blocks.ts`) that retain their full text under a bounded
    cap. Collapse state is **per block** — toggling one never touches another.
    A collapsed header reads `▸ <kind> (n lines) · ctrl+o`; expanded reads `▾`.
    Expansion is driven by a modal **block-navigation mode** rather than a
    pointer selection:

    | Key             | Effect                                              |
    |-----------------|-----------------------------------------------------|
    | `Ctrl+O`        | enter block-nav (composer blurs, newest block focused) |
    | `↑` / `↓`       | move the focused block (clamped at both ends)        |
    | `Enter` / `Space` | toggle the focused block                           |
    | `y`             | copy the focused block's retained text (OSC-52)      |
    | `Esc`           | exit; composer refocused, scroll offset restored     |

    A dedicated mode rather than bare single keys because the printable/Esc/
    Backspace namespace already belongs to the composer and the `/`-menu router.
    Nav keys are inert while the `/` dropdown is in nav state or an approval/
    picker overlay is up, and a turn completing mid-navigation does not steal
    focus back.
    `/expand` is **not** replaced: it remains in both shells (it expands the
    newest tool output without entering nav mode), and `/copy` copies the newest
    block — a thought / tool / output block, since assistant markdown renders as
    segment views and is never registered as a block. Both shells render the
    header through the shared `blockLabel` helper (same form; the readline
    `/expand` header names the tool, the TUI names the block class), so the two
    cannot drift structurally.
  - reasoning → dim `⋯ thinking` block (from `onReasoning`).
  - system/usage → dim lines (`↑in ↓out tokens`, `[stopped] …`, errors).

## 4. AgentIO → OpenTUI mapping

| AgentIO hook        | OpenTUI action                                                        |
|---------------------|-----------------------------------------------------------------------|
| `write(s)`          | append token to the active assistant block's pending buffer           |
| `onAssistantText`   | finalize the block: set text to `renderMarkdown(text)`                |
| `onReasoning`       | prepend a dim `⋯ thinking` block before the answer block              |
| `onUsage`           | store; render the dim usage line when the turn ends                   |
| `onToolCall`        | append a `⚙ name(args)` block (collapsed)                              |
| `onToolResult`      | attach full output to the block; show collapsed summary + expander    |
| `onSystem`          | append a dim/red system line                                          |
| `requestApproval`   | focus a modal/inline confirm; resolve on y/N; keep default-deny       |

`ShellIO` (chat) maps the same way minus the tool/reasoning hooks.

## 5. Input + the live `/` command dropdown (G1/F1)

- `PromptInput` owns keystrokes `(SPIKE: key event API)`. On each change, if the
  buffer starts with `/`, filter the shared command registry by the prefix and show
  `CommandMenu`; ↑/↓ move the highlight, Enter/Tab accept (replace buffer or run),
  Esc closes. Submit (Enter with no open menu) hands the line to the driver.
- **Shared command registry** — promote the flow-058 `AGENT_SLASH_COMMANDS`
  (`{name, desc}` + `findAgentCommand`) into `src/commands/agent-commands.ts` as the
  single source; the pure filter `filterCommands(query, registry)` is unit-tested;
  the TUI dropdown and any readline fallback both consume it.
- Registry (initial): `/help`, `/expand` (or inline expand), `/clear`, `/exit`.
  New TUI-era commands (e.g. `/model`, `/copy`) are additive later.

## 6. Migration & rollout

- **Flag:** `keryx shell --tui` opts in during Phases 1–4; `--no-tui` forces the
  readline shell. Phase 5 flips the default for interactive TTYs; fallback stays.
- **Fallback logic:** attempt `createCliRenderer()` only when `process.stdout.isTTY`
  && color enabled && platform supported && the native module loaded; ANY failure
  → the existing `createRichIo`/`runAgentRepl` path. This preserves N-color/CI/piped
  behaviour byte-for-byte.
- **Dependency:** add `@opentui/core` to `package.json`; confirm `scripts/install.sh
  --global` (Bun) pulls the prebuilt binary. Document the fallback for unsupported
  platforms.
- **Retire readline agent path** only after a Phase-2 parity sign-off; keep the
  chat readline core until the TUI chat path is equally proven.

## 7. Testing strategy

- **Unchanged pure helpers** keep their existing unit tests (markdown, gutter,
  collapse, args, reasoning capture, live-render for the fallback).
- **New pure helper:** `filterCommands(query, registry)` — prefix/fuzzy filter,
  unit-tested (empty query, prefix match, no match, ordering).
- **Driver:** unchanged; existing `agent.test.ts` continues to pin `AgentIO`.
- **TUI presentation:** validated by headless render assertions against OpenTUI's
  buffer/snapshot API `(SPIKE)` — assert the transcript buffer contains the
  expected blocks for a scripted turn; NOT by driving a real TTY. If OpenTUI lacks a
  headless render target, TUI wiring stays integration-smoke-only (like today's
  `runAgentRepl`), and all LOGIC remains in the tested pure helpers.
- **Install/portability:** a CI/manual check that a global install launches the TUI
  on darwin-arm64 and falls back cleanly where unsupported.

### 7.1 Headless harness facts (flow 109)

The `(SPIKE)` above resolved: `@opentui/core/testing`'s `createTestRenderer`
gives `{renderer, flush, captureCharFrame, captureSpans, mockInput, resize}`,
which is enough to drive the real registry, block views and nav controller
through the real keypress path. Three harness facts are load-bearing and cost
real debugging time, so they are recorded here.

- **The two entrypoints must be imported SEQUENTIALLY.**
  `@opentui/core` and `@opentui/core/testing` share a module cycle
  (`core-slot.ts` extends `Renderable`). Loading them concurrently —
  `await Promise.all([import("@opentui/core"), import("@opentui/core/testing")])`
  — enters the cycle mid-initialization and throws
  `Cannot access 'Renderable' before initialization` (or the same for
  `TestWriteStream`), intermittently and depending on which side wins the race.
  Awaiting core first and testing second settles the cycle deterministically.
  `loadOpenTui()` in `src/tui/tui-shell.test.ts` carries this as a comment;
  **do not "tidy" it into a `Promise.all`.**
- **A lone `Esc` needs wall-clock time, not a flush.** OpenTUI's stdin parser
  holds a bare `\x1b` in its pending buffer for `DEFAULT_TIMEOUT_MS` (20ms, real
  clock) to disambiguate it from the start of an escape *sequence*. `flush()`
  only awaits a render frame, so `pressEscape()` + `flush()` observes nothing at
  all. Tests wait the timeout out (`pressEscapeAndSettle`). Real terminals pay
  the identical 20ms, so this is a harness accommodation, not a workaround.
- **Known upstream defect — bordered child in a ScrollBox at `scrollTop === 2`.**
  The child's bottom border is painted one row past the viewport clip, over
  whatever sits below (in the shell, the composer's interior row:
  `│─draft─prompt─────╯`). It reproduces from pure OpenTUI primitives with no
  keryx code, is a pure function of the offset (0, 1 and 3 are clean), survives
  `overflow: "hidden"` on the scrollbox, its content, the child and the column
  parent, and survives a forced repaint — so it is live overdraw, not stale
  paint. Keryx cannot fix it from the outside without dropping the frame border
  that AC5/AC7 require. It is pinned by a dedicated test in
  `src/tui/tui-shell.test.ts` that asserts the defect, so the test fails loudly
  when upstream fixes it; delete that test and the corresponding carve-out in
  the AC11 layout test at that point.

## 8. Phase 0 spike — exit criteria

Phase 0 produces a short spike report answering, with evidence:

1. Does `bun add @opentui/core` + a global install pull a working prebuilt binary
   on darwin-arm64 (and ideally linux-x64) with no Zig? (R1)
2. Inline or alt-screen? Is scrollback acceptable? (R2)
3. The concrete primitives + key/focus/resize API for input, select, scrollable. (R3)
4. License compatibility. (R4)
5. Cold-start latency vs the readline shell. (R5)
6. A working `keryx shell --tui` proof: static transcript + a live `/` dropdown
   over dummy commands.

If (1) or (4) fails, the gate re-opens the Ink vs OpenTUI decision before Phase 1.

## 9. Decisions

### D-2 — reject `CodeRenderable` / `DiffRenderable` / `MarkdownRenderable`; render structurally

**Status:** accepted (flow 109). **Applies to:** `src/tui/transcript-blocks.ts`,
`src/tui/tui-shell.ts`.

OpenTUI ships native renderables that syntax-highlight code, diffs and markdown.
Using them for the transcript's fenced and tool-output blocks would have been the
obvious move. They are rejected.

**Why.** All three route through OpenTUI's tree-sitter highlighter, and that
highlighter is a spawned `Worker` (`new Worker(workerPath)` →
`parser.worker.js`) whose grammar loader accepts **either a local path or an
`http(s)` URL** and `fetch`es the latter at load time. Only five grammars ship
bundled — `javascript`, `markdown`, `markdown_inline`, `typescript`, `zig` — so
any other fence language (`python`, `go`, `rust`, `sql`, …) can only be
highlighted by resolving a grammar from somewhere else. That is a render-time
network dependency reachable from ordinary assistant output, which conflicts with
two standing positions:

- **The shell's worker-free stance.** `markdownToChunks` in
  `src/tui/transcript-blocks.ts` exists precisely because "the native
  `MarkdownRenderable` spins a WASM worker that is unavailable headless" — the
  worker also makes the render path untestable under `createTestRenderer`, which
  is where flow 109's entire AC3/AC4/AC5/AC7/AC11/AC12 coverage lives.
- **Keryx's egress posture.** Model output must not be able to cause an outbound
  fetch as a side effect of being *displayed*. A fenced block with an attacker-
  chosen info string is model-controlled input; letting it reach a network-capable
  loader is a needless widening.

**Instead**, blocks render structurally: a frame, a dim language tag, and diff
line classes derived from the pure, dependency-free helpers in
`src/lib/md-blocks.ts` (`classifyDiffLine`, `looksLikeUnifiedDiff`,
`payloadKind`, `blockLabel`). The same helpers back the readline shell's
`renderDiff` / `expandedToolOutput`, so both shells classify identically.

**Cost accepted.** No per-token syntax highlighting inside code fences — bodies
are dim, with color reserved for diff semantics (green add / red delete / cyan
hunk / dim file header). This is strictly more useful than generic highlighting
for the tool output the transcript actually carries.

**Revisit when** OpenTUI supports fully offline grammar bundling — every grammar
resolved from disk with no URL path in the loader — *and* the highlighter is
reachable without spawning a worker, or the worker runs under
`createTestRenderer`. At that point the trade-off flips and D-2 should be
re-opened; nothing else about the block model needs to change, since the
structural renderer is confined to `createBlockView`.

### D-3 — block navigation is a mode (`Ctrl+O` … `Esc`), not bare single keys

Single-key bindings would have to share the printable/`Esc`/Backspace namespace
already claimed by the composer and the `/`-menu router. A modal mode keeps every
existing binding intact and makes the "who owns the keyboard" question explicit —
one `focusOwner` guard, which is also what stops a turn completing mid-navigation
from yanking focus back to the composer.

### D-5 — expanding a non-newest block suspends sticky scroll

The alternate screen has no scrollback, so following the bottom after an
expansion would silently lose the user's place. Expanding any block other than
the newest suspends `stickyScroll` and re-asserts the prior `scrollTop` once
layout has run; the newest block keeps bottom-follow so live output still scrolls
into view. `createBlockNavController` takes an injectable `schedule` so the
post-layout re-assert is deterministic under test instead of racing a
`setTimeout`.
