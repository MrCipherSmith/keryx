# Implementation Plan

Status: formalized

## Approach

Strip the scroll-region status-bar machinery from createRichIo/shellCommand/
runAgentRepl and move cwd into printHeader. Keep write/onTurnStart/onTurnEnd/
onSystem/printHeader/printPrompt/spinner/streaming.

## Steps

1. shell.ts createRichIo: remove enterBar/exitBar/redrawBar/drawBar, the
   scroll-region enter/exit, SIGWINCH/SIGINT/exit handlers, and the getStatus
   status source. Keep the rest.
2. printHeader: append the cwd (collapseHome(process.cwd())) to the subtitle.
3. shellCommand: drop enterBar()/exitBar() and the status-source plumbing; the
   agent branch still injects the MetaprojectPort for approval context.
4. runAgentRepl: drop redrawBar() calls.
5. Keep statusbar.ts (pure formatter reused for the header; scrollRegion may be
   left unused or dropped). Update/trim flow-032 statusbar tests only as needed.

## Risks

- Terminal-specific readline behavior — removing the reserved row is the robust
  path (readline regains full control). Verified by a live smoke.
