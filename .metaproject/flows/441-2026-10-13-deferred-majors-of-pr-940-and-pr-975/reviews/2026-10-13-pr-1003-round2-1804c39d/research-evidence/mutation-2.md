# Mutation pass

Command: `bun test src/tui/turn-loop.test.ts src/tui/busy-dispatch.test.ts src/tui/main-queue.test.ts src/tui/main-queue-drain.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-hold.test.ts src/tui/tui-bus.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 6963 ms). Run in a scratch copy; the worktree was not written.

Killed 13, survived 6, timeout 0, invalid 1.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N01-whileBusy-no-return | src/tui/tui-shell.ts:8592 | `if (turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source)) return;` → `turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source);` | survived |
| N02-held-busy-notice-q1 | src/tui/tui-shell.ts:8626 | `queued as q${position} (no side worker while held).` → `queued as q1 (no side worker while held).` | survived |
| N03-held-idle-notice-q1 | src/tui/tui-shell.ts:9438 | `queued as q${position}.\n`);` → `queued as q1.\n`);` | survived |
| N04-idle-no-destroyed | src/tui/tui-shell.ts:8671 | `!destroyed &&                 !chrome.isBusy() &&` → `!chrome.isBusy() &&` | killed |
| N05-idle-no-busy | src/tui/tui-shell.ts:8672 | `!chrome.isBusy() &&                 !foregroundOperation.isActive &&                 !forceHandoff` → `!foregroundOperation.isActive &&                 !forceHandoff` | killed |
| N06-idle-no-foreground | src/tui/tui-shell.ts:8673 | `!foregroundOperation.isActive &&                 !forceHandoff.isAwaitingSettlement &&                 leaseView` → `!forceHandoff.isAwaitingSettlement &&                 leaseView` | killed |
| N07-idle-no-awaiting | src/tui/tui-shell.ts:8674 | `!forceHandoff.isAwaitingSettlement &&                 leaseView()?.held() !== true,` → `leaseView()?.held() !== true,` | killed |
| N08-idle-no-lease | src/tui/tui-shell.ts:8674 | `!forceHandoff.isAwaitingSettlement &&                 leaseView()?.held() !== true,` → `!forceHandoff.isAwaitingSettlement,` | killed |
| N09-enqueue-returns-len-minus-1 | src/tui/turn-loop.ts:70 | `deps.paint();     return queue.length;` → `deps.paint();     return queue.length - 1;` | killed |
| N10-sessionState-queued-zero | src/tui/tui-shell.ts:10163 | `queued: turnLoop.queue.length,` → `queued: 0,` | survived |
| N11-idle-dispatch-run-before-paint | src/tui/turn-loop.ts:115 | `deps.paint();           remote.runQueued(next);` → `remote.runQueued(next);           deps.paint();` | killed |
| N12-enqueue-source-undefined-key | src/tui/turn-loop.ts:69 | `...(source !== undefined ? { source } : {})` → `source` | survived |
| N13-seq-starts-1 | src/tui/turn-loop.ts:65 | `let seq = 0;` → `let seq = 1;` | killed |
| N14-queue-getter-copy | src/tui/turn-loop.ts:97 | `get queue() {       return queue;` → `get queue() {       return [...queue];` | survived |
| N15-recipient-enqueue-gains-source | src/tui/tui-shell.ts:8665 | `turnLoop.enqueue(line, displayLine);             // The recipient choice` → `turnLoop.enqueue(line, displayLine, source);             // The recipient choice` | killed |
| N16-remote-paint-noop | src/tui/turn-loop.ts | `paint: deps.paint,     runLine` → `paint: () => {},     runLine` | invalid (anchor not found) |
| N17-remote-say-noop | src/tui/turn-loop.ts:82 | `say: deps.say,` → `say: () => {},` | killed |
| N18-remote-runLine-noop | src/tui/turn-loop.ts:83 | `runLine: deps.runLine,` → `runLine: (() => undefined) as never,` | killed |
| N19-drain-paint-noop | src/tui/turn-loop.ts:88 | `queue: () => queue,     paint: deps.paint,` → `queue: () => queue,     paint: () => {},` | killed |
| N20-whileBusy-notice-position-plus-1 | src/tui/turn-loop.ts:107 | `deps.say(`${queuedCommandNotice(position)}\n`);` → `deps.say(`${queuedCommandNotice(position + 1)}\n`);` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
