# Keryx OpenTUI Interactive Shell PRD
Version: 0.1.0

## Problem

The keryx interactive shell (`keryx shell`, chat + `--agent`) renders through
`node:readline` in line mode: it reads a whole line on Enter and lets the terminal
handle echo and editing. This is robust and preserves native scrollback, but it
**cannot** present a live, as-you-type interface — most concretely, the
Pi/grok-style `/` command dropdown that filters while you type. Two attempts at
in-place, keystroke-driven rendering over readline (the flow-032 status bar, the
flow-051 differential streamer) confirmed the ceiling: anything that must own the
cursor while readline also owns the line is fragile (flow 048 removed the status
bar for exactly this reason).

Pi (`earendil-works/pi`) and xAI's grok-build (`xai-org/grok-build`) achieve the
live composer because they are **full-screen TUIs that own the terminal** and
repaint on every keystroke. To match that UX, keryx needs a render/input layer
that owns the terminal — an architectural change, not a package. OpenTUI provides
that layer, is Bun-native (keryx runs on Bun), ships prebuilt native binaries, and
is already proven in a coding-agent TUI (`superagent-ai/grok-cli`).

## Goals

- **G1:** A live command composer in the interactive shell — typing `/` opens a
  filtered command dropdown that narrows as you type; Enter/Tab selects; Esc
  dismisses. Parity with Pi's discoverability.
- **G2:** A persistent, full-screen shell layout: a scrollable transcript region
  plus a fixed input composer, with the existing chrome (styled role headers,
  gutter, streamed markdown, tool-call + collapsible output, reasoning section,
  token usage) re-homed onto OpenTUI components with NO feature regression vs.
  flows 050–057.
- **G3:** Zero change to the deterministic agent driver (`runAgentTurn`), the
  metaproject port, providers, policy, and the pure render helpers. OpenTUI is
  presentation only; the driver keeps talking to the same `AgentIO` hooks.
- **G4:** Safe rollout: ship behind an opt-in `--tui` flag, stabilise, then make it
  the default and retire the readline path only once at parity.
- **G5:** Portability preserved: the native dependency must install cleanly through
  keryx's existing `scripts/install.sh --global` (Bun) path on the supported
  platforms, with a graceful fallback to the readline shell when the TUI can't
  initialise (no TTY, unsupported platform, load failure).

## Non-goals

- Changing agent/tool/policy/provider semantics or the harness core.
- Mouse-driven interaction, editor embedding, or the Agent Client Protocol.
- A theming system beyond the current single accent (deferred).
- Rewriting chat-core history/turn semantics.

## Users and primary scenarios

- **Interactive operator** (the primary user): runs `keryx shell` in a terminal,
  wants discoverable commands (`/`), a clean persistent composer, live markdown,
  and readable tool/reasoning output.
- **CI / non-TTY / piped** consumer: must keep working — when there is no TTY (or
  `NO_COLOR`, or an unsupported platform), keryx falls back to the current
  line-based renderer with identical, escape-free output.

## Requirements

### Functional

- **F1 — Command composer:** an input area that, on `/`, shows a dropdown of
  `AGENT_SLASH_COMMANDS` (name + description) filtered by the typed prefix;
  ↑/↓ to move, Enter/Tab to accept, Esc to close. Reuses a shared command registry
  (the flow-058 registry, promoted here) so chat and agent share definitions.
- **F2 — Transcript region:** a scrollable region rendering the conversation:
  user turns, `● keryx` assistant headers, live-streamed markdown, `⚙ tool(args)`
  calls with collapsible output (`/expand` equivalent, or inline expand), the dim
  `⋯ thinking` reasoning section, and the `↑in ↓out tokens` line.
- **F3 — Driver hooks unchanged:** the OpenTUI renderer implements the existing
  `AgentIO` (write/onAssistantText/onReasoning/onUsage/onToolCall/onToolResult/
  onSystem/requestApproval) and `ShellIO` contracts; `runAgentTurn`/`runShell` are
  called exactly as today.
- **F4 — Approval prompt:** the default-deny `shell_exec` approval renders as a
  modal/inline confirm in the composer, preserving the flow-041 blast-radius
  context and the default-deny gate.
