# Flow 052 — agent-mode UI redesign (codex/grok/pi aesthetic)

## Problem
User screenshot shows: (1) a duplicate prompt `❯ ❯` before the first input —
`printHeader` prints a prompt AND `runAgentRepl` prints another; (2) a heavy
double-cyan-ruled `banner()` header; (3) inconsistent, verbose role labeling. The
user asked to base the look on the codex / grok / pi CLIs (minimal header, single
clean prompt, understated role markers, whitespace over rules).

## Approach (line-based, readline-safe — no full-screen/alt-screen)
- Remove the duplicate initial prompt in `runAgentRepl`.
- Replace `banner()` in `printHeader` with a one-line header: accent glyph + bold
  "keryx" + dim `provider/model · mode · cwd`, a dim hint, blank line, prompt.
- Unify the assistant header to `● keryx` (accent dot + bold label) in both
  agent mode and chat `onTurnStart`; leave `roleLabel` (and its test) untouched.
- Lean on whitespace for turn separation; keep the token line dim.

## Out of scope
A persistent bottom-anchored bordered composer (needs alt-screen/full-screen
which fights node:readline + scrollback — the flow-048 class of bug), theme
switching, chat-core semantics.
