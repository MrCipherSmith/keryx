# Keryx OpenTUI Interactive Shell — Technical Specification
Version: 0.2.0

Status: `implemented`. The architecture described below — swap the IO layer for
an OpenTUI renderer, keep the deterministic driver unchanged — has shipped for
**both** modes (flows 059–067 for the agent shell, flow 112 for chat;
`src/tui/tui-shell.ts`, `src/tui/shell-chrome.ts`, `src/tui/chat-shell.ts`,
`src/commands/agent-commands.ts`, ADR-0005 Accepted). The TUI is the default
interactive shell on a TTY in both modes; readline remains the mandatory fallback
for no-TTY, a missing optional dependency, or renderer init failure. **§10 Open
items** still lists three smaller gaps (O-3, O-4, O-5).

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

As shipped (flow 112 made the `ShellIO` half real; before it, only the `AgentIO`
side existed and this diagram was aspirational):

```
            unchanged                          REPLACED
  ┌───────────────────────────┐   ┌──────────────────────────────────┐
  │ runAgentTurn              │──▶│ tui-shell.ts  implements AgentIO │
  │ runShell                  │──▶│ chat-shell.ts implements ShellIO │
  │ (drivers, port-based)     │   └───────────────┬──────────────────┘
  └───────────────────────────┘                   │ both mount
            │  reuse                              ▼
            ▼                          shell-chrome.ts (mode-agnostic)
  md-blocks · transcript-blocks ·      layout · composer · /-menu ·
  renderMarkdown · collapseToolOutput   footer · toast · overlay guard
                                                  │ renders via
                                                  ▼
                                          @opentui/core renderer
```

`ShellIO` pulls its input (`lines: AsyncIterable<string>`) while `AgentIO` leaves
the loop to the caller. That asymmetry — not the missing tool hooks — is what
made the chat renderer expensive; the bridge that reconciles it is D-A4.

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

### D-A1 — one shared chrome, not one shell per mode

**Status:** accepted (flow 112). `src/tui/shell-chrome.ts` owns everything that
does not know what a tool is — layout, composer, `/`-menu, footer and busy
spinner, toast, overlay guard, copy-on-select — and is returned as a plain
`ShellChrome` object rather than a base class, because the old closure's coupling
was data, not behaviour. `launchTuiAgentShell` keeps only agent concerns
(approval, ask-user, worker fleet, side workers, the wiki router, the block
registry and nav, the `runAgentTurn` call site) and shrank from 1610 to 1254
lines; `src/tui/chat-shell.ts` mounts the same chrome.

A second chat shell beside the agent one was rejected for the reason D-6 exists:
three surfaces drift, and the readline `/expand` had already proved it.

