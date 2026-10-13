# Mutation pass

Command: `bun test src/tui/main-queue-drain.test.ts src/tui/main-queue.test.ts src/tui/busy-dispatch.test.ts src/tui/foreground-operation.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-bus.test.ts src/tui/tui-hold.test.ts src/tui/tui-shell.test.ts src/tui/bus-wake.test.ts` (baseline exit 0, 551 ms). Run in a scratch copy; the worktree was not written.

Killed 35, survived 1, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| M01-detach-counter-reset-to-zero | src/tui/main-queue.ts:297 | `        detached -= 1;         drainWhenIdle();` → `        detached = 0;         drainWhenIdle();` | survived |
| M02-detach-rejection-unhandled | src/tui/main-queue.ts:300 | `      work.then(end, end);` → `      void work.then(end);` | killed |
| M03-detach-counter-not-raised | src/tui/main-queue.ts:295 | `      detached += 1; ` → ` ` | killed |
| M04-in-flight-ignores-detached | src/tui/main-queue.ts:268 | `const workInFlight = (): boolean => deps.workInFlight() \|\| detached > 0;` → `const workInFlight = (): boolean => deps.workInFlight();` | killed |
| M05-in-flight-ignores-shell-predicate | src/tui/main-queue.ts:268 | `const workInFlight = (): boolean => deps.workInFlight() \|\| detached > 0;` → `const workInFlight = (): boolean => detached > 0;` | killed |
| M06-queue-captured-once | src/tui/main-queue.ts:267 | `  let detached = 0; ` → `  let detached = 0;   const frozenQueue = deps.queue();   deps = { ...deps, queue: () => frozenQueue }; ` | killed |
| M07-settle-also-on-exhausted | src/tui/main-queue.ts:277 | `if (outcome === "empty") deps.onSettle();` → `if (outcome !== "started") deps.onSettle();` | killed |
| M08-settle-never-fires | src/tui/main-queue.ts:277 | `    if (outcome === "empty") deps.onSettle(); ` → ` ` | killed |
| M09-settle-fires-on-every-drain | src/tui/main-queue.ts:277 | `if (outcome === "empty") deps.onSettle();` → `deps.onSettle();` | killed |
| M10-idle-drain-unguarded | src/tui/main-queue.ts:281 | `    if (workInFlight()) return;     drain();` → `    drain();` | killed |
| M11-idle-drain-ignores-detached | src/tui/main-queue.ts:281 | `    if (workInFlight()) return;     drain();` → `    if (deps.workInFlight()) return;     drain();` | killed |
| M12-drainnext-busy-ignores-detached | src/tui/main-queue.ts:275 | `      isBusy: workInFlight,` → `      isBusy: deps.workInFlight,` | killed |
| M13-turn-settle-ignores-handoff | src/tui/main-queue.ts:289 | `    onTurnSettle() {       if (deps.forced.isAwaitingSettlement) return; ` → `    onTurnSettle() { ` | killed |
| M14-operation-complete-ignores-handoff | src/tui/main-queue.ts:285 | `    onForegroundOperationComplete() {       if (deps.forced.isAwaitingSettlement) return; ` → `    onForegroundOperationComplete() { ` | killed |
| M15-lease-release-drains-unguarded | src/tui/main-queue.ts:293 | `    onLeaseRelease: drainWhenIdle,` → `    onLeaseRelease: drain,` | killed |
| M16-detach-end-drains-before-lowering | src/tui/main-queue.ts:297 | `        detached -= 1;         drainWhenIdle();` → `        drainWhenIdle();         detached -= 1;` | killed |
| M17-queue-before-forced | src/tui/main-queue.ts:271 | `deps.forced.takeNext() ?? deps.queue().shift()` → `deps.queue().shift() ?? deps.forced.takeNext()` | killed |
| M18-pending-ignores-forced | src/tui/main-queue.ts:272 | `deps.forced.pendingCount + deps.queue().length` → `deps.queue().length` | killed |
| M19-detach-lowers-counter-synchronously | src/tui/main-queue.ts:300 | `      work.then(end, end);` → `      void work;       end();` | killed |
| M20-detach-rejection-never-lowers-counter | src/tui/main-queue.ts:300 | `      work.then(end, end);` → `      work.then(end, () => undefined);` | killed |
| M21-paint-dropped | src/tui/main-queue.ts:273 | `      paint: deps.paint,` → `      paint: () => {},` | killed |
| M22-detach-end-skips-drain | src/tui/main-queue.ts:297 | `        detached -= 1;         drainWhenIdle();` → `        detached -= 1;` | killed |
| M23-drain-budget-short-by-one | src/tui/main-queue.ts:218 | `for (let budget = options.pending(); budget > 0; budget--)` → `for (let budget = options.pending() - 1; budget > 0; budget--)` | killed |
| M24-drainnext-empty-reports-started | src/tui/main-queue.ts:222 | `    if (next === undefined) return "empty";` → `    if (next === undefined) return "started";` | killed |
| S01-bus-idle-reads-chrome-only | src/tui/tui-shell.ts:9993 | `        !drainSites.workInFlight() &&         mainQueue.length === 0 &&` → `        !chrome.isBusy() &&         mainQueue.length === 0 &&` | killed |
| S02-queue-getter-returns-copy | src/tui/tui-shell.ts:7963 | `      queue: () => mainQueue,` → `      queue: () => [...mainQueue],` | killed |
| S03-shell-in-flight-ignores-handoff | src/tui/tui-shell.ts:7966 | `workInFlight: () => chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement,` → `workInFlight: () => chrome.isBusy() \|\| foregroundOperation.isActive,` | killed |
| S04-shell-in-flight-ignores-operation | src/tui/tui-shell.ts:7966 | `workInFlight: () => chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement,` → `workInFlight: () => chrome.isBusy() \|\| forceHandoff.isAwaitingSettlement,` | killed |
| S05-detach-helper-does-not-detach | src/tui/tui-shell.ts:7971 | `const detachSlashWork = (work: Promise<unknown>): void => drainSites.detach(work);` → `const detachSlashWork = (work: Promise<unknown>): void => void work;` | killed |
| S06-bus-settle-dropped | src/tui/tui-shell.ts:7967 | `      onSettle: () => busWakeController?.onSettle(),` → `      onSettle: () => undefined,` | killed |
| S07-turn-settle-site-deleted | src/tui/tui-shell.ts:9935 | `        drainSites.onTurnSettle(); ` → ` ` | killed |
| S08-operation-complete-site-deleted | src/tui/tui-shell.ts:9630 | `                  drainSites.onForegroundOperationComplete(); ` → ` ` | killed |
| S09-lease-release-wired-to-turn-settle | src/tui/tui-shell.ts:10015 | `      onRelease: () => drainSites.onLeaseRelease(),` → `      onRelease: () => drainSites.onTurnSettle(),` | killed |
| S10-bus-idle-ignores-queue | src/tui/tui-shell.ts:9993 | `        !drainSites.workInFlight() &&         mainQueue.length === 0 &&         leaseView()?.held() !== true,` → `        !drainSites.workInFlight() &&         leaseView()?.held() !== true,` | killed |
| S11-bus-idle-ignores-lease | src/tui/tui-shell.ts:9994 | `        mainQueue.length === 0 &&         leaseView()?.held() !== true,       inbox: busInbox,` → `        mainQueue.length === 0,       inbox: busInbox,` | killed |
| S12-bus-idle-ignores-destroyed | src/tui/tui-shell.ts:9992 | `        !destroyed &&         !drainSites.workInFlight() &&` → `        !drainSites.workInFlight() &&` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
