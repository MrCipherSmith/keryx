# Keryx OpenTUI Interactive Shell — Technical Specification
Version: 0.2.0

Status: `implemented (agent mode) — chat renderer outstanding`. The architecture
described below — swap the IO layer for an OpenTUI renderer, keep the
deterministic driver unchanged — has shipped for the **agent** shell (flows
059–067; `src/tui/tui-shell.ts`, `src/commands/agent-commands.ts`, ADR-0005
Accepted), and the TUI is the default interactive shell on a TTY. The chat half
of the scope was never built and `--chat` still runs readline — see **§10 Open
items**, which also lists four smaller gaps.

Two reading notes. The `(SPIKE)` names below were resolved by the Phase 0 spike
(flow 059) and are recorded as answered in §2, but may diverge in spelling from
this prose: the runtime source under `src/tui/` is the source of truth for the
current component API. And the "pure helpers unchanged" premise no longer holds
literally — see §9 D-6. Post-migration work continues to amend this document.

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

`(SPIKE)` items — **resolved** by the flow-059 Phase 0 spike (GO verdict; see
ADR-0005). Answers as shipped:

- **Primitives:** `TextRenderable`, `BoxRenderable`, `InputRenderable`,
  `SelectRenderable` (the `/` dropdown and every picker), `ScrollBoxRenderable`
  (the transcript). Later work also uses `TabSelectRenderable` and the testing
  harness's `captureSpans`.
- **Keyboard + focus:** declarative `keyBindings` on the composer plus a
  pre-focus global keypress stream, wrapped once as `onKeypress(renderer, handler)`
  in `src/tui/tui-shell.ts`. Focus is routed explicitly (`focus()` / `blur()`);
  ownership is arbitrated by a single `focusOwner` guard — see D-3.
- **Screen mode:** alternate screen (`screenMode: "alternate-screen"`,
  `clearOnShutdown: true`). Native scrollback is forfeited by design (R2 accepted,
  as codex/claude do); everything lives inside the `ScrollBoxRenderable`. This is
  why D-5 exists.
- **Resize:** handled by the renderer; pinned by headless `resize()` tests.
- **Binaries + license:** prebuilt per-platform native binary via npm
  optionalDependencies (no Zig at install), MIT. darwin-arm64 confirmed in the
  spike; other targets confirm as they are exercised. Ratified in ADR-0005.

Two harness facts discovered later, during flow 109, are recorded in §7.1 —
they are not spike items but they constrain how this layer can be tested.

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

## 8. Phase 0 spike — exit criteria (**passed**, flow 059)

The gate below was cleared with a GO verdict; ADR-0005 ratifies the dependency.
Retained as the historical record of what the gate actually required.

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

### D-6 — the pure render helpers are extended, not frozen (deviation from G3)

**Status:** accepted (flow 109). **Deviates from:** PRD G3 and ADR-0005 §4, both
of which state that the pure render helpers (`renderMarkdown`, `live-render`,
`collapseToolOutput`, `indentBlock`, reasoning capture) carry over **unchanged**.

Flow 109 changed them: `renderMarkdown` in `src/lib/ui.ts` became fence-aware
(it now emits a language tag and routes diff bodies through the new `renderDiff`),
and `src/lib/md-blocks.ts` was added as a new pure module underneath it. The
readline shell's `/expand` was rebuilt on the same helpers via
`expandedToolOutput`. So the helper *layer* grew and its output changed.

**Why this is a deviation worth naming rather than a violation to hide.** G3's
purpose was to bound the *migration*: OpenTUI must be presentation only, so that
swapping the IO layer could not perturb agent behavior. That purpose is intact —
`runAgentTurn`, `ShellIO`/`AgentIO`, the metaproject port, providers and policy
are untouched by diff, and no helper change is reachable from the driver. What G3
did not anticipate is post-migration *feature* work whose logic must be shared by
both shells. Keeping fence segmentation and diff classification inside the TUI
would have re-created the exact drift G3 was written to prevent: the readline
`/expand` had already grown its own header format and monochrome diffs by the
time flow 109 found it.

**The rule that replaces G3's letter, keeping its spirit:** rendering *logic* is
added to `src/lib` as pure, unit-tested helpers consumed by both shells (this is
also PRD N2); the OpenTUI layer stays thin presentation. A helper may change when
both shells change with it and the pure tests are updated in the same commit.
Anything that would alter driver, port, provider or policy behavior is still out
of bounds and needs its own ADR.

## 10. Open items

Recorded 2026-07-21 after auditing the package against the code. Phases 0-5
shipped for the **agent** shell, which is why the package reads as delivered —
but "implemented" was too strong for the scope as written. Each item below was
verified in the source, not inferred from the roadmap.

### O-1 — the chat shell has no OpenTUI renderer (scope gap, blocks Phase 5)

The package scope is "the interactive shell (chat + agent)", and §1 above names
`runShell` / `ShellIO` as the chat analogue of `runAgentTurn` / `AgentIO`. Only
the agent half was built. `ShellIO` has **zero** references under `src/tui/` — it
appears only in `src/commands/shell.ts` and `src/commands/select.ts` — and the
launch guard is `if (flags.wantTui && modeFlag !== false && process.stdout.isTTY)`
(`src/commands/shell.ts:1094`), where `--chat` sets `modeFlag = false`. So chat
unconditionally uses readline.

Consequence: Phase 5's second half ("retire the readline path only once at
parity") is unreachable, because readline is chat's only implementation. Anyone
reading "TUI is the default" should understand it as *agent mode is the default
and is a TUI*; chat is unchanged from before this package.

### O-2 — F1's shared command registry has only one consumer

F1 requires the `/` dropdown to reuse a shared registry "so chat and agent share
definitions". Only `AGENT_SLASH_COMMANDS` exists (`src/commands/agent-commands.ts:15`).
There is no chat command set, so the sharing requirement is vacuous rather than
met. It becomes real work the moment O-1 is addressed.

### O-3 — N1 platform coverage is unvalidated beyond darwin-arm64

N1 lists "darwin-arm64, darwin-x64, linux-x64, linux-arm64 at minimum". Only
darwin-arm64 has been exercised; ADR-0005 says as much ("linux-x64/arm64 to
confirm as the migration proceeds"). `linux-x64` appears in this repository only
in the three documents that name it as a target, never as a confirmed result.
Because the dependency is optional, dynamically imported and fallback-guarded, an
unsupported platform degrades to readline rather than breaking — so this is a
coverage gap, not a correctness risk.

### O-4 — the no-TTY fallback is implemented but untested

The success criterion is "`keryx shell` with no TTY / on an unsupported platform
falls back to the readline shell with **byte-identical plain output**". The guard
exists (`src/tui/tui-shell.ts:708`, returning `false` so the caller falls
through), but `isTTY` occurs exactly once across the whole test surface — in that
guard. There is no test asserting output parity between the two renderers, and no
check that a global install via `scripts/install.sh --global` launches the TUI.
The claim is currently believed, not demonstrated.

### O-5 — R5 cold-start latency was never measured

"Measure cold-start of the TUI vs the current instant readline shell" was a
Phase 0 exit criterion. No number is recorded here, in ADR-0005, or in the flow
package. The gate passed on the other four criteria.

### Not an open item, listed to prevent confusion

`collapseToolOutput` does not normalize CRLF, so a CRLF tool result's one-line
readline summary can carry a stray `\r`. That is a defect deferred by flow 109
and tracked in its journal — it is not a requirement of this package.
