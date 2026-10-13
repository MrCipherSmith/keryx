# Review report: PR 999 (flow 441 T3, queue drain)

Orchestrator: vantage-review. Generic engine: review-orchestrator. Round 1. Head e91e6838c57fe6d9fdaedc389d712953ce156614, base 01e0dbfe44d1f2423720e0040655dab4bef5721a. Mode all.

Verdict: request changes. 0 blockers, 3 majors (F-001 to F-003), 6 minors (F-004 to F-009), 1 info (F-010), 5 pre-existing (F-011 to F-015). Verifier: 10 checked, 9 confirmed, 0 refuted, 1 unverifiable (F-010 timings). Mutation pass: 22 mutants, 17 killed, 5 survived (M05, M16, M17, M18, M21).

## Lanes
- review-logic: F-001 (slash commands that outlive their handler are not counted by queueWorkInFlight).
- review-testing-practices: F-002, F-003, F-004 (unpinned shell wiring, one-sided AC4 bound).
- review-highload / review-performance: F-005, F-006, F-010.
- review-style / review-clean-code: F-007, F-008, F-009.
- review-architecture, review-regression, review-security-code: corroborated F-001 and F-005; pre-existing F-011 to F-015.

## Questions
- Q1 (AC1): AC1 says the test lives in the TUI shell, but a model satisfies it and the shell wiring is pinned only by source-text strings. Is the model acceptable?
- Q2 (AC2): AC2 names /model, /goal and /connect, which are async in the shell but synchronous in the model. Is draining past an open picker or a running /goal intended? (Not intended; F-001 fixes it.)

