# Mutation pass

Command: `bun test src/tui/main-queue-drain.test.ts src/tui/main-queue.test.ts src/tui/tui-bus.test.ts src/tui/tui-hold.test.ts src/tui/remote-queue-wiring.test.ts src/tui/foreground-operation.test.ts` (baseline exit 0, 171 ms). Run in a scratch copy; the worktree was not written.

Killed 40, survived 0, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N01-budget-short-by-one | src/tui/main-queue.ts:218 | `for (let budget = options.pending(); budget > 0; budget--)` → `for (let budget = options.pending() - 1; budget > 0; budget--)` | killed |
| N02-budget-extra-slot | src/tui/main-queue.ts:218 | `for (let budget = options.pending(); budget > 0; budget--)` → `for (let budget = options.pending() + 1; budget > 0; budget--)` | killed |
| N03-never-stops-on-busy | src/tui/main-queue.ts:224 | `    if (options.isBusy()) return "started"; ` → ` ` | killed |
| N04-no-paint | src/tui/main-queue.ts:221 | `    options.paint(); ` → ` ` | killed |
| N05-empty-take-reports-started | src/tui/main-queue.ts:222 | `if (next === undefined) return "empty";` → `if (next === undefined) return "started";` | killed |
| N07-no-self-requeue-stop | src/tui/main-queue.ts:225 | `    if (options.pending() >= before) return "exhausted"; ` → ` ` | killed |
| N08-self-requeue-stop-strict | src/tui/main-queue.ts:225 | `if (options.pending() >= before) return "exhausted";` → `if (options.pending() > before) return "exhausted";` | killed |
| N09-settle-wakes-always | src/tui/main-queue.ts:274 | `if (drain() === "empty") deps.onSettle();` → `drain();       deps.onSettle();` | killed |
| N10-settle-never-wakes | src/tui/main-queue.ts:274 | `if (drain() === "empty") deps.onSettle();` → `drain();` | killed |
| N11-settle-wakes-on-exhausted | src/tui/main-queue.ts:274 | `if (drain() === "empty") deps.onSettle();` → `if (drain() !== "started") deps.onSettle();` | killed |
| N12-settle-ignores-handoff | src/tui/main-queue.ts:272 | `    onTurnSettle() {       if (deps.forced.isAwaitingSettlement) return; ` → `    onTurnSettle() { ` | killed |
| N13-operation-complete-ignores-handoff | src/tui/main-queue.ts:268 | `    onForegroundOperationComplete() {       if (deps.forced.isAwaitingSettlement) return; ` → `    onForegroundOperationComplete() { ` | killed |
| N14-idle-drain-unguarded | src/tui/main-queue.ts:264 | `    if (deps.workInFlight()) return;     drain();` → `    drain();` | killed |
| N15-detached-done-site-empty | src/tui/main-queue.ts:277 | `onDetachedWorkDone: drainWhenIdle,` → `onDetachedWorkDone() {},` | killed |
| N16-lease-release-site-empty | src/tui/main-queue.ts:276 | `onLeaseRelease: drainWhenIdle,` → `onLeaseRelease() {},` | killed |
| N17-queue-before-forced | src/tui/main-queue.ts:257 | `deps.forced.takeNext() ?? deps.queue.shift()` → `deps.queue.shift() ?? deps.forced.takeNext()` | killed |
| N18-pending-ignores-forced | src/tui/main-queue.ts:258 | `deps.forced.pendingCount + deps.queue.length` → `deps.queue.length` | killed |
| N19-pending-ignores-queue | src/tui/main-queue.ts:258 | `deps.forced.pendingCount + deps.queue.length` → `deps.forced.pendingCount` | killed |
| N20-paint-dropped | src/tui/main-queue.ts:259 | `paint: deps.paint,` → `paint: () => {},` | killed |
| N21-busy-dropped | src/tui/main-queue.ts:261 | `isBusy: deps.workInFlight,` → `isBusy: () => false,` | killed |
| N22-handoff-count-zero | src/tui/foreground-operation.ts:126 | `get pendingCount(): number {     return this.pending.length;` → `get pendingCount(): number {     return 0;` | killed |
| S01-shell-in-flight-ignores-handoff | src/tui/tui-shell.ts:7963 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement \|\| detachedSlashWork > 0;` → `chrome.isBusy() \|\| foregroundOperation.isActive \|\| detachedSlashWork > 0;` | killed |
| S02-shell-in-flight-ignores-operation | src/tui/tui-shell.ts:7963 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement \|\| detachedSlashWork > 0;` → `chrome.isBusy() \|\| forceHandoff.isAwaitingSettlement \|\| detachedSlashWork > 0;` | killed |
| S03-shell-in-flight-ignores-chrome-busy | src/tui/tui-shell.ts:7963 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement \|\| detachedSlashWork > 0;` → `foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement \|\| detachedSlashWork > 0;` | killed |
| S04-shell-in-flight-ignores-detached | src/tui/tui-shell.ts:7963 | `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement \|\| detachedSlashWork > 0;` → `chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement;` | killed |
| S05-shell-forced-stub | src/tui/tui-shell.ts:7965 | `forced: forceHandoff,` → `forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },` | killed |
| S06-shell-queue-stub | src/tui/tui-shell.ts:7966 | `queue: mainQueue,` → `queue: [],` | killed |
| S07-shell-paint-dropped | src/tui/tui-shell.ts:7966 | `queue: mainQueue,       paint: () => paintMainQueue(),` → `queue: mainQueue,       paint: () => {},` | killed |
| S08-shell-bus-wake-dropped | src/tui/tui-shell.ts:7970 | `onSettle: () => busWakeController?.onSettle(),` → `onSettle: () => undefined,` | killed |
| S09-shell-turn-settle-site-deleted | src/tui/tui-shell.ts:9944 | `        drainSites.onTurnSettle(); ` → ` ` | killed |
| S10-shell-operation-site-deleted | src/tui/tui-shell.ts:9639 | `                  drainSites.onForegroundOperationComplete(); ` → ` ` | killed |
| S11-shell-lease-site-wired-to-settle | src/tui/tui-shell.ts:10025 | `onRelease: () => drainSites.onLeaseRelease(),` → `onRelease: () => drainSites.onTurnSettle(),` | killed |
| S12-shell-detach-counter-not-raised | src/tui/tui-shell.ts:7975 | `      detachedSlashWork += 1; ` → ` ` | killed |
| S13-shell-detach-end-not-drained | src/tui/tui-shell.ts:7978 | `        drainSites.onDetachedWorkDone(); ` → ` ` | killed |
| S14-model-not-detached | src/tui/tui-shell.ts:9306 | `detachSlashWork((async () => {             const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;             const prov` → `void ((async () => {             const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;             const prov` | killed |
| S15-connect-not-detached | src/tui/tui-shell.ts:9365 | `detachSlashWork((async () => {             const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;             const ns` → `void ((async () => {             const detected = opts.redetect !== undefined ? await opts.redetect() : opts.detected;             const ns` | killed |
| S16-goal-not-detached | src/tui/tui-shell.ts:8790 | `detachSlashWork((async () => {             await runGoalCommand({` → `void ((async () => {             await runGoalCommand({` | killed |
| S17-schedule-not-detached | src/tui/tui-shell.ts:8776 | `detachSlashWork(runScheduleSlashCommand(` → `void (runScheduleSlashCommand(` | killed |
| S18-search-provider-not-detached | src/tui/tui-shell.ts:8833 | `detachSlashWork((async () => {             const args = parseSearchProviderArgs(line.slice(16));` → `void ((async () => {             const args = parseSearchProviderArgs(line.slice(16));` | killed |
| S19-search-connect-not-detached | src/tui/tui-shell.ts:8867 | `detachSlashWork((async () => {             const args = parseSearchProviderArgs(line.slice(15));` → `void ((async () => {             const args = parseSearchProviderArgs(line.slice(15));` | killed |

No survivor.
