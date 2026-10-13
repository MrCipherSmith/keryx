# Mutation pass

Command: `bun test src/tui/turn-loop.test.ts src/tui/busy-dispatch.test.ts src/tui/main-queue.test.ts src/tui/main-queue-drain.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-hold.test.ts src/tui/tui-bus.test.ts src/tui/tui-shell.test.ts` (baseline exit 0, 7107 ms). Run in a scratch copy; the worktree was not written.

Killed 26, survived 16, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| T01-drain-queue-empty | src/tui/turn-loop.ts:78 | `queue: () => queue,` → `queue: () => [],` | killed |
| T02-drain-run-noop | src/tui/turn-loop.ts:80 | `run: (next) => remote.runQueued(next),` → `run: () => {},` | killed |
| T03-drain-forced-dropped | src/tui/turn-loop.ts:77 | `forced: deps.forced,` → `forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },` | killed |
| T04-drain-onSettle-noop | src/tui/turn-loop.ts:82 | `onSettle: deps.onSettle,` → `onSettle: () => {},` | killed |
| T05-drain-onDetachedFailure-noop | src/tui/turn-loop.ts:83 | `onDetachedFailure: deps.onDetachedFailure,` → `onDetachedFailure: () => {},` | survived |
| T06-drain-turnWorkInFlight-false | src/tui/turn-loop.ts:81 | `turnWorkInFlight: deps.turnWorkInFlight,` → `turnWorkInFlight: () => false,` | killed |
| T07-remote-nextId-constant | src/tui/turn-loop.ts:70 | `nextId: () => `mq${seq++}`,` → `nextId: () => `mq0`,` | survived |
| T07b-enqueue-id-constant | src/tui/turn-loop.ts:59 | `id: `mq${seq++}`, question: line` → `id: `mq0`, question: line` | survived |
| T08-enqueue-no-paint | src/tui/turn-loop.ts:60 | `deps.paint();     return queue.length;` → `return queue.length;` | survived |
| T09-gate-flip | src/tui/turn-loop.ts:95 | `deferredBusyAction(line, commandName) !== "queue"` → `deferredBusyAction(line, commandName) === "queue"` | killed |
| T09b-gate-deleted | src/tui/turn-loop.ts:95 | `if (deferredBusyAction(line, commandName) !== "queue") return false;` → `` | killed |
| T10-notice-dropped | src/tui/turn-loop.ts:97 | `deps.say(`${queuedCommandNotice(position)}` → `void (`${queuedCommandNotice(position)}` | killed |
| T10b-notice-position-const-1 | src/tui/turn-loop.ts:97 | `queuedCommandNotice(position)` → `queuedCommandNotice(1)` | killed |
| T11-idle-takeForced-undefined | src/tui/turn-loop.ts:103 | `takeForced: () => deps.forced.takeNext(),` → `takeForced: () => undefined,` | survived |
| T12-idle-isIdle-always-true | src/tui/turn-loop.ts:102 | `isIdle,         takeForced` → `isIdle: () => true,         takeForced` | survived |
| T13-idle-dispatch-no-paint | src/tui/turn-loop.ts:105 | `deps.paint();           remote.runQueued(next);` → `remote.runQueued(next);` | survived |
| T13b-idle-dispatch-no-run | src/tui/turn-loop.ts:105 | `deps.paint();           remote.runQueued(next);` → `deps.paint();` | killed |
| T14-replaceQueue-noop | src/tui/turn-loop.ts:90 | `replaceQueue(next) {       queue = next;     },` → `replaceQueue(next) {       void next;     },` | survived |
| T15-setQueue-noop | src/tui/turn-loop.ts:67 | `setQueue: (next) => {       queue = next;     },` → `setQueue: (next) => {       void next;     },` | killed |
| T16-remote-getQueue-copy | src/tui/turn-loop.ts:66 | `getQueue: () => queue,` → `getQueue: () => [...queue],` | survived |
| T17-enqueue-question-display-swapped | src/tui/turn-loop.ts:59 | `question: line, displayQuestion: displayLine` → `question: displayLine, displayQuestion: line` | survived |
| T18-enqueue-source-dropped | src/tui/turn-loop.ts:59 | `, ...(source !== undefined ? { source } : {}) });` → ` });` | killed |
| T19-whileBusy-source-dropped | src/tui/turn-loop.ts:96 | `const position = enqueue(line, displayLine, source);` → `const position = enqueue(line, displayLine);` | killed |
| T20-whileBusy-line-display-swapped | src/tui/turn-loop.ts:96 | `const position = enqueue(line, displayLine, source);` → `const position = enqueue(displayLine, line, source);` | survived |
| T21-enqueue-returns-1 | src/tui/turn-loop.ts:61 | `return queue.length;` → `return 1;` | survived |
| S01-shell-forced-dropped | src/tui/tui-shell.ts:5006 | `forced: forceHandoff,` → `forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },` | killed |
| S02-shell-inflight-without-foregroundOperation | src/tui/tui-shell.ts:5020 | `turnWorkInFlight: () => chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement,` → `turnWorkInFlight: () => chrome.isBusy() \|\| forceHandoff.isAwaitingSettlement,` | killed |
| S03-shell-inflight-without-awaitingSettlement | src/tui/tui-shell.ts:5020 | `turnWorkInFlight: () => chrome.isBusy() \|\| foregroundOperation.isActive \|\| forceHandoff.isAwaitingSettlement,` → `turnWorkInFlight: () => chrome.isBusy() \|\| foregroundOperation.isActive,` | killed |
| S04-shell-onSettle-noop | src/tui/tui-shell.ts:5021 | `onSettle: () => busWakeController?.onSettle(),` → `onSettle: () => undefined,` | killed |
| S05-shell-onDetachedFailure-silent | src/tui/tui-shell.ts:5022 | `onDetachedFailure: (error) => {` → `onDetachedFailure: (error) => {         if (error !== undefined) return;` | survived |
| S06-shell-runLine-source-dropped | src/tui/tui-shell.ts:5019 | `runLine: (line, origin, source) => runLine(line, origin, source),` → `runLine: (line, origin) => runLine(line, origin),` | survived |
| S07-shell-getBridge-undefined | src/tui/tui-shell.ts:5008 | `getBridge: () => remoteBridge,` → `getBridge: () => undefined,` | survived |
| S08-shell-say-noop | src/tui/tui-shell.ts:5018 | `say: (text) => io.onSystem?.(text),` → `say: () => undefined,` | survived |
| S09-shell-whileBusy-source-dropped | src/tui/tui-shell.ts:8592 | `turnLoop.enqueueWhileBusy(line, displayLine, command?.name, source)` → `turnLoop.enqueueWhileBusy(line, displayLine, command?.name)` | killed |
| S10-shell-held-busy-enqueue-source-dropped | src/tui/tui-shell.ts:8624 | `if (leaseView()?.held() === true) {           const position = turnLoop.enqueue(line, displayLine, source);` → `if (leaseView()?.held() === true) {           const position = turnLoop.enqueue(line, displayLine);` | killed |
| S11-shell-held-idle-enqueue-source-dropped | src/tui/tui-shell.ts:9436 | `if (origin === "operator") {           const position = turnLoop.enqueue(line, displayLine, source);` → `if (origin === "operator") {           const position = turnLoop.enqueue(line, displayLine);` | killed |
| S12-shell-recipient-choice-no-drain | src/tui/tui-shell.ts:8669 | `turnLoop.drainWhenIdle(` → `((_idle: () => boolean) => undefined)(` | killed |
| S13-shell-force-replaceQueue-dropped | src/tui/tui-shell.ts:8064 | `turnLoop.replaceQueue(removeMainQueueItem(turnLoop.queue, index));` → `removeMainQueueItem(turnLoop.queue, index);` | killed |
| S14-shell-drainSites-fresh-object | src/tui/tui-shell.ts:7992 | `const drainSites = turnLoop.drain;` → `const drainSites = { ...turnLoop.drain };` | killed |
| S15-shell-settle-drain-dropped | src/tui/tui-shell.ts:9941 | `drainSites.onTurnSettle();` → `` | killed |
| S16-shell-lease-release-drain-dropped | src/tui/tui-shell.ts:10022 | `onRelease: () => drainSites.onLeaseRelease(),` → `onRelease: () => undefined,` | killed |
| S17-shell-foreground-complete-drain-dropped | src/tui/tui-shell.ts:9636 | `drainSites.onForegroundOperationComplete();` → `` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
