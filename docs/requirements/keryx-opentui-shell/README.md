# Keryx OpenTUI Interactive Shell — Requirements Package
Version: 0.2.0

## Status

`implemented` — Phases 0–5 landed; the OpenTUI shell is the **default interactive
shell** when `process.stdout.isTTY`. The migration from `node:readline` to a
full-screen **OpenTUI** (`@opentui/core`) terminal UI described by this package is
shipped: live `/` command composer, persistent composer region, and component-based
rendering, WITHOUT rewriting the deterministic agent driver or the pure render
helpers.

Runtime evidence (flows 059–066):

- `src/tui/tui-shell.ts` (~80 KB) — the OpenTUI renderer implementing `AgentIO` /
  `ShellIO` (flows 060 skeleton + 061 chrome parity).
- `src/commands/shell.ts:1043-1049` selects OpenTUI when `stdout.isTTY` and the
  `--tui`/`--no-tui` flag allows it; comment at `shell.ts:1026`: "TUI is already
  the default".
- `src/commands/agent-commands.ts` — promoted shared command registry with the
  pure `filterCommands` / `findAgentCommand` helpers (flow 062).
- `@opentui/core ^0.4.5` declared as an `optionalDependencies` entry
  (`package.json:48`); loaded via dynamic `import()` with graceful readline
  fallback. ADR-0005 (`docs/decisions/keryx-harness/ADR-0005-opentui-shell-dependency.md`)
  is **Accepted (Phase 1)**.
- Headless render tests: `src/tui/tui-shell.test.ts`.

Beyond the original Phase 0–5 scope, the TUI also gained side-workers
(`src/tui/side-worker.ts`, `worker-fleet.ts`), multi-agent spawn wiring
(`subagent-bridge.ts`, `ask-user-bridge.ts`, flow 065/066 + commits `9b0ca29`,
`816e8f0`), and dual-store session persistence (`/compact`, `/resume`, `/continue`).
These were added after the spec was written and are not normatively described
here; cite the flow numbers if a follow-on requirements package is split out.

The original `draft` design (port-based agent driver `runAgentTurn`, the
`AgentIO`/`ShellIO` hook surface, and the pure render helpers `renderMarkdown`,
`live-render.ts`, `indentBlock`, `collapseToolOutput`, `summarizeToolArgs`,
reasoning capture — flows 033, 048–057) remains the foundation and carries over
unchanged, as specified.

## Why

The line-based `readline` renderer cannot draw a live dropdown under the cursor as
the user types (it reads whole lines on Enter and delegates echo/editing to the
terminal). Pi and xAI's grok-build show a live command menu because they are
full-screen TUIs that own the terminal and repaint every keystroke. Matching that
UX is an **architecture** change (an input/render layer that owns the terminal),
not a dependency add. OpenTUI is the chosen framework because it is Bun-native
(keryx runs on Bun) and already proven in a coding-agent TUI (`superagent-ai/grok-cli`).

## Scope

- **In:** an OpenTUI-based renderer for the interactive shell (chat + agent),
  behind a `--tui` opt-in flag first, then default; a live `/` command composer;
  re-homing the existing render chrome (markdown, gutter, tool-collapse, reasoning,
  usage, approval) onto OpenTUI components; a Phase 0 spike to de-risk the native
  dependency, scrollback behaviour, and component/API specifics.
- **Out:** changing `runAgentTurn` semantics, the metaproject port, providers,
  policy, the harness core, or the Task Manager/flow layer; a mouse-driven UI;
  editor/ACP embedding.

## Key decision + top risks

- **Decision:** adopt `@opentui/core` (imperative API) as the shell's render layer;
  keep the deterministic driver and pure helpers; swap only the IO implementation
  (`createRichIo` / `runAgentRepl` → an OpenTUI renderer implementing the same
  `AgentIO`/`ShellIO` hooks).
- **Risk R1 (native dependency):** OpenTUI's core is Zig-compiled with prebuilt
  per-platform binaries shipped via npm (end users should NOT need Zig). MUST be
  validated for keryx's target platforms and its `scripts/install.sh --global`
  (Bun) install path — Phase 0 gate.
- **Risk R2 (scrollback):** a full-screen (alt-screen) TUI may forfeit native
  terminal scrollback/copy that the line-based shell preserves. Phase 0 confirms
  OpenTUI's inline-vs-fullscreen options and picks the mode.
- **Risk R3 (rewrite surface):** every flow-050–057 render feature must be
  re-homed on components without regressing; mitigated by keeping the logic in the
  already-pure, unit-tested helpers and treating OpenTUI as presentation only.

See `prd.md` for goals, requirements, success criteria, and the phased roadmap;
`specification.md` for the technical architecture, the AgentIO→component mapping,
and the Phase 0 spike plan.
