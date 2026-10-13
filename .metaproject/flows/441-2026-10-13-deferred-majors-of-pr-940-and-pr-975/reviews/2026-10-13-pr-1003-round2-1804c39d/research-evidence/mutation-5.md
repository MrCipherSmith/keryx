# Mutation pass

Command: `bun test src/tui/turn-loop.test.ts src/tui/busy-dispatch.test.ts src/tui/main-queue.test.ts src/tui/main-queue-drain.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-hold.test.ts src/tui/tui-bus.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 7127 ms). Run in a scratch copy; the worktree was not written.

Killed 0, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| P01-idle-and-to-or-1 | src/tui/tui-shell.ts:8671 | `!destroyed &&                 !chrome.isBusy() &&` → `!destroyed \|\|                 !chrome.isBusy() &&` | survived |
| P02-idle-and-to-or-lease | src/tui/tui-shell.ts:8674 | `!forceHandoff.isAwaitingSettlement &&                 leaseView()?.held() !== true,` → `!forceHandoff.isAwaitingSettlement \|\|                 leaseView()?.held() !== true,` | survived |
| P03-settle-drain-conditional | src/tui/tui-shell.ts:9941 | `drainSites.onTurnSettle();` → `if (Date.now() < 0) drainSites.onTurnSettle();` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
