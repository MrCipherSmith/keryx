# Review report: PR 999 (flow 441 T3, queue drain), round 3

Orchestrator: vantage-review. Generic engine: review-orchestrator. Round 3 of 3 (the last under the cap). Head e11b8eb538e66afe4a490d70622a4e9b8d1158a7, base 01e0dbfe44d1f2423720e0040655dab4bef5721a. Mode all. Previous rounds: `2026-10-13-pr-github-com-mrciphersmith-keryx-pull-999` (round 1) and `2026-10-13-pr-999-round2-f6b16a38` (round 2).

Verdict: request changes, narrowly. 0 blockers. All five round-2 findings (F-016 to F-020) are fixed in the code, verified by execution and by the mutation pass. From reading there are 5 minors (F-021 to F-025), 3 infos (F-027 to F-029) and 1 pre-existing major (F-026, never blocks). F-022 cites a surviving mutant, so `severity-audit` raises it to major; that is the only item that gates, and it is one missing test case. Nothing in the shipped behaviour is wrong: the fixes did not introduce a double wake, a wake loop or a repaint storm (measured, see below).

## Round-2 findings: disposition at e11b8eb5

| Round 2 | Disposition | Evidence |
|---|---|---|
| F-016 (major, stale queue array) | Closed. `queue` is a getter: `queue: () => mainQueue` at tui-shell.ts:7963, `deps.queue()` in `take` and `pending` at main-queue.ts:271-272, so a captured array no longer type-checks. Every other holder of the array reads the live variable (remote-queue-wiring.ts through `getQueue`/`setQueue`; `drainIdleMainQueue(mainQueue, ...)` at 8655 takes it by value for one synchronous call). | The round-2 repro re-run against the new code: research-evidence/stale-queue-repro.md. Mutants M06 (queue captured once) and S02 (getter returns a copy) killed. |
| F-017 (detached counter untested with a rejection) | Closed. The counter and `detach(work)` are in the factory (main-queue.ts 267-301), driven by a promise that resolves and one that rejects; `end` runs once per promise so the counter cannot go negative. Opens F-021 (the reason is swallowed) and F-022 (two overlapping detached works are not tested). | M02, M03, M19, M20, M22 killed; M01 survives. |
| F-018 (no wake after detach end, lease release, operation complete) | Closed. `onSettle` fires inside `drain()` when the outcome is `empty` (main-queue.ts:277), which covers all four sites. Every reviewer checked this for a double wake or a loop; see "Regressions the fixes introduced". The force hand-off is the one site that still ends without it (F-026, pre-existing). | M07, M08, M09 killed. |
| F-019 (bus `isIdle` ignored detached work and the hand-off) | Closed for the bus wake: `isIdle` reads `!drainSites.workInFlight()` (tui-shell.ts:9993). Three sibling readers still use the narrower predicates (F-025). | S01, S03, S04, M04, M05 killed. |
| F-020 (info) | Closed. The lease-site comment is updated (tui-shell.ts:10011-10012); the empty drain no longer paints (0 paints, test at main-queue-drain.test.ts 445). Point (2), the missing `destroyed` guard, is carried as F-027 (info). | |
| F-010 (N+1 paints, info) | Carried. A drain of N inline lines rebuilds N(N-1)/2 queue rows (N=50 gives 1225); unchanged by this round. | review-performance |
| F-011 to F-015 (pre-existing, round 1) | Unchanged. F-026 below is the Force path of F-011. | |

## Re-run of the stale-queue repro

