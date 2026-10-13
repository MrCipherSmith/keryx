# Mutation pass

Command: `bun test src/tui/turn-loop.test.ts src/tui/busy-dispatch.test.ts src/tui/main-queue.test.ts src/tui/main-queue-drain.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-hold.test.ts src/tui/tui-bus.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 6987 ms). Run in a scratch copy; the worktree was not written.

Killed 9, survived 3, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N01-whileBusy-no-return | src/tui/tui-shell.ts:8592 | `if (turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source)) return;` → `turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source);` | killed |
| N02-held-busy-notice-q1 | src/tui/tui-shell.ts:8626 | `queued as q${position} (no side worker while held).` → `queued as q1 (no side worker while held).` | killed |
| N03-held-idle-notice-q1 | src/tui/tui-shell.ts:9438 | `queued as q${position}.\n`);` → `queued as q1.\n`);` | killed |
| N10-sessionState-queued-zero | src/tui/tui-shell.ts:10163 | `queued: turnLoop.queue.length,` → `queued: 0,` | killed |
| N12-enqueue-source-undefined-key | src/tui/turn-loop.ts:73 | `...(source !== undefined ? { source } : {})` → `source` | survived |
| N14-queue-getter-copy | src/tui/turn-loop.ts:101 | `get queue() {       return queue;` → `get queue() {       return [...queue];` | survived |
| N16b-remote-paint-noop | src/tui/turn-loop.ts:84 | `nextId,     paint: deps.paint,` → `nextId,     paint: () => {},` | killed |
| N21-held-notice-banner-dropped | src/tui/tui-shell.ts:8626 | `${leaseView()?.banner() ?? "held"} — queued as q${position} (no side worker while held).` → `held — queued as q${position} (no side worker while held).` | survived |
| M08-shell-sessionState-mode | src/tui/tui-shell.ts:10163 | `sessionState: () => ({ queued: turnLoop.queue.length, mode: formatModeInForce(modeForTurn(true)) }),` → `sessionState: () => ({ queued: turnLoop.queue.length, mode: formatModeInForce(modeForTurn(false)) }),` | killed |
| P01-idle-and-to-or-1 | src/tui/tui-shell.ts:8671 | `!destroyed &&                 !chrome.isBusy() &&` → `!destroyed \|\|                 !chrome.isBusy() &&` | killed |
| P02-idle-and-to-or-lease | src/tui/tui-shell.ts:8674 | `!forceHandoff.isAwaitingSettlement &&                 leaseView()?.held() !== true,` → `!forceHandoff.isAwaitingSettlement \|\|                 leaseView()?.held() !== true,` | killed |
| P03-settle-drain-conditional | src/tui/tui-shell.ts:9941 | `drainSites.onTurnSettle();` → `if (Date.now() < 0) drainSites.onTurnSettle();` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
