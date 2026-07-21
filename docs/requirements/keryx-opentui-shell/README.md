# Keryx OpenTUI Interactive Shell — Requirements Package
Version: 0.2.0

## Status

`implemented (agent mode) — chat renderer outstanding`. Phases 0–5 shipped for
the **agent** shell. The scope below says "chat + agent", and the chat half was
never built: `--chat` still runs the readline renderer. See **§10 Open items**
in `specification.md` for the full list of what remains.

This package specified migrating the keryx interactive shell/agent UI from the
line-based `node:readline` renderer to a full-screen **OpenTUI**
(`@opentui/core`) terminal UI, to gain a live, Pi/grok-style command composer (an
as-you-type `/` command dropdown), a persistent input area, and a component-based
rendering model — WITHOUT rewriting the deterministic agent driver or the pure
render helpers already in place.

The renderer now lives in `src/tui/` and **the TUI is the default** on an
interactive TTY (`parseShellCliFlags` defaults `wantTui = true`); `--no-tui`
opts out and the readline shell remains the fallback whenever there is no TTY,
the optional dependency is absent, or the renderer fails to initialise.

### Delivery

| Phase | What | Flow(s) |
|---|---|---|
| 0 | Spike — native dep, scrollback, primitives, license, latency. GO verdict | 059 |
| 1 | `TuiShell` renderer skeleton wired to the driver, `--tui` opt-in; ADR-0005 ratifies the dependency | 060 |
| 2 | Chrome parity — markdown, role headers, tool + collapse, reasoning, usage | 061 |
| 3 | Live `/` command dropdown + shared command registry | 062 |
| 4 | Scrollable transcript, default-deny approval, resize | 063 |
| 5 | TUI default on TTY, `--no-tui` opt-out | 064; reverted by 065 over a stdin-handoff leak, root-caused in 066 and re-landed in 067 |

Phase 5's second half — "retire the readline path once at parity" — is **not**
done and cannot be until the chat renderer exists, because chat has no other
home. Readline is therefore load-bearing, not merely a fallback.

Post-migration work that amends this package rather than extending the roadmap:
layout and UX passes (068–079), persistence and provider work (080–086), and
**flow 109** — the transcript block model (per-block collapse, copyable markdown
payloads, structural code/diff rendering). See §9 of `specification.md` for the
decisions those flows recorded.

### Runtime evidence

- `src/tui/tui-shell.ts` — the OpenTUI renderer. It implements **`AgentIO` only**;
  `ShellIO` has no implementation under `src/tui/`, which is exactly open item
  O-1 (flows 060 skeleton + 061 chrome parity).
- `src/commands/shell.ts:1094` selects OpenTUI when `flags.wantTui && modeFlag
  !== false && process.stdout.isTTY` — note the middle clause: `--chat` sets
  `modeFlag = false`, so chat never reaches the TUI.
- `src/commands/agent-commands.ts` — the promoted command registry with the pure
  `filterCommands` / `findAgentCommand` helpers (flow 062). It currently has one
  consumer; PRD F1's "chat and agent share definitions" is open item O-2.
- `@opentui/core` declared under `optionalDependencies`, loaded via dynamic
  `import()` with a readline fallback. ADR-0005 is **Accepted (Phase 1)** and its
  guard update landed — the package is pinned in the optional-dependency set at
  `src/testing/block-d-no-network.test.ts:82`.
- Headless render tests: `src/tui/tui-shell.test.ts`.

Beyond the original Phase 0–5 scope, the TUI also gained side-workers
(`src/tui/side-worker.ts`, `worker-fleet.ts`), multi-agent spawn wiring
(`subagent-bridge.ts`, `ask-user-bridge.ts`), and dual-store session persistence
(`/compact`, `/resume`, `/continue`). These were added after the spec was written
and are not normatively described here; cite the flow numbers if a follow-on
requirements package is split out.

The foundation this package builds on — the port-based agent driver
(`src/commands/agent.ts` `runAgentTurn`), the `AgentIO`/`ShellIO` hook surface,
and the pure render helpers (flows 033, 048–057) — carried over as planned. The
driver and hook surface are unchanged by diff; the pure helper *layer* has since
been extended by flow 109, recorded as decision **D-6**.

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
- **Risk R1 (native dependency) — resolved.** Prebuilt per-platform binary via npm
  optionalDependencies, no Zig at install; MIT. darwin-arm64 confirmed in the
  Phase 0 spike, other targets confirm as exercised. Ratified in ADR-0005, which
  also pins the optional-dependency contract (dynamic `import()` only, mandatory
  fallback, zero-`dependencies` floor untouched).
- **Risk R2 (scrollback) — resolved, cost accepted.** Alternate-screen mode was
  chosen, forfeiting native terminal scrollback as codex/claude do. Copy is served
  instead by OSC-52 (mouse selection, and `y` on a focused block since flow 109),
  and losing scrollback is precisely why flow 109's decision D-5 has to preserve
  the scroll offset when a block expands.
- **Risk R3 (rewrite surface) — held.** Every flow-050–057 feature was re-homed
  without regression, with the logic kept in pure unit-tested helpers. The one
  qualification: that helper layer is no longer frozen — see decision **D-6**.

See `prd.md` for goals, requirements, success criteria, and the phased roadmap;
`specification.md` for the technical architecture, the AgentIO→component mapping,
and the Phase 0 spike plan.
