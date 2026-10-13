# Mutation pass

Command: `bun test src/tui/main-queue-drain.test.ts src/tui/main-queue.test.ts src/tui/tui-bus.test.ts src/tui/tui-hold.test.ts src/tui/remote-queue-wiring.test.ts src/tui/foreground-operation.test.ts src/tui/busy-dispatch.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 6928 ms). Run in a scratch copy; the worktree was not written.

Killed 36, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N01-budget-short-by-one | src/tui/main-queue.ts:218 | `for (let budget = options.pending(); budget > 0; budget--)` → `for (let budget = options.pending() - 1; budget > 0; budget--)` | killed |
| N02-budget-extra-slot | src/tui/main-queue.ts:218 | `for (let budget = options.pending(); budget > 0; budget--)` → `for (let budget = options.pending() + 1; budget > 0; budget--)` | killed |
| N03-never-stops-on-busy | src/tui/main-queue.ts:224 | `    if (options.isBusy()) return "started"; ` → ` ` | killed |
| N04-no-paint | src/tui/main-queue.ts:221 | `    options.paint(); ` → ` ` | killed |
| N05-empty-take-reports-started | src/tui/main-queue.ts:222 | `if (next === undefined) return "empty";` → `if (next === undefined) return "started";` | killed |
| N07-no-self-requeue-stop | src/tui/main-queue.ts:225 | `    if (options.pending() >= before) return "exhausted"; ` → ` ` | killed |
| N08-self-requeue-stop-strict | src/tui/main-queue.ts:225 | `if (options.pending() >= before) return "exhausted";` → `if (options.pending() > before) return "exhausted";` | killed |
| N12-settle-ignores-handoff | src/tui/main-queue.ts:289 | `    onTurnSettle() {       if (deps.forced.isAwaitingSettlement) return; ` → `    onTurnSettle() { ` | killed |
| N13-operation-complete-ignores-handoff | src/tui/main-queue.ts:285 | `    onForegroundOperationComplete() {       if (deps.forced.isAwaitingSettlement) return; ` → `    onForegroundOperationComplete() { ` | killed |
| N16-lease-release-site-empty | src/tui/main-queue.ts:293 | `onLeaseRelease: drainWhenIdle,` → `onLeaseRelease() {},` | killed |
| N20-paint-dropped | src/tui/main-queue.ts:273 | `paint: deps.paint,` → `paint: () => {},` | killed |
| N23-final-return-exhausted | src/tui/main-queue.ts:227 | `so the count is now zero   return "empty";` → `so the count is now zero   return "exhausted";` | killed |
| N24-budget-steps-by-two | src/tui/main-queue.ts:218 | `budget > 0; budget--) {     const before` → `budget > 0; budget -= 2) {     const before` | killed |
| F01-detach-end-only-on-success | src/tui/main-queue.ts:300 | `work.then(end, end);` → `work.then(end);` | killed |
| F02-detach-counter-never-lowered | src/tui/main-queue.ts:297 | `        detached -= 1; ` → ` ` | killed |
| F03-detach-counter-never-raised | src/tui/main-queue.ts:295 | `      detached += 1; ` → ` ` | killed |
| F04-in-flight-ignores-detached | src/tui/main-queue.ts:268 | `deps.workInFlight() \|\| detached > 0` → `deps.workInFlight()` | killed |
| F05-take-from-stale-queue | src/tui/main-queue.ts:271 | `deps.queue().shift()` → `(deps.queue.c ??= deps.queue()).shift()` | killed |
| F06-pending-from-stale-queue | src/tui/main-queue.ts:272 | `deps.forced.pendingCount + deps.queue().length` → `deps.forced.pendingCount + (deps.queue.c ??= deps.queue()).length` | survived |
| F07-no-wake-on-empty | src/tui/main-queue.ts:277 | `if (outcome === "empty") deps.onSettle();` → `` | killed |
| F08-wake-always | src/tui/main-queue.ts:277 | `if (outcome === "empty") deps.onSettle();` → `deps.onSettle();` | killed |
| F09-turn-settle-ignores-handoff | src/tui/main-queue.ts:289 | `    onTurnSettle() {       if (deps.forced.isAwaitingSettlement) return;` → `    onTurnSettle() {` | killed |
| F10-op-complete-ignores-handoff | src/tui/main-queue.ts:285 | `    onForegroundOperationComplete() {       if (deps.forced.isAwaitingSettlement) return;` → `    onForegroundOperationComplete() {` | killed |
| F11-idle-drain-ignores-flight | src/tui/main-queue.ts:281 | `    if (workInFlight()) return;     drain();` → `    drain();` | killed |
| F12-lease-release-noop | src/tui/main-queue.ts:293 | `onLeaseRelease: drainWhenIdle,` → `onLeaseRelease() {},` | killed |
| F13-detach-end-no-drain | src/tui/main-queue.ts:297 | `        detached -= 1;         drainWhenIdle();` → `        detached -= 1;` | killed |
| F14-busy-ignores-detached | src/tui/main-queue.ts:275 | `isBusy: workInFlight,` → `isBusy: deps.workInFlight,` | killed |
| F15-wake-after-detach-drops | src/tui/main-queue.ts:298 | `        drainWhenIdle();       };` → `        if (workInFlight()) return;         deps.queue().shift();       };` | killed |
| H01-bus-idle-ignores-flight | src/tui/tui-shell.ts:9993 | `        !drainSites.workInFlight() &&         mainQueue.length === 0 &&` → `        mainQueue.length === 0 &&` | killed |
| H02-bus-idle-ignores-queue | src/tui/tui-shell.ts:9994 | `        mainQueue.length === 0 &&         leaseView()?.held() !== true,` → `        leaseView()?.held() !== true,` | killed |
| H03-shell-queue-stale | src/tui/tui-shell.ts:7963 | `queue: () => mainQueue,` → `queue: ((c) => () => c)(mainQueue),` | killed |
| H04-detach-bypassed | src/tui/tui-shell.ts:7971 | `=> drainSites.detach(work);` → `=> void work;` | killed |
| H05-onsettle-dropped | src/tui/tui-shell.ts:7967 | `onSettle: () => busWakeController?.onSettle(),` → `onSettle: () => {},` | killed |
| H06-in-flight-drops-handoff | src/tui/tui-shell.ts:7966 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement,       onSettle` → `chrome.isBusy() \|\| foregroundOperation.isActive,       onSettle` | killed |
| H07-lease-release-dropped | src/tui/tui-shell.ts:10015 | `onRelease: () => drainSites.onLeaseRelease(),` → `onRelease: () => {},` | killed |
| H08-turn-settle-dropped | src/tui/tui-shell.ts:9935 | `      drainSites.onTurnSettle(); ` → ` ` | killed |
| H09-op-complete-dropped | src/tui/tui-shell.ts:9630 | `                  drainSites.onForegroundOperationComplete(); ` → ` ` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
