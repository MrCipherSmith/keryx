# ADR-0005: OpenTUI as keryx's first UI-facing optional native dependency

**Status**: Accepted (Phase 1 of the OpenTUI interactive-shell migration)
**Proposed**: 2026-07-20
**Depends on**: docs/requirements/keryx-opentui-shell (PRD + spec), flow-059 spike report
**Reviewer Track**: architecture
**Source of Truth**: this document

---

## Context

The interactive shell (`keryx shell`, chat + `--agent`) renders through
`node:readline` in line mode. It cannot present a live, as-you-type interface —
most concretely the Pi/grok-style `/` command dropdown — because a keystroke-driven
overlay fights readline (the flow-048 status-bar removal established this ceiling).
The flow-059 Phase 0 spike evaluated **OpenTUI** (`@opentui/core`) as the render/
input layer and returned a GO verdict: prebuilt native binary (no Zig at install),
MIT, a `split-footer` screen mode matching the Pi/grok layout, all required
primitives (`InputRenderable`, `SelectRenderable`, `ScrollBoxRenderable`,
`BoxRenderable`, `TextRenderable`, `MarkdownRenderable`), and a headless test
harness (`@opentui/core/testing`) that makes the TUI unit-testable without a TTY.

The spike also surfaced the real gate: keryx pins a lean dependency surface —
`dependencies == {}` (a zero-runtime-dependency floor) and `optionalDependencies`
pinned to exactly `@modelcontextprotocol/sdk` + `web-tree-sitter` (guarded by
`src/testing/block-d-no-network.test.ts` AC15 and `src/capability/
no-optional-imports.test.ts`). Adopting OpenTUI expands that pinned set. This ADR
ratifies that expansion.

## Decision

Add `@opentui/core` to keryx as an **optional dependency**, subject to the same
lazy-capability contract every other optional dependency already follows:

1. **`optionalDependencies` only — never `dependencies`.** The deterministic core
   keeps its zero-`dependencies` floor. Nothing on the harness/driver/provider/
   policy path imports it.
2. **Dynamic `import()` only — never a top-level import.** `@opentui/core` is loaded
   exclusively via `await import("@opentui/core")` inside the TUI shell entry point
   (`src/tui/tui-shell.ts`), enforced by the existing no-top-level-import guard.
3. **Graceful fallback is mandatory.** The TUI is opt-in (`--tui`; later the default
   on interactive TTYs). Whenever there is no TTY, the optional package is absent,
   or the renderer fails to initialise, the shell falls back to the existing
   `node:readline` renderer with byte-identical plain output. No user path hard-
   depends on OpenTUI.
4. **Presentation only.** OpenTUI is a new IO implementation of the existing
   `AgentIO`/`ShellIO` hook surface. `runAgentTurn`, the pure render helpers
   (`renderMarkdown`, `live-render`, `collapseToolOutput`, `indentBlock`,
   reasoning capture), providers, policy, and the metaproject port are unchanged.

## Consequences

- **Positive:** a live command composer + persistent split-footer layout become
  possible; the migration stays bounded (swap IO, keep the brain); the TUI is
  headless-testable, preserving keryx's determinism/testability discipline.
- **Cost / risk:** OpenTUI ships a per-platform native binary (`libopentui.dylib`
  etc.) via npm optionalDependencies. This is keryx's first UI-facing native
  dependency. Portability MUST be validated per target platform (darwin-arm64
  confirmed in the spike; linux-x64/arm64 to confirm as the migration proceeds).
  Because it is optional + dynamically imported + fallback-guarded, an unsupported
  platform or a missing binary degrades to the readline shell rather than breaking
  the CLI.
- **Invariant preserved:** the zero-`dependencies` floor (AC0-1) is untouched; the
  policy/default-deny/egress guarantees (ADR-0003) are untouched.

## Guard update

`src/testing/block-d-no-network.test.ts` AC15 is updated to pin the new exact
optionalDependencies set: `@modelcontextprotocol/sdk`, `@opentui/core`,
`web-tree-sitter`. Any FURTHER dependency remains a conscious, ADR-gated decision.
