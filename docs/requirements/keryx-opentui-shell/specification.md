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
    (`collapseToolOutput`) that expands inline on select/Enter (replacing the
    line-based `/expand`).
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