- **F5 — Fallback:** `--tui` (or default, once promoted) attempts OpenTUI; on no
  TTY / unsupported platform / init failure, transparently falls back to the
  readline shell. A `--no-tui`/`--chat`-style escape hatch remains.

### Non-functional

- **N1 — Portability:** prebuilt native binaries cover keryx's target platforms
  (darwin-arm64, darwin-x64, linux-x64, linux-arm64 at minimum); the install path
  pulls them; no Zig toolchain required at end-user install.
- **N2 — Determinism/testability:** all rendering LOGIC stays in pure, unit-tested
  helpers (already true for markdown/gutter/collapse/args/reasoning); OpenTUI
  components are thin presentation and are validated by a small set of headless
  render/snapshot checks, not by driving a real TTY.
- **N3 — Performance:** streaming repaint stays smooth for long outputs (OpenTUI's
  buffered renderer replaces the hand-rolled flow-051 differ).
- **N4 — No policy weakening:** the approval/default-deny path and egress gates are
  untouched (ADR-0003 holds).

## Success criteria

- Typing `/` in `keryx shell --tui` shows a live, filtering command dropdown;
  selection runs the command. (G1/F1)
- Every flow-050–057 feature is visible and correct in the TUI transcript; a
  feature-parity checklist passes. (G2/F2)
- `runAgentTurn` and the pure helpers are unchanged by diff; the TUI is a new IO
  implementation only. (G3)
- `keryx shell` with no TTY / on an unsupported platform falls back to the
  readline shell with byte-identical plain output. (G5/F5)
- `bunx tsc --noEmit` clean; `bun test` ≥ baseline with new headless render tests;
  a global install via `scripts/install.sh --global` launches the TUI on a
  supported platform. (N1/N2)

## Risks and open questions (Phase 0 spike resolves these)

- **R1 (native install):** confirm `@opentui/core` ships prebuilt binaries for all
  target platforms and that `bun`/`scripts/install.sh --global` pulls them without
  a Zig toolchain. GATE: if not, reconsider (Ink fallback, or vendor binaries).
- **R2 (scrollback vs fullscreen):** determine OpenTUI's inline vs alt-screen
  modes; decide whether to accept losing native scrollback (as codex/claude do) or
  use an inline mode. Affects F2.
- **R3 (component API):** confirm the exact primitives for a text input + a select/
  list dropdown + a scrollable region, keyboard/focus handling, and resize.
- **R4 (license):** confirm `@opentui/core` license is compatible before adding it.
- **R5 (bundle size / startup latency):** measure cold-start of the TUI vs the
  current instant readline shell.

## Phased implementation roadmap

- **Phase 0 — Spike (de-risk, ~1 flow):** add `@opentui/core` in a throwaway
  branch; build a minimal `keryx shell --tui` that renders a static transcript +
  an input with a live `/` dropdown over 3–4 dummy commands; validate R1–R5.
  Decision gate: proceed, adjust, or fall back to Ink. Output: a spike report +
  the confirmed component/API mapping.
- **Phase 1 — Renderer skeleton:** an OpenTUI `TuiShell` implementing `ShellIO`/
  `AgentIO` with the transcript region + composer; wire `runShell`/`runAgentTurn`;
  plain text only (no markdown/tools yet); `--tui` opt-in; readline fallback.
- **Phase 2 — Chrome parity:** re-home markdown streaming, gutter, role headers,
  tool call + collapsible output, reasoning section, usage line, turn separators —
  reusing the pure helpers. Feature-parity checklist.
- **Phase 3 — Command composer:** the live `/` dropdown (F1) + the shared command
  registry + `/clear`, `/expand`, `/help`, `/exit` and any new commands.
- **Phase 4 — Approval + edge cases:** modal/inline approval (F4), resize, no-TTY
  fallback (F5), long-output performance (N3).
- **Phase 5 — Promote to default:** make TUI the default on supported TTYs; keep
  `--no-tui` and automatic fallback; retire the readline agent path only after a
  parity sign-off (keep the chat readline core until then).

Each phase is a keryx flow with frozen ACs; Phase 0's gate decision is recorded in
memory before Phase 1 starts.