The extraction also removed four forward-declared mutable bindings the closure
depended on (`showToast`, `clearBusyTimer`, `setBusyPhase`, and the nav
controller's late closure over `menu` / `input` / `textarea`) by fixing
construction order. Where a cycle is genuine it is an explicit registration
point — `addOverlaySource(isActive)` and `setFooterOverride(paint)` — never a
placeholder no-op rebound later.

**Cost accepted:** this restructured ~450 lines of the product's default UI,
which had zero tests and one caller. The mitigation was to write the chrome's
headless mount tests *first* — the first tests this shell's chrome has ever had —
and to re-land the agent shell before writing any chat code.

### D-A2 — chat's token counter is an estimate, not a new hook

`ShellIO` has no `onUsage`, so TUI chat cannot report exact usage. Adding the
hook would change a driver surface this package promised to leave alone, so chat
reuses `estimateContextTokens` (flow 077's local-model estimator) and the header
labels the number as an estimate. Revisit only if exact chat usage becomes a
requirement, and then as an additive driver change with its own AC.

### D-A3 — assistant replies stay segment views in chat

Registering replies as addressable blocks would give chat `Ctrl+O` and `/copy`,
but it touches D-3 (modal navigation), D-5 (sticky-scroll suspension) and the
AC11 layout guard. Deferred deliberately, not overlooked. `Ctrl+O` and `/copy`
remain agent-only.

### D-A4 — the push/pull adapter derives turn state from the driver

`runShell` pulls (`lines: AsyncIterable<string>`) while the composer pushes. The
bridge in `chat-shell.ts` queues submissions and hands out exactly one line per
`next()`, so **the driver asking for another line is the proof the previous turn
finished** — including error paths where `onTurnEnd` never fires. Turn state is
therefore derived, not mirrored from a spinner flag, and cannot desynchronise.

Slash commands typed mid-turn are refused rather than queued, because by the time
the turn ends `/model` or `/compact` may no longer match the state they were
typed against — the same call the agent shell's `runLine` makes. `/exit` closes
the stream immediately so teardown does not wait for the model.

`runShell` emits a `"\n\n"` turn separator unconditionally, including for a turn
that produced nothing and therefore never fired `onTurnEnd`. An ambiguous
leading separator is **held** and flushed as content only if more output follows,
which keeps a legitimate leading blank line while never letting the separator
open an empty trailing block.

## 10. Open items

Recorded 2026-07-21 after auditing the package against the code, because "Phases
0-5 shipped" was true of the roadmap and too strong for the scope as written.
Each item was verified in the source, not inferred from the roadmap.

Closure history: **O-1 and O-2** by flow 112; **O-4's fallback body** by flow
113; **O-3, O-5, and O-4's install clause** by flow 114. Entries keep the original
finding above each resolution, so the audit trail survives. What remains is a
single shared gap, not a whole open item: **a rendered TUI first frame cannot be
evidenced in CI**, because `createCliRenderer` needs a controlling terminal that
hosted runners lack. That one pty limitation bounds the last clause of O-3 ("the
TUI launches there"), the last clause of O-4 ("...launches the TUI"), and the
rendered-frame half of O-5. Closing it needs an allocated-pty harness — a
deliberate future decision, tracked below as **O-6**.

### O-1 — chat has no OpenTUI renderer — **CLOSED** (flow 112)

*Was:* the package scope is "the interactive shell (chat + agent)", and §1 names
`runShell` / `ShellIO` as the chat analogue of `runAgentTurn` / `AgentIO`, but
only the agent half was built. `ShellIO` had zero references under `src/tui/`,
and the launch guard `if (flags.wantTui && modeFlag !== false &&
process.stdout.isTTY)` sent every `--chat` invocation to readline.

*Now:* `src/tui/chat-shell.ts` renders `ShellIO` through the shared chrome,
driven by **the real `runShell`** — so TUI chat and readline chat are identical
in system instruction, budget and turn semantics by construction rather than by
discipline. The guard is now `chooseShellSurface(flags, isTty)` returning
`"tui-agent" | "tui-chat" | "readline"`, a pure exported helper with its own
tests; the readline fallback is unchanged for both modes.

Chat consequently gained everything the agent shell already had: the provider and
model pickers, saved credentials, session flags, and flow 109's block, fenced-code
and diff rendering. It also fixes a real defect — `loadShellConfig()` /
`applySavedApiKeys()` used to run only inside the agent branch, so **a provider
key added via `/connect` was invisible to `--chat`**.

Path chosen: extract a mode-agnostic `ShellChrome` (`src/tui/shell-chrome.ts`),
re-land the agent shell on it, then add a thin chat driver. The alternative —
running chat as a tool-free agent — was rejected because it would have put two
different engines behind one flag. See decisions D-A1..D-A4.

Phase 5's second half ("retire the readline path only once at parity") is now
*unblocked in principle*, but not done: readline remains the mandatory fallback
for no-TTY and missing-optional-dependency, so retiring it is a separate scope
decision, not a consequence of this flow.

### O-2 — the shared command registry had one consumer — **CLOSED** (flow 112)

*Was:* F1 requires the `/` dropdown to reuse a shared registry "so chat and agent
share definitions", but only `AGENT_SLASH_COMMANDS` existed, with one consumer,
while three divergent command surfaces were maintained by hand.

*Now:* `AgentSlashCommand` carries `modes: readonly ShellMode[]` plus optional
`modeDescriptions`, and the flattened `{name, description}` shape a menu needs is
obtainable **only through a mode** (`describeCommand`, `commandsForMode`,
`filterCommands(query, mode)`). A consumer therefore cannot render a menu without
naming its mode, so a menu structurally cannot show the other mode's wording.

`/expand`, `/think`, `/copy` and `/resume` are agent-only; `/models` and
`/provider` are chat-only, subsumed in the TUI by `/model` and `/connect`. Three
entries carry genuinely different per-mode wording — `/model` (argument vs
picker), `/connect` (static guidance vs interactive key entry) and `/exit`. The
registry now has three consumers: the TUI, chat readline, and agent readline.
An agent-only command typed in chat fails with an explanatory message instead of
`Unknown command`, and vice versa.

This also fixed a live bug the audit had not spotted: the agent TUI's `/help` was
printing the *chat* description of `/connect`.

### O-3 — N1 platform coverage — **CLOSED for the native layer** (flow 114)

*Was:* N1 lists "darwin-arm64, darwin-x64, linux-x64, linux-arm64 at minimum",
and only darwin-arm64 had ever been exercised. `linux-x64` appeared in this
repository only in the documents that named it as a target, never as a result.

*Now:* `.github/workflows/ci.yml` has an `opentui-native-matrix` job on all four,
enabled by the repository being public (free arm64 runners). Runner labels were
verified against GitHub's current hosted-runner offering on 2026-07-22, not
assumed — and one assumption was wrong: `macos-13` retired 2025-12-04, so
darwin-x64 uses **`macos-15-intel`** (the current and last hosted x86_64 macOS
image). No target was dropped.

| N1 target | Runner |
|---|---|
| linux-x64 | `ubuntu-latest` |
| linux-arm64 | `ubuntu-24.04-arm` |
| darwin-arm64 | `macos-latest` |
| darwin-x64 | `macos-15-intel` |

Per leg the job proves two things, both **positively**:

- **The native binary actually loaded.** Absence-of-error is not evidence here —
  the dependency is fallback-guarded, so a missing binary degrades to readline
  silently, which is exactly what an unsupported platform looks like.
  `scripts/verify-opentui-native.ts` resolves the platform dylib (>512 KB),
  confirms `resolveRenderLib()` dlopens an `FFIRenderLib`, and round-trips a
  JS-written byte back out of Zig memory via `drawText` / `getRealCharBytes` —
  unforgeable by a stub or the readline fallback. It also fails if `zig` is on
  PATH, evidencing N1's "no Zig toolchain at end-user install".
- **Zero skips.** `scripts/opentui-tests-no-skips.ts` reads bun's JUnit counts
  and fails loudly on `skipped>0`, `tests==0`, or a missing report, because a
  skip means the optional dependency did not resolve and a green-with-skips run
  would be vacuous. This caught three `tui-shell.test.ts` renderer tests that used
  early-`return` — which bun counts as PASS — and moved them to `test.skipIf`.

**What is covered, and what is not.** N1's wording — binaries cover the
platforms, the install path pulls them, no Zig — is proven on all four. "The TUI
*launches* there" is not, and cannot be: `createCliRenderer` needs a controlling
terminal that a hosted runner lacks, so a CI invocation takes the readline
fallback by design. That is the same pty gap that bounds O-4's install clause;
closing it is a shared follow-up, not part of this flow.

**Cost.** The matrix runs four hosted runners on every future PR — but not for
money: this repository is public, and standard hosted runners are free with no
minute limit for public repos, macOS included. The real costs are ~30 s of extra
wall-clock (the legs run in parallel, 11-28 s each), queue time when several PRs
land at once (the free tier's macOS concurrency ceiling is lower than Linux's),
and four more places that can go red for reasons unrelated to the change under
review — `macos-13` was retired mid-flight while this matrix was being written.

The legs are deliberately **not** required status checks: `main`'s branch
protection requires only `typecheck, tests, standard`, so a red leg informs
without blocking a merge. Both trade-offs are repeated in the `ci.yml` job
comment for whoever next edits CI.

### O-4 — the fallback was implemented but untested — **CLOSED in part** (flow 113)

*Was:* the success criterion is "`keryx shell` with no TTY / on an unsupported
platform falls back to the readline shell with **byte-identical plain output**",
and a global install launches the TUI on a supported platform. The guard existed
and returned `false` so the caller fell through, but no test touched
`process.stdout.isTTY` at all, nothing asserted output parity, and nothing
checked the install path. The claim was believed, not demonstrated.

*Now:* `src/tui/shell-fallback.test.ts` proves each trigger and the parity claim.

**The mechanism that made this hard, recorded because it will recur.** Every
failing path in both launch functions ends in `return false`, so *the return
value cannot distinguish a working guard from a deleted one* — strip the no-TTY
check and the renderer merely fails later and returns `false` anyway. A test
asserting `=== false` would therefore pass against broken code. The tests instead
run the real code in a child `bun` process whose `--preload` plugin substitutes
`@opentui/core` with a probe recording `imported` / `mountAttempted`, and can
also fail to resolve (dependency-absent) or throw from `createCliRenderer`
(init-failure). Assertions hang on the probe, not the return value. A subprocess
additionally avoids poisoning the process-wide module registry that `bun test`
shares, and lets `isTTY` / `NO_COLOR` / `FORCE_COLOR` vary per run.

Covered: both launch guards decline before loading the optional dependency
(`tui-shell.ts:657`, `chat-shell.ts:493`); an unresolvable optional dependency
declines rather than throwing; a throwing renderer constructor declines rather
than propagating; with no TTY the real CLI runs the readline shell and mounts no
renderer; and readline's bytes carry **no ANSI escapes** under `NO_COLOR`, with a
control asserting the same run *with* colour does emit them — so the property
belongs to `NO_COLOR` and not to a sink that could never be coloured. Each test
was falsified against deliberately broken code before being accepted; the
evidence is in flow 113's journal.

**Noted, not a defect:** the no-TTY path has two independent layers —
`chooseShellSurface` and the per-shell guard — and either alone suffices. Defence
in depth, but it means no single test pins the whole chain; the chain is pinned
by `shell-fallback.test.ts` plus `shell-launch.test.ts` together.

#### The install half — testable in part, and honestly not in CI as it stands

The criterion's second clause ("a global install via `scripts/install.sh
--global` launches the TUI on a supported platform") is two claims:

- **"the global install produces a working CLI" — CLOSED (flow 114).**
  `scripts/install-global.test.ts` drives `install.sh --global` into a temporary
  prefix via `KERYX_HOME` / `KERYX_BIN_DIR` / `KERYX_REPO_URL` / `KERYX_REF`,
  against a local bare clone — no network to the published repo — and asserts the
  produced wrapper is executable and actually runs the CLI, while the real
  `~/.keryx` and `~/.local/bin` are left untouched. It runs in the main `check`
  job and is falsifiable: breaking the wrapper step yields installer exit 1, an
  empty bin dir, and wrapper exit 127.
- **"...launches the TUI" — still not testable in CI, by design.** The TUI
  declines whenever `process.stdout.isTTY` is falsy, and a hosted runner has no
  controlling terminal, so a CI invocation takes the readline fallback — the
  behaviour O-4's body already pins. Proving a real launch needs an allocated pty
  (`script`, `unbuffer`, or a `node-pty`-style harness); none exists here, and
  adding one is a shared follow-up with O-3's rendered-frame gap, not part of any
  flow so far.

**Read the whole of O-4 as:** the fallback triggers and output parity are proven
(flow 113); the global install produces a working CLI on the four N1 platforms
(flow 114, via O-3's matrix plus this install test); a rendered TUI launch is the
one remaining unproven clause, bounded by the pty gap.

### O-5 — R5 cold-start latency — **MEASURED** (flow 114)

*Was:* "measure cold-start of the TUI vs the current instant readline shell" was
a Phase 0 exit criterion (R5), and no number existed here, in ADR-0005, or in any
flow package.

*Now:* `scripts/measure-cold-start.ts` is a reproducible measurement. Median of
11 runs on an Apple M1 Pro (16 GiB, darwin-arm64, bun 1.3.12):

| Path | Median |
|---|---|
| runtime floor (bare `bun` process) | 12.0 ms |
| readline start-up | 61.2 ms |
| readline + `@opentui/core` native import | 170.7 ms |

**So the TUI adds ~109.5 ms (≈2.79×) over the readline shell** at start-up, on
this machine. Numbers are per-machine; re-run the script to record another.

**What this does not measure, stated so R5 is not over-claimed:** a rendered
first frame. `createCliRenderer` needs a controlling terminal, which neither CI
nor a scripted measurement has, so the figure is the dominant start-up term —
process start, module graph, and the native `@opentui/core` import — not the time
to a drawn UI. That is the term R5 was asking about ("cold start … vs the instant
readline shell"); the rendered-frame delta remains behind the same pty gap that
bounds O-3 and O-4.

### O-6 — a rendered TUI first frame is not evidenced anywhere — OPEN

The single limitation left by flows 112-114. Every automated check that touches
the TUI runs without a controlling terminal, so `createCliRenderer` declines and
the shell takes the readline path. As a result three narrow clauses stay unproven
by machine: that the TUI *renders* on each N1 platform (O-3), that a global
install *launches* it (O-4), and the time-to-first-frame delta (O-5). The block
model, chrome, nav mode, code/diff rendering and every other behaviour are proven
headlessly via `@opentui/core/testing`'s `createTestRenderer`; what is missing is
a real terminal.

Closing O-6 means an allocated-pty harness — `script` / `unbuffer` / `node-pty`
driving `keryx shell` in a pseudo-terminal and asserting on the emitted escape
stream — added to CI on at least one N1 platform. It is scoped as its own future
flow rather than folded into any of the above, because a pty harness is a
non-trivial piece of test infrastructure with its own flakiness surface.

### Not an open item, listed to prevent confusion

`collapseToolOutput` does not normalize CRLF, so a CRLF tool result's one-line
readline summary can carry a stray `\r`. That is a defect deferred by flow 109
and tracked in its journal — it is not a requirement of this package.
