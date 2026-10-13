# Mutation pass

Command: `bun test src/tui/main-queue-drain.test.ts src/tui/main-queue.test.ts src/tui/tui-bus.test.ts src/tui/tui-hold.test.ts src/tui/remote-queue-wiring.test.ts` (baseline exit 0, 345 ms). Run in a scratch copy; the worktree was not written.

Killed 17, survived 5, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-drainNext-budget-without-forced-slot | src/tui/main-queue.ts:213 | `budget = options.pending() + 1;` → `budget = options.pending();` | killed |
| M02-drainNext-never-stops-on-busy | src/tui/main-queue.ts:218 | `    if (options.isBusy()) return "started"; ` → ` ` | killed |
| M03-drainNext-no-paint | src/tui/main-queue.ts:215 | `    options.paint(); ` → ` ` | killed |
| M04-drainNext-empty-take-reports-started | src/tui/main-queue.ts:216 | `if (next === undefined) return "drained";` → `if (next === undefined) return "started";` | killed |
| M05-drainNext-budget-spent-reports-started | src/tui/main-queue.ts:218 | `    if (options.isBusy()) return "started";   }   return "drained";` → `    if (options.isBusy()) return "started";   }   return "started";` | survived |
| M06-settle-wakes-bus-only-never-gated-on-drained | src/tui/main-queue.ts:244 | `if (deps.drain() === "drained") deps.onSettle();` → `deps.drain();       deps.onSettle();` | killed |
| M07-settle-never-wakes-bus | src/tui/main-queue.ts:244 | `if (deps.drain() === "drained") deps.onSettle();` → `deps.drain();` | killed |
| M08-settle-ignores-pending-handoff | src/tui/main-queue.ts:242 | `    onTurnSettle() {       if (deps.isAwaitingSettlement()) return; ` → `    onTurnSettle() { ` | killed |
| M09-operation-complete-ignores-pending-handoff | src/tui/main-queue.ts:238 | `    onForegroundOperationComplete() {       if (deps.isAwaitingSettlement()) return; ` → `    onForegroundOperationComplete() { ` | killed |
| M10-lease-release-guards-only-handoff | src/tui/main-queue.ts:247 | `      if (deps.isBusy()) return;       deps.drain();` → `      if (deps.isAwaitingSettlement()) return;       deps.drain();` | killed |
| M11-lease-release-drains-while-busy | src/tui/main-queue.ts:247 | `      if (deps.isBusy()) return;       deps.drain();` → `      deps.drain();` | killed |
| M12-shell-queue-work-ignores-handoff | src/tui/tui-shell.ts:7962 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement;` → `chrome.isBusy() \|\| foregroundOperation.isActive;` | killed |
| M13-shell-queue-work-ignores-foreground-operation | src/tui/tui-shell.ts:7962 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement;` → `chrome.isBusy() \|\| forceHandoff.isAwaitingSettlement;` | killed |
| M14-shell-queue-work-ignores-chrome-busy | src/tui/tui-shell.ts:7962 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement;` → `foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement;` | killed |
| M15-shell-take-queue-before-forced | src/tui/tui-shell.ts:7966 | `take: () => forceHandoff.takeNext() ?? mainQueue.shift(),` → `take: () => mainQueue.shift() ?? forceHandoff.takeNext(),` | killed |
| M16-shell-pending-always-zero | src/tui/tui-shell.ts:7967 | `pending: () => mainQueue.length,` → `pending: () => 0,` | survived |
| M17-shell-drain-does-not-paint | src/tui/tui-shell.ts:7968 | `paint: paintMainQueue,` → `paint: () => {},` | survived |
| M18-shell-awaiting-settlement-never | src/tui/tui-shell.ts:7972 | `isAwaitingSettlement: () => forceHandoff.isAwaitingSettlement,` → `isAwaitingSettlement: () => false,` | survived |
| M19-shell-bus-wake-dropped | src/tui/tui-shell.ts:7974 | `onSettle: () => busWakeController?.onSettle(),` → `onSettle: () => undefined,` | killed |
| M20-shell-turn-settle-site-deleted | src/tui/tui-shell.ts:9942 | `        drainSites.onTurnSettle(); ` → ` ` | killed |
| M21-shell-operation-complete-site-deleted | src/tui/tui-shell.ts:9634 | `                  drainSites.onForegroundOperationComplete(); ` → ` ` | survived |
| M22-shell-lease-release-site-wired-to-settle | src/tui/tui-shell.ts:10023 | `onRelease: () => drainSites.onLeaseRelease(),` → `onRelease: () => drainSites.onTurnSettle(),` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