`research-evidence/stale-queue-repro.ts` (round 2's script, now built with the getter form) gives: remove-line-1-then-settle runs `b` and not the removed `a`; push `a`, remove it, push `b`, settle runs `b`; a force-style reassign runs `x` exactly once; remove-all-then-settle runs nothing and wakes once. Round 2 printed the opposite on each row. Result in research-evidence/stale-queue-repro.md.

## Regressions the fixes introduced

The orchestrator named four concerns; all nine reviewers measured them and none reproduces.

- Double wake: not reproduced. `runLine("", "bus-message")` reaches `foregroundOperation.begin()` and `startBusy` synchronously (tui-shell.ts 9646-9659), so a second `onSettle` in the same tick sees `isIdle` false. Turn settle, operation complete and lease release in one tick gave 2 `onSettle` calls and 1 wake; four sites in one tick gave 1 wake (highload P1 to P3).
- Wake loop: bounded by `consecutiveAutoWakes` and the cap in `decideBusWake`. An inbox that is never consumed gives 5 wakes (the cap) and one capped notice; only an operator line resets the counter (tui-shell.ts 8325-8327).
- Repaint storm: none. `paint` runs once per taken line; an empty drain paints 0 times.
- Moved counter and detach: `end` runs in a microtask, the counter is lowered once per promise, an already-settled promise holds the queue for one tick. The one behaviour change is F-021: a rejection is now consumed silently instead of becoming an unhandled rejection.
- Introduced by the fix commit: F-021 (swallowed rejection), F-022 (the new counter is not pinned for two overlapping works), F-023 (comments left describing the old single site), F-024 (one name for two predicates).

## Questions
- Q1 (AC1, carried from rounds 1 and 2): AC1 says the test lives in the TUI shell; the PR gives a model plus source-text pins. Still with the operator. F-029 and the fact that F-016 was invisible to the model are the evidence for that decision.
- Q2: should the force hand-off (F-026) and the single-item idle dispatch share the factory's drain in a follow-up flow together with F-011? This PR neither introduced nor worsened the gap, so it is a scoping question, not a gate.

## Not run
- Shell mount (no headless seam), greptile, cross-family review, ledger build, `review complete`.
- Ten test files were dropped from the blast radius by the 40-file cap and were not reviewed (src/commands/shell*.test.ts, review-system.test.ts, chat-shell.test.ts and the external-antigravity-surfaces, external-delivery and external-operator tests). Eight dependents were read directly by review-regression.
- Regression's wider run (`bun test src/tui src/commands/shell.test.ts src/commands/shell-task-tools.test.ts src/bus`) gave 2006 pass, 387 skip, 2 fail; both failures are in src/tui/ci-triage-source.test.ts (a `gh` parse, not in the diff, not on the dependency path) and were not re-run on the parent. The full repository suite was not run (CI runs it).
- Baseline of the nine test files used for mutation: green. The TUI test files at head: 309 pass, 67 skip, 0 fail.
- The ledger is minimal: the reviewers' raw replies were not saved as files, so the raw-reconciliation fields of `research.json` stay false.
- Vantage overlays: none selected. This is the Keryx repository, not Vantage; none of the overlay path gates (src/core/**, src/analytics/**, src/wrappers/sigma/**, stylesheets, date utilities, design-system files) match, and no `--vantage*` flag was given.

## Mutation pass
36 mutants over `createMainQueueDrain` (24 in main-queue.ts) and the shell wiring (12 in tui-shell.ts): the queue getter, `detach`, the counter, the combined in-flight predicate, the three drain sites, the hand-off guards, `onSettle` placement, `drainNext` budget and outcomes, the bus `isIdle` term. Command: `bun test src/tui/main-queue-drain.test.ts src/tui/main-queue.test.ts src/tui/busy-dispatch.test.ts src/tui/foreground-operation.test.ts src/tui/remote-queue-wiring.test.ts src/tui/tui-bus.test.ts src/tui/tui-hold.test.ts src/tui/tui-shell.test.ts src/tui/bus-wake.test.ts` (baseline green). Run in a scratch copy; the worktree sources were not written. Generated with `keryx review mutate` from research-evidence/mutants.json.

Killed 35, survived 1, timeout 0, invalid 0.

| Survivor | Where | Change | What it means |
|---|---|---|---|
| M01-detach-counter-reset-to-zero | src/tui/main-queue.ts:297 | `detached -= 1;` to `detached = 0;` | No test holds two detached works at once. With overlapping /goal and /model, the first end would zero the counter and the queue would drain beside the second (F-022). |

The other 35 are killed by behaviour (main-queue-drain.test.ts) or by a structural source pin that matches the intended wiring (the shell mutants S01 to S08 and related); the pins are text, not behaviour (F-029).

## Severity audit
F-022 cites a surviving mutant; `keryx review severity-audit` raises a cited survivor to major. The pre-audit judgement was minor: today's code is correct and only a plausible one-word regression goes unpinned. The rubric rule is applied as written. F-026 is a major by the rubric (a reachable trigger and an observable outcome) but pre-existing: it exists at the merge-base and in round 2, so it never blocks.

## Lanes
- review-architecture: F-025, F-026; the stale-holder enumeration; dispositions for F-016 to F-020.
- review-clean-code: F-021, F-023, F-028.
- review-style: F-024.
- review-testing-practices: F-022, F-029; the 36-mutant set.
- review-security-code: F-027; no lease bypass, no removed item still executing, no wake while a lease is held.
- review-highload: the wake and re-entrancy probes P1 to P10; F-021 co-reported.
- review-logic: probes of detach timing and the budget loop; F-021, F-025, F-026, F-027 co-reported.
- review-performance: repaint and double-wake counts; the N(N-1)/2 observation (F-010).
- review-regression (scope B): no regression at major or above; eight dependents read.
- review-verifier (Wave C): F-026 CONFIRMED, pre-existing, by execution.

## Pre-existing (never blocks)
- F-026 (major by rubric): the force hand-off dispatches a queued line outside the factory, so an inline slash command forced to the front strands the lines behind it and the bus wake. Present at 01e0dbfe, f6b16a38 and e11b8eb5; extends round-1 F-011. The verifier ran the repro against head and round 2 and read the base.
- F-027 (info): no `destroyed` guard on the detach-end and lease-release drains (round-2 F-020 point 2).
- F-011 to F-015 carry over from round 1.

## Verified clean
- `drainNext` terminates: bounded by `pending()` at entry, stops at the first non-decreasing pass (`exhausted`); the forced item goes before the queue (M17, M18, M23, M24 killed).
- The settle and operation-complete sites stay out during a hand-off, and the lease-release and detach-end sites stay out while anything is in flight (M10 to M15 killed); a requeued line under a held lease gives `exhausted` and no `onSettle`.
- `onSettle` fires only when the drain ends `empty` (M07 to M09 killed); the wake is guarded by `isIdle` (`!destroyed`, in-flight, queue length, lease), so it never fires during a held lease, a running turn or after teardown.
- Hand-off cannot starve the wake when the forced line starts a turn: that turn's `onTurnSettle` reaches `onSettle`; a session switch clears the flag (tui-shell.ts 6278).
- `remote-queue-wiring.ts`, `addressee-queue.ts`, `external-operator.ts` and `main-queue-view.ts` hold no stale reference to the queue array.
- The six detached sites all hold the queue through `detachSlashWork` (S05 killed); `/new`, `/clear` and `/resume` are refused while a turn runs and never queue.
- No test outside scope A pins `detachedSlashWork`, `queueWorkInFlight` or `onDetachedWorkDone`; the only remaining references are negative assertions in tui-hold.test.ts.

## How this review was run
Nine reviewers were dispatched through `keryx review required` under mode all, each as its own agent with the session model (no override): review-architecture, review-clean-code, review-highload, review-logic, review-performance, review-security-code, review-style, review-testing-practices (scope A) and review-regression (scope B, 40 files kept, 10 test files dropped by the cap, 22 unresolved imports). Wave C ran review-verifier on the one candidate major (architecture's F-026) and it returned CONFIRMED with the pre-existing marker; it can only delete, and it deleted nothing. Scope A: 32 files seen, 32 retained, 0 dropped (203 blocks, 4370 changed lines); the code is src/tui/main-queue.ts, tui-shell.ts, foreground-operation.ts and seven test files, the rest being committed review packages and generated gdgraph data. The consolidated list was deduplicated across reviewers (the swallowed rejection was filed independently five times and the sibling predicates four times). The orchestrator applied no lens itself. The generic engine is the project-local `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` (and SKILL.detail.md) in the worktree /home/altsay/keryx-fdm-t3; the Keryx projection path is `.metaproject/` of that worktree. Rule files read: `.metaproject/index.md`, the engine's SKILL.md and SKILL.detail.md (severity canonical section, fix-round obligations, mutation and severity-audit rules), `reviewer-finding.schema.json`. The reviewers' project-local packages under `.metaproject/project-skills/review/` were not applicable (the inventory lists none for this set).

Side effect to disclose: reviewers' `keryx ctx rg` runs wrote gdctx artifacts, and graph and wiki commands refreshed generated data, under `.metaproject/data` of the worktree. No source file was edited, committed, stashed or pushed.

```json keryx:findings
[
  {
    "id": "F-021",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/tui/main-queue.ts",
    "line": 300,
    "quote": "work.then(end, end);",
    "problem": "detach() releases the hold on a rejection and discards the reason: `end` ignores its argument and is the second argument of then(). The six detachSlashWork call sites in tui-shell.ts (/schedule, /goal, /search-provider, /search-connect, /model, /connect and /provider) hand it bare async IIFEs, and the /model and /connect IIFEs await opts.redetect(), modelsForPicker() and switchTo() with no try/catch around them. At f6b16a38 the same rejection surfaced as an unhandled rejection of the derived `.finally` promise; now nothing reports it. Five reviewers (clean-code, logic, highload, architecture, security) filed this independently.",
    "impact": "Trigger: /model (or /connect) while opts.redetect() or switchTo() rejects, for example a network failure while re-detecting providers. Outcome: the picker does not open, nothing is printed and nothing is logged (src has no unhandledRejection handler), so the operator sees a command that did nothing. The queue behind it does run, which is the fix. The cost is a lost error message at six call sites; the harm is diagnostics only.",
    "suggested_fix": "Give the factory an optional `onDetachedError?: (cause: unknown) => void` dep, call it in the rejection branch before `end`, and wire it in the shell to the system-notice path (`slash command failed: <message>`). Add a model case in main-queue-drain.test.ts that rejects a detached promise and asserts the reporter is called as well as the drain.",
    "evidence": "main-queue.ts 294-301; research-evidence/highload-wake-repro.ts P8 (rejecting detach gives 0 unhandled rejections) and P8b (the old `.finally` shape gives 1); research-evidence/logic-probe.ts; mutation M20 (`work.then(end, () => undefined)`) is killed, so the drain behaviour is pinned and only the report is not.",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:8767 (/schedule or /goal)",
        "src/tui/tui-shell.ts:8781",
        "src/tui/tui-shell.ts:8824",
        "src/tui/tui-shell.ts:8858",
        "src/tui/tui-shell.ts:9297 (/model)",
        "src/tui/tui-shell.ts:9356 (/connect, /provider)"
      ],
      "enumeration_method": "keryx ctx rg for `detachSlashWork(` in tui-shell.ts: the definition at 7971 and six call sites, then read each IIFE for its own catch."
    }
  },
  {
    "id": "F-022",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/main-queue.ts",
    "line": 297,
    "quote": "detached -= 1;",
    "problem": "The detached counter is exercised only one work at a time. Mutant M01 replaces `detached -= 1;` with `detached = 0;` and passes all 31 tests of main-queue-drain.test.ts and the other eight TUI test files, because no test holds two detached works at once and ends only one of them.",
    "impact": "Trigger: an edit turns the decrement into a reset (or an equivalent bug), and two slash commands with detached work overlap, for example /goal running while a /model picker is open. Outcome: when the first one ends the counter drops to zero, `workInFlight()` reports idle while the second is still running, and the settle sites drain a queued line beside the open picker or the running /goal. Today's code is correct; only the pin is missing. Mutant M01 survived.",
    "suggested_fix": "Add a model case: call `detach` twice with two pending promises, resolve one, assert `workInFlight()` is still true and a queued line has not run, then resolve the second and assert the line runs once.",
    "evidence": "mutant:M01-detach-counter-reset-to-zero (src/tui/main-queue.ts:297, survived; 35 of 36 mutants killed, see the mutation pass).",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff"
  },
  {
    "id": "F-023",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/tui/bus-wake.ts",
    "line": 108,
    "quote": "Call when a turn settles and no queued operator item ran instead.",
    "problem": "The fix moved the bus wake out of the turn-settle block and into every drain that ends empty (turn settle, operation complete, lease release, detach end), and made `isIdle` read the factory's combined predicate. The comments in bus-wake.ts still describe the old shape: the `onSettle` doc here (turn settles only), the `isIdle` doc at line 75 (`!chrome.isBusy() && !foregroundOperation.isActive && mainQueue.length === 0`, no detached work, hand-off or lease) and the F4 note at lines 65-67. The comment above the task-notification wake in tui-shell.ts (9947-9953) says it uses 'the same rule the bus-wake controller's own isIdle enforces', which is no longer true.",
    "impact": "Trigger: a maintainer reads bus-wake.ts to learn when the wake can fire. Outcome: they learn a three-term predicate and a single call site that the code no longer has, and may edit the wrong place. Maintenance cost only.",
    "suggested_fix": "Update the three bus-wake.ts comments to name the factory's `workInFlight()` plus the queue length, the lease and `destroyed`, and to list the four sites that reach `onSettle`; correct the tui-shell.ts 9947-9953 comment or fix F-025 so it becomes true.",
    "evidence": "bus-wake.ts 65-67, 75, 108; tui-shell.ts 9947-9953 against 9991-9995 and main-queue.ts 277.",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff"
  },
  {
    "id": "F-024",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/tui/main-queue.ts",
    "line": 255,
    "quote": "workInFlight: () => boolean;",
    "problem": "The factory has a dep named `workInFlight` (the shell's predicate: chrome busy, foreground operation, hand-off) and returns a method of the same name (that predicate OR the detached counter). They are different predicates under one name, and both sit within fifteen lines of each other. A caller of `drainSites.workInFlight()` in the shell cannot tell from the name which one it gets, and `deps.workInFlight` inside the factory is easy to confuse with the local `workInFlight`. Mutants M04, M05, M11 and M12 show the two are already mixed up by one-word edits.",
    "impact": "Trigger: a maintainer wires a new reader to the dep or to the returned method. Outcome: the wrong one is chosen without a type error. Maintenance cost only.",
    "suggested_fix": "Rename the dep to `shellBusy` (or `foregroundBusy`) and keep `workInFlight` for the combined predicate the factory returns.",
    "evidence": "main-queue.ts 255, 265, 268; tui-shell.ts 7966, 9993.",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff"
  },
  {
    "id": "F-025",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "line": 9955,
    "quote": "const busy = chrome.isBusy() || foregroundOperation.isActive;",
    "problem": "F-019 was fixed for the bus wake only. Three more readers of 'may a new turn start now' still re-derive the predicate and ignore detached slash work: the task-notification wake (this line; it also ignores the hand-off), drainIdleMainQueue's isIdle (8656-8661) and the bridge host's isBusy (10147-10150). The PR defines 'queue work in flight' once in the factory and four readers now disagree about it.",
    "impact": "Trigger: /goal or a /model picker is running detached and a background shell task finishes, a late 'main' recipient choice lands, or a Telegram line arrives. Outcome: a task-notification turn or an immediate runLine starts beside the detached work on the same history instead of waiting. The operator can already do this by typing, so this is not new harm; no wrong output was demonstrated. The cost is that the next edit of the predicate has to find the four sites by hand.",
    "suggested_fix": "Read `drainSites.workInFlight()` at 9955, in drainIdleMainQueue's isIdle and in the bridge host's isBusy (`drainSites.workInFlight() || mainQueue.length > 0 || leaseView()?.held() === true`), and add a source audit for each in the style of tui-bus.test.ts.",
    "evidence": "keryx ctx rg for `foregroundOperation\\.isActive|chrome\\.isBusy\\(\\)` in tui-shell.ts: readers at 7290, 7966, 8658, 9955, 10147, 10155; 7966 is the factory's own definition and 7290 and 10155 are settings and turn-running checks. Regression, highload and logic reached the same sites and judged them info.",
    "confidence": "medium",
    "pre_existing": false,
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:9955 task-notification wake",
        "src/tui/tui-shell.ts:8656 drainIdleMainQueue isIdle",
        "src/tui/tui-shell.ts:10147 bridge host isBusy",
        "src/tui/tui-shell.ts:9993 bus-wake isIdle (fixed)"
      ],
      "enumeration_method": "keryx ctx rg on `foregroundOperation.isActive|chrome.isBusy()` over tui-shell.ts, keeping the readers that decide whether a new turn may start."
    }
  },
  {
    "id": "F-026",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "line": 8047,
    "quote": "void forceForegroundQueueItem(foregroundOperation, forceHandoff, item, {",
    "problem": "The factory does not own every drain. A Forced line is dispatched by forceMainQueue -> forceForegroundQueueItem -> runAfterForegroundSettlement -> remoteQueue.runQueued(next), and that path never calls the drain or onSettle after the line has run. The settle sites are blind to it: onTurnSettle and onForegroundOperationComplete return while forced.isAwaitingSettlement, and drainWhenIdle returns on workInFlight, which includes the hand-off. If the forced line is a slash command that ends inline (/compact, /new and similar start no turn), nothing drains the lines behind it and nothing wakes the bus. Verified as pre-existing: the same stranding exists at the merge-base 01e0dbfe, at f6b16a38 and at e11b8eb5, and it extends round-1 F-011 (the idle path and Force are single-item drains).",
    "impact": "Trigger: the main queue holds a deferred slash command and a question behind a running turn, and the operator presses Force (Ctrl+Q, the button or /queue force) on the slash command. Outcome: the cancelled turn settles, the hand-off runs the slash command inline and stops, and the question stays shown as queued until the operator types another line or another turn settles; a pending bus message is not woken either. Repro against the real createMainQueueDrain, ForegroundForceHandoff and forceForegroundQueueItem prints {\"ran\":[\"/compact\"],\"queueLeft\":[\"question\"],\"settles\":0,\"workInFlight\":false}. Not introduced by this PR, so it never blocks; the round-3 isIdle change only changes which flag is read during a microtask window no poll can observe.",
    "suggested_fix": "Route the hand-off's run through the factory: add `afterDirectRun(): void { drainWhenIdle(); }` to the returned object and in forceMainQueue pass `run: (next) => { remoteQueue.runQueued(next); drainSites.afterDirectRun(); }`; do the same for the drainIdleMainQueue dispatch at 8663. A forced question makes the shell busy, so the call is a no-op there. Add a model case: the hand-off runs an inline slash line with a line queued behind it, and the line runs. Best done with F-011 in a follow-up flow.",
    "evidence": "research-evidence/wt/force-inline-slash-repro.ts; verifier (Wave C) CONFIRMED_PRE_EXISTING by execution at e11b8eb5 and f6b16a38 (research-evidence/verify/repro-head.ts, verify/r2/repro.ts) and by reading the base (verify/shell-base.ts); foreground-operation.ts 194-216 is unchanged since f6b16a38; main-queue.ts 285-293.",
    "confidence": "medium",
    "pre_existing": true,
    "location_class": "pre-existing",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:7965 drainSites run (inside the factory, covered)",
        "src/tui/tui-shell.ts:8049 forceMainQueue hand-off run (not covered)",
        "src/tui/tui-shell.ts:8663-8666 drainIdleMainQueue dispatch (not covered: runs one line, nothing drains if it ended inline)"
      ],
      "enumeration_method": "keryx ctx rg for `runQueued(` in src/tui (three call sites in tui-shell.ts), then checked per site whether a drain or onSettle follows the run."
    }
  },
  {
    "id": "F-027",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/tui/main-queue.ts",
    "line": 280,
    "quote": "const drainWhenIdle = (): void => {",
    "problem": "drainWhenIdle (lease release and detach end) and onForegroundOperationComplete have no `destroyed` guard; carried from round-2 F-020 point 2. If `run` throws synchronously inside a late detach-end drain (runLine -> foregroundOperation.begin() on a disposed owner), the exception escapes `end` as an unhandled rejection of the derived promise and the line already taken from the queue is lost.",
    "impact": "No outcome reproduced in a real shell. Needs detached work (a /model picker) still pending when the shell is torn down while lines are queued behind a running turn. The bus wake is safe because isIdle checks !destroyed. The shape is the same as before the fix, so it is not a regression.",
    "suggested_fix": "Optional: a `shouldDrain: () => boolean` dep (shell passes `() => !destroyed && !foregroundOperation.isDisposed`) checked in drainWhenIdle.",
    "evidence": "research-evidence/logic-probe.ts probe 1; research-evidence/highload-wake-repro.ts P7 and P10; tui-shell.ts 3983-3985.",
    "confidence": "low",
    "pre_existing": true,
    "location_class": "pre-existing"
  },
  {
    "id": "F-028",
    "reviewer": "review-clean-code",
    "severity": "info",
    "file": "src/tui/main-queue.ts",
    "line": 269,
    "quote": "const drain = (): DrainOutcome => {",
    "problem": "Three small points on the new factory. (1) The returned `onTurnSettle` and `onForegroundOperationComplete` have identical bodies (both return on the hand-off, then drain); a shared local would state the intent once. (2) `drain` returns a DrainOutcome that no caller reads once the onSettle call moved inside it. (3) `detachSlashWork` in tui-shell.ts is a pass-through to `drainSites.detach`.",
    "impact": "No observable outcome; reading cost only.",
    "suggested_fix": "None required; fold into the next edit of the file.",
    "evidence": "main-queue.ts 269-301; tui-shell.ts 7971.",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff"
  },
  {
    "id": "F-029",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/tui/tui-hold.test.ts",
    "line": 160,
    "quote": "expect(source).not.toContain(\"detachedSlashWork\")",
    "problem": "Test hygiene in the round-3 delta. This line is missing its semicolon. Several new test titles carry bare finding ids as their only description. The shell wiring (`queue: () => mainQueue,`, the bus `isIdle` term `!drainSites.workInFlight() &&`) is pinned by source text only in tui-hold, busy-dispatch, tui-bus and tui-shell tests; the shell cannot be mounted headless, so that is the available seam, and the behaviour behind each pin is covered in main-queue-drain.test.ts.",
    "impact": "No observable outcome. A formatting nit, a naming nit, and a reminder that the shell binding is guarded by text rather than by behaviour (round-1 Q1 is still with the operator).",
    "suggested_fix": "Add the semicolon; name the cases by behaviour rather than by finding id.",
    "evidence": "src/tui/tui-hold.test.ts:160; main-queue-drain.test.ts 256 onward; mutants S01 and S02 are killed by the text pins.",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff"
  }
]
```
