# Flow 048 — fix shell rendering (remove pinned status bar)

Status: formalized
Source: user bug report (screenshots): in a real terminal the input line collides
with the pinned status bar and assistant output is lost ("thinking… → blank →
initial state"). Driven via flow-orchestrator.

## Problem

The flow-032 pinned status bar uses an ANSI scroll-region (DECSTBM) reserving the
bottom terminal row. `node:readline` (the shell's line editor) assumes it owns the
full terminal and draws the input prompt/echo on the bottom row — ON TOP of the
status bar. The scroll-region + per-turn bar redraw also clobber streamed assistant
output. Net effect: unusable interactive shell (input over the bar; no visible
reply). readline and a manual DECSTBM bar fundamentally do not cooperate.

## Expected Outcome

1. The pinned scroll-region status bar is REMOVED from the interactive shell
   (createRichIo no longer enters/draws/exits a DECSTBM region; no SIGWINCH/exit
   scroll-region handlers). No terminal row is reserved; readline owns the screen.
2. The working directory, provider, and model are shown in the one-time HEADER
   instead (e.g. `openrouter/openai/gpt-4o-mini · agent · ~/goodea/keryx`), so the
   context is still visible without the readline conflict.
3. Header, colored `❯` prompt, `thinking…` spinner, live streaming, markdown, and
   agent tool rendering all keep working; the chat `runShell` core is untouched.

## Out of Scope

- No change to the agent driver, tools, providers, or the chat core. The pure
  statusbar.ts formatter may be reused for the header line; the scroll-region
  helpers become unused. No new dependency.
