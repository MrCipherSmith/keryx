# Stale-queue repro, re-run at head e11b8eb5

Script: stale-queue-repro.ts in this directory (imports the worktree's src/tui/main-queue.ts; run with `bun run` from /home/altsay/keryx-fdm-t3).
The drain is built with the shell's getter form, `queue: () => mainQueue` (tui-shell.ts:7963). The round-2 form was `queue: mainQueue`.

| Scenario | Result at e11b8eb5 | Round-2 result |
|---|---|---|
| control, no reassign: push a, b, settle | ran [a], live queue [b] | same |
| remove line 1 of [a, b], settle | ran [b], live queue [] (the removed `a` does not run) | ran [a] (removed line ran) |
| push a, remove it, push b, settle | ran [b] (a line queued after the replacement runs) | ran [a], b never taken |
| force-style reassign on [x], push b, settle | ran [x] once; b waits behind the turn x started | x ran twice |
| remove all, settle | ran [], one onSettle (bus wake) | no wake |

Verdict: F-016 closed by execution. The five scenarios behave correctly with the getter.
