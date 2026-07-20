# Keryx OpenTUI Interactive Shell — Requirements Package
Version: 0.1.0

## Status

`draft` — requirements gathering. This package specifies migrating the keryx
interactive shell/agent UI from the current line-based `node:readline` renderer to
a full-screen **OpenTUI** (`@opentui/core`) terminal UI, to gain a live,
Pi/grok-style command composer (an as-you-type `/` command dropdown), a persistent
input area, and a component-based rendering model — WITHOUT rewriting the
deterministic agent driver or the pure render helpers already in place.

No new runtime is implemented yet. The port-based agent driver
(`src/commands/agent.ts` `runAgentTurn`), the `AgentIO`/`ShellIO` hook surface, and
the pure render helpers (`renderMarkdown`, `live-render.ts`, `indentBlock`,
`collapseToolOutput`, `summarizeToolArgs`, reasoning capture) already exist
(flows 033, 048–057) and are cited as the foundation that carries over unchanged.

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