## Not run
- Shell mount (the shell cannot be mounted headless), greptile, cross-family review, ledger build.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "quote": "const queueWorkInFlight = (): boolean =>",
    "problem": "drainNext decides that a queued line is finished from queueWorkInFlight (chrome.isBusy() || foregroundOperation.isActive || forceHandoff.isAwaitingSettlement). That is true for /compact (synchronous) and for turns (startBusy and foregroundOperation.begin run before runLine returns), but not for slash commands that return from runLine before their work is done: /goal runs `void (async () => { await runGoalCommand(...) })()` and runGoalCommand awaits runAgentTurn on the shared history with no startBusy and no foregroundOperation.begin; /model and /connect|/provider open a picker through chrome.withOverlay inside a detached async IIFE and call switchTo only after the pick; /schedule, /search-provider and /search-connect are detached the same way. withOverlay only bumps overlayDepth, and trackCommandWork fills a separate set; queueWorkInFlight reads neither. After such a line the loop sees an idle shell and runs the next queued line at once. createDrainSites.onTurnSettle then also calls onSettle(), and busWakeController.isIdle is true while the detached work runs. The model in main-queue-drain.test.ts returns synchronously for every slash line, so it cannot see this. AC2 itself names /model, /goal and /connect, so the fix has to keep the question draining after the command ends.",
    "impact": "Trigger: while a turn runs the operator queues `/model` (or `/connect`) and then `question`, or `/goal x` and then `question`; the turn settles. /model, /connect: the picker opens and `question` starts as a turn in the same tick on the OLD model (switchTo only affects later turns, because the running turn captured sessionDeps); the operator queued the switch first precisely so the question would use the new model. /goal: runGoalCommand's detached runAgentTurn and the question's turn run at once on the same history array, interleaving tool_call/tool_result messages. For a slash-only drain ending in /goal or a picker, onSettle() can start a bus-wake turn beside the detached work. A security reviewer also raised that the question's turn may raise an approval dock while the picker owns the global key listener (unconfirmed; the picker handler's propagation was not traced). Before the diff the drain stalled behind these lines, so the queue could never create the overlap; typing during /goal while idle already could (pre-existing), and the drain now makes it automatic for queued lines.",
    "suggested_fix": "Give slash work that outlives its handler a way to report in-flight: register /goal, /model, /connect, /provider, /schedule, /search-provider and /search-connect in one shell-level counter (or a foregroundOperation-style token) that queueWorkInFlight includes, together with chrome.overlayActive(); call drainSites.onForegroundOperationComplete() from each handler's finally so the queue resumes (adding only the counter would bring the original stall back). Alternatively let run return void | Promise<void> and have drainNext await it. Add a model case whose slash line stays pending and assert the next line waits for it.",
    "evidence": "Read at head e91e6838: tui-shell.ts /goal 8783-8797, /model 9300-9344, /connect 9359-9404, /schedule 8768, /search-provider 8827, /search-connect 8861; the only startBusy sites are 9467/9546 (wiki-enrich) and 9663 (main turn); queueWorkInFlight at ~7961; goal-command.ts 751/830/867/974 (await runAgentTurn); shell-chrome.ts withOverlay only does overlayDepth += 1. Raised independently by review-logic, review-architecture, review-clean-code, review-regression, review-highload (F-A/F-B/F-C), review-security-code (overlay variant) and review-testing-practices. Not executed in a mounted shell (the shell cannot be mounted headless).",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:8768 (/schedule)",
        "src/tui/tui-shell.ts:8783 (/goal)",
        "src/tui/tui-shell.ts:8827 (/search-provider)",
        "src/tui/tui-shell.ts:8861 (/search-connect)",
        "src/tui/tui-shell.ts:9300 (/model)",
        "src/tui/tui-shell.ts:9359 (/connect and /provider)"
      ],
      "enumeration_method": "Read every slash branch of runLine between the idle-path echo (~8685) and the held-lease gate (~9431) and kept those that return after `void (async () => ...)()` or `void run...(...)` without foregroundOperation.begin, startBusy or trackCommandWork. /resume, /new and /clear are excluded because BUSY_REFUSED_COMMANDS refuses them while busy; the trackCommandWork family (/tasks, /delegate, /doctor) is tracked but not counted by the drain and is documented as running alongside the shell."
    },
    "line": 7961,
    "pre_existing": false
  },
  {
    "id": "F-002",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "quote": "drainSites.onForegroundOperationComplete();",
    "problem": "The foreground-operation-complete drain site is no longer pinned by any test. Before the diff remote-queue-wiring.test.ts counted remoteQueue.runQueued( at 5 and this site's inline call was one of the five. The diff lowers the count to 3 (drainSites run, forceForegroundQueueItem run, drainIdleMainQueue dispatch) and no test asserts the new call: tui-bus.test.ts pins only drainSites.onTurnSettle();, tui-hold.test.ts only onLeaseRelease, and main-queue-drain.test.ts drives the sites through its own model. AC3 asks for one test per site; for this site the shell wiring is now unpinned.",
    "impact": "Trigger: an edit or merge drops drainSites.onForegroundOperationComplete() in the wiki-enrich completion callback (~9634). Outcome: after a foreground operation ends, queued lines stay in mainQueue until the operator acts, which is the stall flow 441 fixes, and every suite stays green. Mutant M21 deletes the call and all five suites pass.",
    "suggested_fix": "Pin all three call sites in the source-text audit, each exactly once: `drainSites.onForegroundOperationComplete();`, `drainSites.onTurnSettle();` and `onRelease: () => drainSites.onLeaseRelease()`. Better, move the wiring into one factory in main-queue.ts so a test can drive the real wiring (see F-003).",
    "evidence": "mutant:M21-shell-operation-complete-site-deleted",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:9634 (drainSites.onForegroundOperationComplete)",
        "src/tui/tui-shell.ts:9942 (drainSites.onTurnSettle, pinned by tui-bus.test.ts)",
        "src/tui/tui-shell.ts:10023 (onRelease -> drainSites.onLeaseRelease, pinned by tui-hold.test.ts)"
      ],
      "enumeration_method": "keryx ctx rg for `drainSites\\.` in src/tui/tui-shell.ts and in every *.test.ts: three call sites in the shell, two of them asserted by source-text tests, the foreground-operation one by none."
    },
    "line": 9634,
    "pre_existing": false
  },
  {
    "id": "F-003",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "quote": "pending: () => mainQueue.length,",
    "problem": "modelShell in main-queue-drain.test.ts builds its own take/pending/paint/run/isBusy/isAwaitingSettlement and hands them to drainNext and createDrainSites, so the shell's real mapping of those dependencies is tested nowhere except a few source-text strings. Surviving mutants: M16 (`pending: () => 0`, budget 1, the one-line-per-settle drain returns), M17 (`paint: () => {}`; the old `paintMainQueue();` assertion in the tui-hold lease block was deleted and nothing replaced it) and M18 (`isAwaitingSettlement: () => false`). The reviewer also ran two mutants in a scratch copy that are not in the recorded table: drainNext's `isBusy: queueWorkInFlight` and createDrainSites' `isBusy: queueWorkInFlight` replaced by `() => false`; both leave 121/121 green, because tui-hold's whole-file `toContain` on the busy expression is satisfied by the queueWorkInFlight definition alone. Only the `take:` and `run:` wirings are pinned. AC1 asks for a test 'in the TUI shell'; a model proves drainNext and createDrainSites work, not that the shell uses them.",
    "impact": "Trigger: a refactor or merge changes pending to () => 0, paint to a no-op, or isBusy/isAwaitingSettlement to a stub. Outcome: M16 brings back the stall for /compact, /model, /goal and /connect (the headline fix is reverted); M17 leaves the queue rows and the 'mainQ queued xN' counter showing dequeued lines; X1 makes the drain run the next line while a turn runs (the busy dialog appears); X2 makes a lease release drain into a busy shell (double dispatch). The suite stays green throughout.",
    "suggested_fix": "Move the composition into main-queue.ts as one factory, e.g. createMainQueueDrain({ forced, queue, paint, run, chromeBusy, operationActive, awaitingSettlement, onSettle }), returning the three sites; the shell makes one call with the real objects and main-queue-drain.test.ts calls the same factory with fakes. Fallback: pin the complete `createDrainSites({...})` literal as one source-text block (`isAwaitingSettlement: () => forceHandoff.isAwaitingSettlement,`, `isBusy: queueWorkInFlight,`, `paint: paintMainQueue,`, `pending: () => mainQueue.length,`).",
    "evidence": "mutant:M16-shell-pending-always-zero (also survivors mutant:M17-shell-drain-does-not-paint and mutant:M18-shell-awaiting-settlement-never; X1 and X2 are the reviewer's own scratch runs, not in the recorded table)",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:7967 (pending)",
        "src/tui/tui-shell.ts:7968 (paint)",
        "src/tui/tui-shell.ts:7970 (drainNext isBusy)",
        "src/tui/tui-shell.ts:7972 (isAwaitingSettlement)",
        "src/tui/tui-shell.ts:7973 (createDrainSites isBusy)"
      ],
      "enumeration_method": "Every dependency the shell passes to drainNext and createDrainSites (the drainSites block at 7960-7975), checked against the string assertions of tui-bus.test.ts, tui-hold.test.ts and remote-queue-wiring.test.ts; the unpinned ones are those listed. take and run are pinned (mutants M15 and X3/X4 go red)."
    },
    "line": 7967,
    "pre_existing": false
  },
  {
    "id": "F-004",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/main-queue-drain.test.ts",
    "quote": "expect(shell.ran.length).toBeLessThanOrEqual(3);",
    "problem": "The AC4 self-requeue test is one-sided: `<= 3` and `> 0` pass for any budget from 1 to 3, so a regression of the budget to pending() or to 1 still passes. The run is deterministic (2 queued + 1 forced slot = exactly 3 runs, 2 lines left, 1 onSettle). Mutant M05 (the final `return \"drained\"` after the budget is spent changed to \"started\") survives for the related reason that no test spends the budget with the queue empty: a forced slash item plus a queued slash line should end 'drained' and fire onSettle; the AC4 five-slash test returns early through the `next === undefined` branch.",
    "impact": "A regression of the budget to pending() or to 1 passes this one test; the other AC tests do fail on it (verifier: budget pending() gives 1 failure, budget 1 gives 7), so the gap is local to the test. M05 (the final return after the budget is spent) survives the whole suite: a lost bus wake after a forced slash item plus a queued slash line is not caught. Narrow, and the wake after a spent budget is a no-op whenever lines remain queued.",
    "suggested_fix": "expect(shell.ran.length).toBe(3); expect(shell.queue).toHaveLength(2); expect(shell.settles).toBe(1). Add: shell.forced.push(item('f','/f')); shell.queue.push(item('a','/a')); settleTurn(); expect ran ['/f','/a'], queue [], settles 1. The reviewer confirmed in a scratch copy that both pass on the real code and fail under M05.",
    "evidence": "mutant:M05-drainNext-budget-spent-reports-started",
    "confidence": "high",
    "line": 197,
    "pre_existing": false
  },
  {
    "id": "F-005",
    "reviewer": "review-performance",
    "severity": "minor",
    "file": "src/tui/main-queue.ts",
    "quote": "for (let budget = options.pending() + 1; budget > 0; budget--) {",
    "problem": "With a `turns` lease held by a peer, runLine re-queues a non-slash operator line (push, paintMainQueue, '◇ ... queued as qN' notice) and returns with the shell idle. drainNext treats that as a finished line and keeps looping until the whole budget pending()+1 is spent. None of the sites checks held() at settle or operation-complete (onLeaseRelease fires only after release).",
    "impact": "Trigger: a peer holds the lease, the in-flight turn settles (or a foreground operation completes) with N non-slash lines queued. Outcome: N+1 'queued as qN' system notices and about 2(N+1) queue repaints in one tick instead of 1 notice, each re-push minting a new id. Reproduced against the real drainNext with a re-queueing run: 3 lines gave 4 re-queue runs (notices) and 4 drainNext paints (the shell's own runLine repaint per re-queue comes on top), final order one rotation. The final order equals the old single-take rotation (N+1 mod N = 1) and no line is lost; onSettle() then fires with the queue non-empty but busWakeController.isIdle requires mainQueue.length === 0 and no held lease, so it wakes nothing. Noise, not data loss; review-performance rated this major, the other four reviewers that saw it minor or info.",
    "suggested_fix": "Stop the loop when a line leaves the queue unchanged (compare pending() before take and after run), or skip the drain at the settle and operation-complete sites while leaseView()?.held() is true. Add a test where run() re-queues without going busy and assert one run per drain.",
    "evidence": "Verifier probe against the real drainNext with run(n){queue.push(n)} on 3 lines: {out:'drained', paints:4, notices:4, order:[l1,l2,l3,l1], left:[l2,l3,l1]}; tui-shell.ts runLine held branch ~9431-9438 and busy-branch hold ~8610-8616; bus-wake.ts isIdle. Also reported by review-logic, review-architecture, review-clean-code, review-highload, review-testing-practices and review-security-code.",
    "confidence": "medium",
    "line": 213,
    "pre_existing": false
  },
  {
    "id": "F-006",
    "reviewer": "review-highload",
    "severity": "minor",
    "file": "src/tui/main-queue.ts",
    "quote": "for (let budget = options.pending() + 1; budget > 0; budget--) {",
    "problem": "The budget pending()+1 allows exactly one forced item, but ForegroundForceHandoff keeps a list of pending items and take() drains forced items first. With k >= 2 forced items plus slash lines the budget is spent on the forced ones, drainNext returns 'drained' and onSettle() fires while lines remain queued in an idle shell.",
    "impact": "Trigger: two Force presses queued behind one foreground operation, followed by slash-only lines. Outcome: one or more lines wait for the operator in an idle shell until the next settle, the stall class the PR fixes, in a narrow case. No data loss.",
    "suggested_fix": "Budget over forced plus queued: add a pendingForced() count to the options, or cap the loop at (forced + queued + 1) read at entry.",
    "evidence": "foreground-operation.ts ForegroundForceHandoff (`private readonly pending: T[]`, takeNext shifts one per call); tui-shell.ts take/pending wiring counts only mainQueue.length. review-logic raised the same case as info with low confidence.",
    "confidence": "medium",
    "line": 213,
    "pre_existing": false
  },
  {
    "id": "F-007",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/tui/tui-bus.test.ts",
    "quote": "(behaviour: main-queue.test.ts)",
    "problem": "Both rewritten source-text audit titles (tui-bus.test.ts and tui-hold.test.ts) say `(behaviour: main-queue.test.ts)`. main-queue.test.ts has no drainNext, createDrainSites or onSettle test; the behaviour tests are in main-queue-drain.test.ts. No other test title in src/tui uses a `(behaviour: <file>)` suffix.",
    "impact": "The pointer is the only link left from the weakened audits to the real tests, and it leads to the wrong file, so a maintainer concludes the behaviour is untested. It also makes the wiring audits look more covered than they are (see F-002 and F-003).",
    "suggested_fix": "Point both titles at main-queue-drain.test.ts, or drop the parenthetical and use a `//` comment above the test as the file's other cross-references do.",
    "evidence": "keryx ctx rg \"drainNext|createDrainSites|onSettle\" src/tui/main-queue.test.ts matches only drainIdleMainQueue tests; the same wrong pointer is at tui-hold.test.ts:115. Reported by review-style, review-clean-code, review-logic, review-architecture, review-testing-practices and review-highload.",
    "confidence": "high",
    "line": 715,
    "pre_existing": false
  },
  {
    "id": "F-008",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "quote": "Otherwise FIFO-drain the head of the main queue",
    "problem": "Comments and docs still describe the pre-flow-441 shape. At the turn-settle call site the old 'forced item wins / Otherwise FIFO-drain the head of the main queue' block is stacked on the rewritten Flow 274 T7 comment above `drainSites.onTurnSettle();` and describes logic that now lives in `take:` about 2000 lines earlier. The createDrainSites `onSettle` dep doc says 'a settled turn that left nothing queued wakes the bus' and the tui-shell comment says 'only once no queued operator item is left', but onSettle now fires whenever the drain ends idle (a slash-only drain, or a spent budget with lines still queued). A test title and comment in main-queue-drain.test.ts still talk about 'the else branch', which no longer exists. The lease-site comment lost its pointer to the shared drain and still says 'while a turn is still busy' for the wider queueWorkInFlight guard.",
    "impact": "A future edit that trusts the docs could add a pending() === 0 guard or assume the 'nothing queued' invariant that no longer holds. No functional effect today.",
    "suggested_fix": "Merge the stacked comments into one block that points at drainSites; reword the onSettle doc to 'the drain ended idle (no turn started), so the bus may wake'; rename the test title and comment from 'else branch' to 'drain ended idle'; give the lease-site comment its pointer back.",
    "evidence": "tui-shell.ts 9935-9942, 10017-10024; main-queue.ts onSettle dep doc; main-queue-drain.test.ts:118 and :190. Reported by review-style (F-003, F-004, F-008) and review-clean-code (F-004).",
    "confidence": "high",
    "line": 9936,
    "pre_existing": false
  },
  {
    "id": "F-009",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/tui/main-queue.ts",
    "quote": "export type DrainOutcome = \"started\" | \"drained\";",
    "problem": "`drained` stands for three situations: the queue is empty, the budget is spent with lines still queued, and a held lease where runLine re-queued every line. The caller (onTurnSettle) reads it as 'nothing queued' and calls onSettle(); that is harmless today only because busWakeController.isIdle separately checks mainQueue.length === 0 and held() !== true in another file. The busy predicate has two doc strings ('started a turn' on drainNext.isBusy, 'a turn, a foreground operation or a pending hand-off' on createDrainSites.isBusy) and three names (isBusy, isBusy, queueWorkInFlight), and the outcome name `started` is misleading for a line that opens a foreground operation.",
    "impact": "The correctness of the onSettle call rests on a guard elsewhere, not on the type; a later change to isIdle or onSettle could wake the bus with items still queued. Naming drift between the helper and its only caller.",
    "suggested_fix": "Split the outcome (\"started\" | \"empty\" | \"exhausted\") or document that onSettle must re-check idleness; use one term and one doc for the busy predicate (e.g. 'queue work is in flight').",
    "evidence": "main-queue.ts drainNext ends with `return \"drained\"` after the budget loop whatever the queue holds; bus-wake.ts:75 isIdle; tui-shell.ts:9998-10003. Reported by review-clean-code (F-002, F-003), review-style (F-005, F-006) and review-architecture (F-004).",
    "confidence": "high",
    "line": 193,
    "pre_existing": false
  },
  {
    "id": "F-010",
    "reviewer": "review-performance",
    "severity": "info",
    "file": "src/tui/main-queue.ts",
    "quote": "options.paint();",
    "problem": "drainNext repaints the whole queue panel after every take, so a run of N slash lines does N+1 full remove-all-and-rebuild paints in one synchronous loop (O(N^2) row builds).",
    "impact": "Measured on the headless OpenTUI renderer: 5 slash lines 22 ms, 20 lines 80 ms, 50 lines 233 ms for the whole drain. Intermediate states are never drawn, so it is a one-off event-loop block; realistic queues are single digits. The old code painted once per settle, so a queue drained over N turns had the same N paints spread over time.",
    "suggested_fix": "None required. If queues ever reach dozens, paint once at loop exit when the queue is unchanged between iterations.",
    "evidence": "Benchmark in the review scratchpad (bench/bench.ts): N=5 22 ms, N=20 80 ms, N=50 233 ms.",
    "confidence": "high",
    "line": 215,
    "pre_existing": false
  },
  {
    "id": "F-011",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "line": 8659,
    "quote": "drainIdleMainQueue(mainQueue, {",
    "reviewer": "review-regression",
    "problem": "drainIdleMainQueue (the idle-path drain) and forceForegroundQueueItem (line 8051) are still single-item drains: a slash line at the head of the queue consumes the drain and the lines behind it wait for the next settle.",
    "impact": "Same stall class the PR fixes, left on the two paths the diff does not touch; reachable only when the shell is idle with queued lines (rare). Present on main.",
    "suggested_fix": "Route both through drainNext in a follow-up so the stall is closed on every drain path.",
    "evidence": "tui-shell.ts 8051 and 8659 are not touched by the diff.",
    "confidence": "medium",
    "pre_existing": true
  },
  {
    "id": "F-012",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "line": 7976,
    "quote": "const paintMainQueue = (): void => {",
    "reviewer": "review-performance",
    "problem": "paintMainQueue removes queue rows with chrome.queueDock.remove(entry.box) without destroyRecursively(), so repainted rows are detached but not destroyed.",
    "impact": "A repaint can leak renderables per queued line; the new loop repaints more often (see F-010) but the code is on main.",
    "suggested_fix": "Call destroyRecursively() on removed boxes, as the other chrome removal sites do.",
    "evidence": "tui-shell.ts 7980 chrome.queueDock.remove(entry.box); same code on main.",
    "confidence": "low",
    "pre_existing": true
  },
  {
    "id": "F-013",
    "severity": "minor",
    "file": "src/tui/remote-queue-wiring.ts",
    "line": 139,
    "quote": "dropQueuedTelegramLines() {",
    "reviewer": "review-security-code",
    "problem": "dropQueuedTelegramLines drops queued Telegram-source lines from the main queue, but a Telegram-source item already moved into the force handoff survives the drop.",
    "impact": "A forced Telegram line can still run after the operator dropped the Telegram queue. Present on main; the diff does not change the handoff.",
    "suggested_fix": "Have dropQueuedTelegramLines also filter the ForegroundForceHandoff pending list.",
    "evidence": "remote-queue-wiring.ts:139 filters only mainQueue; ForegroundForceHandoff.pending in foreground-operation.ts is separate.",
    "confidence": "low",
    "pre_existing": true
  },
  {
    "id": "F-014",
    "severity": "minor",
    "file": "src/tui/tui-shell.test.ts",
    "line": 4015,
    "quote": "take:",
    "reviewer": "review-testing-practices",
    "problem": "tui-shell.test.ts:4015 and busy-dispatch.test.ts:277 assert the drain wiring with weak `take:` source-text checks that predate the diff.",
    "impact": "They pin a substring, not the drain behaviour, so they pass for an unrelated `take:`. Present on main.",
    "suggested_fix": "Replace with the shared-factory test proposed in F-003.",
    "evidence": "keryx ctx rg \"take:\" in the two files.",
    "confidence": "medium",
    "pre_existing": true
  },
  {
    "id": "F-015",
    "severity": "info",
    "file": "src/tui/tui-shell.ts",
    "line": 9843,
    "quote": "if (!accepted) {",
    "reviewer": "review-logic",
    "problem": "The `!accepted` early return in runLine drains nothing, so a rejected line leaves the rest of the queue to the next settle.",
    "impact": "No new harm: the next settle or lease release drains. Present on main.",
    "suggested_fix": "None required.",
    "evidence": "tui-shell.ts:9843.",
    "confidence": "low",
    "pre_existing": true
  }
]
```
