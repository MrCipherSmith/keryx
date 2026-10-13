# vantage-review — PR 1003 round 1

- Review id: `2026-10-13-pr-1003-round1-95d3f883`
- Target: MrCipherSmith/keryx PR 1003, flow 441 T3b (turn-loop extraction + headless AC1 test)
- Head: `95d3f883187a86d15b2110a5f50524c9f9e477cc`; merge-base `cf7d4e69375fdfd32a72db4ba26ee924260a59d5`; branch `feat/flow-441-t3b-headless-shell`
- Mode: all (9 reviewers: architecture, clean-code, highload, logic, performance, regression, security-code, style, testing-practices) + review-verifier + mutation pass + severity-audit

## Verdict

**Shell behaviour is unchanged.** Reading the diff against the merge-base and the 42-mutant pass agree: the queue has one owner (`turnLoop.queue` is a getter over the single `queue` binding; `setQueue`, `getQueue`, `replaceQueue` and the drain's `queue: () => queue` all see the same array), so the PR 999 round-2 stale-queue class does not come back; Force hand-off (`forced: forceHandoff`) and the `replaceQueue` call at Force are intact; `onSettle` reaches the bus wake; push, paint, say order and `source` forwarding are the same at all four former push sites. No blocker was found by reading.

**The AC1 test is real but narrow.** `turn-loop.test.ts` runs the real `createTurnLoop`, `createRemoteQueueWiring` and `createMainQueueDrain` against a fake `runLine`, so it fails for a break inside the module: of the 25 mutants applied to `turn-loop.ts`, 13 were killed and 12 survived (killed: the drain's `queue`, `run`, `forced`, `onSettle` and `turnWorkInFlight`, the `/new`-class gate, the notice, `setQueue`, the `source` forwarding; survived: ids, positions, display split, paint, the idle guard, the forced item, `replaceQueue`, Telegram `getQueue`, `onDetachedFailure`). It cannot fail for a break in the shell's own `createTurnLoop({...})` call or in `runLine`'s busy routing: `runLine`/`source`, `getBridge`, `say` and `onDetachedFailure` in that call have no needle (4 of 4 mutants survived), while the drain, force, settle and call-site mutants are killed by the existing source-text tests (13 of 13). The gap is the same as in the base; the PR does not close it for those lambdas, and its wording (module header, describe title, PR body) reads wider than it is. See F-002 to F-005.

Nothing here ships a behaviour defect. F-002 to F-005 were written as minor test-coverage findings; `keryx review severity-audit` raised each to major mechanically, because a mutant they cite survived on a changed file. I did not override that: the survivors are real and sit in code this PR moved or created. My own reading is that they are test-coverage majors, not shipped-behaviour majors, and that F-003 (`replaceQueue` no-op leaves `/queue remove` and Force green) and F-004 (paint, forced item, idle guard) matter most; F-002 describes lambdas that were already unpinned at the merge-base, so it is the least tied to this PR. Whether they block merge or become follow-up tests is the operator's call; none of them is a reason to think the shell now behaves differently.

## Findings by severity

blocker 0 | major 4 | minor 8 | info 2 (pre-existing counted in their lane)

### Blocker

none

### Major

- **F-002 (major [raised by severity-audit: mutation-1.json#S06-shell-runLine-source-dropped], review-testing-practices)** `src/tui/tui-shell.ts:5019`
  - Problem: The AC1 test drives a fake turn runner against `createTurnLoop`, not the shell. It fails for a break inside turn-loop.ts, but not for a break in the shell's `createTurnLoop({...})` call or in `runLine`'s busy branch. In that call `runLine` (which forwards `source`), `getBridge`, `say`, the `onDetachedFailure` body and the `remote.composer` block have no test and no source-text needle (the base had none either). The fake also models only the happy busy branch: `line.startsWith("/")` picks `enqueueWhileBusy` or `enqueue`, where the real `runLine` first runs `classifyBusyDispatch`, `requeuePendingEdit`, the lease-held branch and an asynchronous recipient dock. The describe title 'AC1: a slash command queued behind a turn does not strand ...' therefore reads as end-to-end coverage that it is not; the header of turn-loop.test.ts admits the limit, the module header and the PR description do not.
  - Impact: Trigger: an edit drops `source` from the shell's `runLine` lambda, points `getBridge` at nothing, or silences `say`. Outcome: a drained Telegram line runs without its source and loses its reply path, or the queued-as-q<N> notices vanish, while all 372 queue/hold/bus/shell tests stay green. Not a regression of this PR (the same lambdas were unpinned in the shell before), but the PR's stated gain, 'AC1 is testable without the shell', does not extend to them.
  - Fix: Add source-text needles in tui-hold.test.ts for `runLine: (line, origin, source) => runLine(line, origin, source),`, `getBridge: () => remoteBridge,` and `say: (text) => io.onSystem?.(text),` inside the createTurnLoop block; or build the dep object in a small exported factory a test can call with spies. Word the describe title and the PR body as 'the turn-loop module under a modelled runLine'.
  - Evidence: mutant:S06-shell-runLine-source-dropped, mutant:S07-shell-getBridge-undefined, mutant:S08-shell-say-noop, mutant:S05-shell-onDetachedFailure-silent (mutation pass, research-evidence/mutation-1.json). Reading: turn-loop.test.ts lines 51-73 against the tui-shell.ts runLine busy branch (8589-8670, 9434). Reported by testing-practices (F-001, F-010), logic (F-004), architecture (F-001) and security (info).
  - Class scope: 4 site(s) (tui-shell.ts createTurnLoop call: runLine/source forwarding (S06); tui-shell.ts createTurnLoop call: getBridge (S07); tui-shell.ts createTurnLoop call: say (S08); tui-shell.ts createTurnLoop call: onDetachedFailure (S05)); enumerated by: mutation pass: the four shell-call mutants S05-S08 survived; the other 13 shell mutants were killed (mutation-1.json).
- **F-003 (major [raised by severity-audit: mutation-1.json#T14-replaceQueue-noop], review-testing-practices)** `src/tui/turn-loop.ts:90`
  - Problem: `replaceQueue` is the entry point of the PR 999 stale-queue class for `/queue remove`, `/queue edit` and Force, and `remote.getQueue` is how Telegram lines reach the same array. turn-loop.test.ts has no test for either on the real loop: the stale-queue case goes through `removeMainQueue` (the `setQueue` path), the Telegram case uses `enqueueWhileBusy(..., TG_SOURCE)` instead of `enqueueTelegramLine`, and `replaceQueue` is pinned in the shell only by a text needle in tui-shell.test.ts.
  - Impact: Trigger: `replaceQueue` becomes a no-op, or `getQueue` returns a copy. Outcome: `/queue remove` and Force appear to succeed while the line still runs, or Telegram lines are pushed onto an array the drain no longer reads and are stranded. All ten turn-loop tests stay green.
  - Fix: Add two tests: enqueue two lines while busy, `replaceQueue([second])`, settle, and assert only the second runs; call `loop.remote.enqueueTelegramLine(...)` while busy, then `replaceQueue(...)` and settle, and assert the Telegram line still runs with its source.
  - Evidence: mutant:T14-replaceQueue-noop, mutant:T16-remote-getQueue-copy (mutation pass, research-evidence/mutation-1.json). Reported by logic (F-001) and testing-practices (F-003, F-007).
  - Class scope: 2 site(s) (turn-loop.ts replaceQueue (T14); turn-loop.ts remote getQueue (T16)); enumerated by: mutation pass: T14 and T16 survived while T15 (setQueue) and S13 (shell Force replaceQueue call) were killed (mutation-1.json).
- **F-004 (major [raised by severity-audit: mutation-1.json#T08-enqueue-no-paint], review-testing-practices)** `src/tui/turn-loop.ts:103`
  - Problem: The harness `paint` is a no-op and the base's `paintMainQueue();` text pins at the held gate and the push sites were removed by this PR, so nothing asserts that `enqueue` repaints after the push or that the idle dispatch repaints before it runs the head. `drainWhenIdle` is tested only with an idle runner and an empty force hand-off: neither the forced branch (`takeForced`) nor the guard (`isIdle` false must dispatch nothing) has a test.
  - Impact: Trigger: an edit removes either `deps.paint()` call, drops `takeForced`, or hard-wires `isIdle`. Outcome: a stale queue panel, a forced line skipped at the recipient choice, or a recipient-choice answer dispatched into a running turn, with a green suite.
  - Fix: Make the harness `paint` a counter that records the queue length at call time and assert it after `enqueue`, `enqueueWhileBusy` and the idle dispatch; add two cases: `drainWhenIdle` while busy dispatches nothing, and with a forced item pending it runs the forced line first.
  - Evidence: mutant:T08-enqueue-no-paint, mutant:T13-idle-dispatch-no-paint, mutant:T11-idle-takeForced-undefined, mutant:T12-idle-isIdle-always-true (mutation pass). Reported by logic (F-001) and testing-practices (F-002, F-006).
  - Class scope: 4 site(s) (turn-loop.ts enqueue paint (T08); turn-loop.ts idle dispatch paint (T13); turn-loop.ts idle takeForced (T11); turn-loop.ts idle isIdle guard (T12)); enumerated by: mutation pass: T08, T11, T12, T13 survived (mutation-1.json).
- **F-005 (major [raised by severity-audit: mutation-1.json#T07-remote-nextId-constant], review-testing-practices)** `src/tui/turn-loop.ts:59`
  - Problem: Item ids, positions beyond q1, the question/display split and the detach failure path are not asserted. Every harness call passes `line === displayLine`, ids are never read, the 'queued as q<N>' position is checked only for N=1, `failures` is recorded by the harness but never asserted, and no test makes a detached run reject.
  - Impact: Trigger: a constant id, a constant return of 1, a question/display swap (also of the `line`/`displayLine` arguments of `enqueueWhileBusy`), or a no-op `onDetachedFailure`. Outcome: duplicate ids break `/queue remove|edit` targeting, a wrong number misleads the operator, the display text reaches the model, or a failed `/model` goes unreported, all with a green suite.
  - Fix: Give the harness distinct display strings and assert the item fields and the line the runner receives; enqueue three lines while busy and assert q1, q2, q3 and distinct ids; make the fake `/model` detach reject once and assert `h.failures`, or delete the field.
  - Evidence: mutant:T07-remote-nextId-constant, mutant:T07b-enqueue-id-constant, mutant:T21-enqueue-returns-1, mutant:T17-enqueue-question-display-swapped, mutant:T20-whileBusy-line-display-swapped, mutant:T05-drain-onDetachedFailure-noop (mutation pass). Reported by logic (F-001) and testing-practices (F-004, F-005, F-008).
  - Class scope: 6 site(s) (turn-loop.ts remote nextId (T07); turn-loop.ts enqueue id (T07b); turn-loop.ts enqueue return position (T21); turn-loop.ts enqueue question/display (T17); turn-loop.ts enqueueWhileBusy line/display (T20); turn-loop.ts drain onDetachedFailure (T05)); enumerated by: mutation pass: T05, T07, T07b, T17, T20, T21 survived (mutation-1.json).

### Minor

- **F-001 (minor, review-clean-code)** `src/tui/tui-shell.ts:3869`
  - Problem: The PR deleted `let mainQueue` and `mainQueueSeq` from the shell, but comments still name `mainQueue` as a closure variable: tui-shell.ts 3869, 3913, 3926, 9982 and 10145 (the four before 10145 are the declaration-order notes that explain the TDZ ordering of the remote bridge and the bus wake), main-queue.ts 4, bus-wake.ts 12 and 76, shell-chrome.ts 409 and 922. The queue is now `turnLoop.queue` and `turnLoop` is built near line 5005, so the 'declared further down / above this point' claims also changed. Reported independently by five reviewers (clean-code, style, architecture, logic, highload).
  - Impact: Trigger: a maintainer follows a TDZ comment to learn what the bridge host and the bus wake wait for. Outcome: a grep for `mainQueue` finds only comments, the real owner (`turnLoop`) is not named, and the declaration-order reasoning points at a binding that no longer exists. Maintenance cost only; no runtime effect.
  - Fix: Replace `mainQueue` with `turnLoop` (or `turnLoop.queue`) in the five tui-shell.ts comments and recheck the 'exists only now / declared above' claims against the position of `createTurnLoop` (~5005). Say 'the main queue' in prose in the other four files, and reword main-queue.ts:4 to name turn-loop.ts as the owner.
  - Evidence: keryx ctx rg --all 'mainQueue\b' over src/tui, non-test: only comment hits, no code identifier left (clean-code, style, architecture, logic and regression each ran it).
- **F-006 (minor, review-style)** `src/tui/remote-queue-wiring.test.ts:419`
  - Problem: The same two-line turn-loop.ts needle (`readFileSync(turn-loop.ts)` and `remote.runQueued(` counted twice) is pasted into three tests, at the end of the one it belongs to (AC4) and at the end of the flow 399 T-2 (topic-history restore) and flow 397 L-1 (modal change subscription) tests, which are about neither the queue nor the drain. busy-dispatch.test.ts also pins the module's internal text `queue: () => queue,`, which turn-loop.test.ts now covers by behaviour (the stale-queue case). Reported by style, architecture, regression and testing-practices.
  - Impact: Trigger: moving or renaming one `remote.runQueued(` call in turn-loop.ts. Outcome: three tests fail, two of them with a title about something else, and the failure points the reader at the wrong subject. Source-text pins on a module that now has behavioural tests are the pattern this PR set out to remove.
  - Fix: Keep the count once, in the AC4 test the comment refers to, and delete the other two. Drop the `queue: () => queue,` needle from busy-dispatch.test.ts if the behavioural stale-queue case is judged enough.
  - Evidence: git diff of remote-queue-wiring.test.ts: three hunks add the same two lines (about lines 419, 446 and 476); `keryx ctx rg -F 'remote.runQueued(' src/tui/remote-queue-wiring.test.ts` returns 3 matches.
  - Class scope: 3 site(s) (src/tui/remote-queue-wiring.test.ts: AC4 test (kept); src/tui/remote-queue-wiring.test.ts: flow 399 T-2 test; src/tui/remote-queue-wiring.test.ts: flow 397 L-1 test); enumerated by: keryx ctx rg -F 'remote.runQueued(' over src/tui/remote-queue-wiring.test.ts.
- **F-007 (minor, review-architecture)** `src/tui/turn-loop.ts:4`
  - Problem: The module header misstates what moved and does not say where the seam stops. The drain was already one `createMainQueueDrain` (PR 999), so its sites were not loose closures; what moved here is the queue array, the id counter, the busy-time enqueue step and the composition of remote wiring and drain. 'Four' counts the factory's methods (including `detach`), while the sibling test header says 'the three drain sites'. The header reads as if AC1 is now covered, but it does not name what stays outside the seam: the busy branch of `runLine` in tui-shell.ts (the `classifyBusyDispatch` cases, `requeuePendingEdit`, the lease-held enqueue, the async recipient dock), which the test replaces with a fake. The `say` dep is documented as 'One line' although callers add their own trailing newline.
  - Impact: Trigger: a maintainer edits the real busy branch (a new `classifyBusyDispatch` case, a reordered lease check). Outcome: they read 'AC1 ... here now', assume the shell's busy routing is under test, and turn-loop.test.ts stays green. The 113 lines against the 250-400 the operator asked for are not explained where the next maintainer looks.
  - Fix: Rewrite the header: say that the queue, the counter, the busy-time enqueue step and the remote/drain composition live here; add a 'Not covered' paragraph naming `runLine`'s busy routing and the source-text tests that pin its calls (busy-dispatch, tui-bus, tui-hold, remote-queue-wiring); use one count and name the drain methods; document `say` as 'text with its own trailing newline'.
  - Evidence: turn-loop.ts lines 1-8 and 25-26; turn-loop.test.ts lines 1-11; main-queue.ts createMainQueueDrain (PR 999) and its methods; tui-shell.ts base diff (the old code already built `drainSites = createMainQueueDrain({`).
- **F-008 (minor, review-logic)** `src/tui/turn-loop.ts:1`
  - Problem: The PR description makes claims the diff does not support. (a) It cites a mutation table 'in turn-loop.ts'; neither turn-loop.ts nor turn-loop.test.ts contains one, and the commit message has none. (b) The counts it gives for three mutants (6, 6, 5 failing tests) differ from a re-run (7, 6, 6). (c) It says `enqueueWhileBusy` replaces 'four push sites of runLine': it replaces one, the other three use `enqueue`, and counting the remote wiring's `nextId` there are five id producers, not four or six. (d) 'mainQueue ... are gone from the shell' holds for identifiers only (see F-001).
  - Impact: Trigger: a reviewer tries to re-check the mutation evidence that justifies the thin seam. Outcome: it cannot be found in the repository, and the wording overstates how much the extraction centralised. No runtime effect.
  - Fix: Put the mutation table in the PR body or the turn-loop.test.ts header with the exact mutations, or drop the claim; correct the push-site wording.
  - Evidence: grep -i 'mutation|survived' over turn-loop.ts and turn-loop.test.ts returns nothing (logic, architecture); 17 mutations re-run by logic on a scratch copy; git diff of the five push sites. The mutation pass of this round (research-evidence/mutation-1.md) is the table the PR could carry.
- **F-009 (minor, review-architecture)** `src/tui/tui-shell.ts:8669`
  - Problem: The shell still holds a second copy of the idle predicate: `turnWorkInFlight` in the `createTurnLoop({...})` call and the `isIdle` lambda passed to `turnLoop.drainWhenIdle` at the recipient choice repeat the same three terms (`chrome.isBusy()`, `foregroundOperation.isActive`, `forceHandoff.isAwaitingSettlement`), the lambda adding `!destroyed` and the lease. The module's `drainWhenIdle(isIdle)` also shares its name with the unrelated `drainWhenIdle` inside `createMainQueueDrain` (main-queue.ts ~282), which checks `workInFlight()` (detached slash work included) and loops through `drainNext`; the loop's method takes a caller predicate, dispatches one item and does not consult detached work. The name hides that difference, and the module claims the shell keeps no second copy.
  - Impact: Trigger: someone edits the idle predicate in one place, or applies the PR 999 F-025/F-026 fix to the wrong `drainWhenIdle`. Outcome: the two copies drift, or the recipient-choice drain keeps ignoring detached work while every other site honours it (see F-014). Maintenance cost; behaviour equals the merge-base.
  - Fix: Let `TurnLoop.drainWhenIdle` take only the extra terms (`!destroyed`, lease not held) and AND them with `drain.workInFlight()` inside turn-loop.ts, so the three base terms and detached work live once; rename one of the two methods (for example `drainAfterRecipientChoice`) and say in its doc comment what it does not consult.
  - Evidence: tui-shell.ts 5018 (`turnWorkInFlight`) and 8669-8677 (`isIdle` lambda); main-queue.ts 270 and 282-285; turn-loop.ts 100-109; turn-loop.test.ts 207 uses `() => !h.busy`. Reported by architecture (F-003), highload (F-001) and style (F-004).
- **F-010 (minor, review-clean-code)** `src/tui/turn-loop.ts:47`
  - Problem: `enqueueWhileBusy` reads as an unconditional push like `enqueue`, but it first consults `deferredBusyAction(line, commandName)` and returns false without queuing for a session-replacing command; the meaning of the boolean ('false: the caller must refuse') lives only in the doc comment. `enqueue(line, displayLine, source?)` and `enqueueWhileBusy(line, displayLine, commandName, source?)` take two adjacent same-typed strings, so a swapped `line`/`displayLine` type-checks.
  - Impact: Trigger: a reader of `if (turnLoop.enqueueWhileBusy(...)) return;` at a call site. Outcome: they must open the interface to learn that false means 'not queued, fall through to the refusal'. No wrong behaviour today (argument order matches the former code at every site).
  - Fix: Rename for what it does (for example `tryQueueBehindTurn`), or pass `{ line, displayLine, source }` as one object so the two strings are named at the call site.
  - Evidence: turn-loop.ts interface lines 41-49 and body lines 94-99; the four `turnLoop.enqueue*` call sites in tui-shell.ts (8592 `enqueueWhileBusy`; 8625, 8665 and 9437 `enqueue`).
- **F-011 (minor, review-architecture)** `src/tui/turn-loop.ts:39`
  - Problem: The `queue` getter hands out the live array typed as mutable, next to a `replaceQueue` that exists so the array can be swapped. Every shell caller only reads it (`.length`, an index, `.map`, and the pure `removeMainQueueItem(turnLoop.queue, index)`), so nothing needs write access, yet a future `turnLoop.queue.push(...)` would skip the id counter and the paint that `enqueue` owns. `drain` is typed `ReturnType<typeof createMainQueueDrain<QueuedMainQuestion>>` (an instantiation expression inside `ReturnType`, where main-queue.ts exports no named type), and the shell immediately aliases `remote` and `drain` (`const remoteQueue = turnLoop.remote;`, `const drainSites = turnLoop.drain;`), keeping a second vocabulary for the same objects.
  - Impact: Trigger: a caller pushes to `turnLoop.queue` directly. Outcome: an item without a counter id or a repaint, the duplication this change removes. The alias form ties turn-loop.ts to the factory's inferred shape and makes the drain's method set invisible from the interface. Readability and a latent footgun; not a defect today.
  - Fix: Type the getter `readonly queue: readonly QueuedMainQuestion[]` (the shell never mutates it; `drainIdleMainQueue` keeps the internal mutable reference), export a named `MainQueueDrain` type from main-queue.ts and use it for `drain`, and either keep the shell aliases deliberately for the source-text needles and say so, or call `turnLoop.drain.*` directly.
  - Evidence: turn-loop.ts lines 37-52; tui-shell.ts has about 25 `turnLoop.queue` references and none mutates the array (a regex for push/splice/shift/pop/unshift/sort/reverse/`length =`/indexed assignment over src/tui returns 0 matches; the verifier re-ran it). Reported by architecture (F-002), clean-code (F-004, F-006) and style (F-006).
- **F-012 (minor, review-clean-code)** `src/tui/turn-loop.ts:70`
  - Problem: The id scheme `mq${seq++}` is written twice inside `createTurnLoop`: in `enqueue` and as `nextId` for the remote wiring. The PR's stated purpose is that the counter has one owner, yet the format lives in two places.
  - Impact: Trigger: the id format changes (prefix, padding). Outcome: one site is updated and the other missed, giving two id shapes in one queue and breaking `/queue edit|remove` matching. Cheap to prevent now.
  - Fix: Add `const nextId = (): string => `mq${seq++}`;` next to `let seq` and use it in `enqueue` and in `createRemoteQueueWiring({ nextId, ... })`.
  - Evidence: turn-loop.ts line 59 (`id: `mq${seq++}``) and line 70. Reported by clean-code (F-002) and style (F-005).

### Info

- **F-013 (info, review-clean-code)** `src/tui/turn-loop.test.ts:36`
  - Problem: The harness is a mutable bag built in two passes: `loop` is cast in as `undefined as unknown as TurnLoop` and assigned after `createTurnLoop` because `settleTurn` and the fake `runLine` close over `h`. The fake `runLine` has an unused `_origin` parameter, a non-null `detachedWork.shift()!`, and re-implements the shell's slash-name extraction inline (`line.split(/\s+/)[0]`). Test 8 flushes a detached run with one bare `await new Promise((done) => setTimeout(done, 0))` macrotask, which is deterministic today (the detached work resolves in microtasks).
  - Impact: No demonstrated harm: eslint is clean and the suite is deterministic (166 ms). If the shell's slash-name parsing changes, the model silently diverges (the header already says so).
  - Fix: Declare `let loop!: TurnLoop` inside the harness builder or build the state first; drop `_origin`; await the detached promise the harness already holds instead of a timer.
  - Evidence: turn-loop.test.ts lines 36, 51-60, 203; `bunx eslint` on both new files exits 0 (style). Reported by clean-code (F-005), style (F-007) and testing-practices (F-012).

## Questions

1. The operator asked for roughly 250 to 400 lines of extraction and this lands 113 lines of module. Is the thin seam (queue, counter, busy-time enqueue, remote and drain composition) the intended T3b, with the shell's `runLine` busy routing left for a later task? F-007 asks only that the header say so.
2. Is a factory for the shell's `createTurnLoop({...})` dependency object (so `runLine`, `getBridge`, `say` and `onDetachedFailure` can be reached by a test) in scope for T3b or T3c? If T3c, F-002 is a recorded follow-up and not a request for this PR.
3. Should the PR's mutation table (cited in the description, absent from the repository) land in the PR body or the test header? The mutation pass of this round, `research-evidence/mutation-1.md`, can serve as that table (F-008).

## Pre-existing (never blocks)

- **F-014 (info, review-highload)** `src/tui/tui-shell.ts:8669`
  - Problem: The recipient-choice idle drain dispatches one item with a predicate that does not read `drainSites.workInFlight()`, so a late 'main' recipient answer that lands while detached slash work (for example `/model`) is still running and the turn is idle starts the queue head beside that work; an inline slash line dispatched there also leaves the lines behind it stranded. The merge-base `drainIdleMainQueue(mainQueue, {isIdle, takeForced, dispatch})` call had the same predicate, and turn-loop.ts reproduces it. This is the known PR 999 F-025 and F-026 gap, carried unchanged by this PR; reading only, not run in the shell.
  - Impact: Pre-existing: no change in behaviour at this site, and the operator can already type a line beside detached work. It never blocks. Recorded so the F-025/F-026 fix is applied to this site as well (see F-009).
  - Fix: Close it with the F-025/F-026 follow-up (flow 441 deferred items), together with F-009's single predicate.
  - Evidence: Merge-base tui-shell.ts call of `drainIdleMainQueue` with the same predicate; turn-loop.ts 100-109; main-queue.ts 270 and 282-285; PR 999 round-3 findings F-025 and F-026. Reported by highload (F-001) and architecture (F-003).
- The detached-work gap is the known PR 999 F-025 and F-026 pair; F-014 only records that the recipient-choice site carries it unchanged and that the fix has to cover it too.
- Out of scope and untouched: the 2 failures in `src/tui/ci-triage-source.test.ts`; five scope paths under `.metaproject/data/**` (uncommitted machine artifacts, not part of the PR) were ignored.

## Verified clean

- Queue identity: no reader of the queue holds a reference across a replacement; `turnLoop.queue` is read through the getter at every shell site, and no site in `src/tui` mutates it (regression, architecture, verifier site-check). Mutants T01, T15 and S13 (queue empty, `setQueue` no-op, Force `replaceQueue` dropped) were killed.
- Force hand-off and drain composition: `forced`, `onSettle`, `turnWorkInFlight` (both dropped terms), `run`, the drain object identity and the settle, lease-release and foreground-complete sites are pinned (T02, T03, T04, T06, S01 to S04, S14 to S17 killed).
- Busy-time enqueue: the `/new`, `/clear`, `/resume` refusal is intact (T09 and T09b killed); the shell still falls through to the refusal notice on `false`; `source` forwarding at the three source-carrying sites (S09 to S11, T18, T19 killed); the recipient-choice enqueue never carried `source` and still does not.
- Trust boundaries (security-code): `source` gates only echo labelling and Telegram reply routing, not permissions; `terminalSafe` is still applied in `onDetachedFailure`; no injection, path, secret or crypto surface touched.
- Cost (performance, highload): the getter is O(1); no new allocation on a per-event path beyond the old inline code; no new unbounded queue, retry or backpressure change; the new suite runs in 166 ms.
- Static checks: eslint clean on both new files; `classifyBusyDispatch` still used at two sites, so the narrowed import is correct.

## Findings (machine-readable)

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "quote": "`mainQueue`, which do not exist yet, while `onDestroy` and the approval/reply",
    "problem": "The PR deleted `let mainQueue` and `mainQueueSeq` from the shell, but comments still name `mainQueue` as a closure variable: tui-shell.ts 3869, 3913, 3926, 9982 and 10145 (the four before 10145 are the declaration-order notes that explain the TDZ ordering of the remote bridge and the bus wake), main-queue.ts 4, bus-wake.ts 12 and 76, shell-chrome.ts 409 and 922. The queue is now `turnLoop.queue` and `turnLoop` is built near line 5005, so the 'declared further down / above this point' claims also changed. Reported independently by five reviewers (clean-code, style, architecture, logic, highload).",
    "impact": "Trigger: a maintainer follows a TDZ comment to learn what the bridge host and the bus wake wait for. Outcome: a grep for `mainQueue` finds only comments, the real owner (`turnLoop`) is not named, and the declaration-order reasoning points at a binding that no longer exists. Maintenance cost only; no runtime effect.",
    "suggested_fix": "Replace `mainQueue` with `turnLoop` (or `turnLoop.queue`) in the five tui-shell.ts comments and recheck the 'exists only now / declared above' claims against the position of `createTurnLoop` (~5005). Say 'the main queue' in prose in the other four files, and reword main-queue.ts:4 to name turn-loop.ts as the owner.",
    "evidence": "keryx ctx rg --all 'mainQueue\\b' over src/tui, non-test: only comment hits, no code identifier left (clean-code, style, architecture, logic and regression each ran it).",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 3869
  },
  {
    "id": "F-002",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "quote": "runLine: (line, origin, source) => runLine(line, origin, source),",
    "problem": "The AC1 test drives a fake turn runner against `createTurnLoop`, not the shell. It fails for a break inside turn-loop.ts, but not for a break in the shell's `createTurnLoop({...})` call or in `runLine`'s busy branch. In that call `runLine` (which forwards `source`), `getBridge`, `say`, the `onDetachedFailure` body and the `remote.composer` block have no test and no source-text needle (the base had none either). The fake also models only the happy busy branch: `line.startsWith(\"/\")` picks `enqueueWhileBusy` or `enqueue`, where the real `runLine` first runs `classifyBusyDispatch`, `requeuePendingEdit`, the lease-held branch and an asynchronous recipient dock. The describe title 'AC1: a slash command queued behind a turn does not strand ...' therefore reads as end-to-end coverage that it is not; the header of turn-loop.test.ts admits the limit, the module header and the PR description do not.",
    "impact": "Trigger: an edit drops `source` from the shell's `runLine` lambda, points `getBridge` at nothing, or silences `say`. Outcome: a drained Telegram line runs without its source and loses its reply path, or the queued-as-q<N> notices vanish, while all 372 queue/hold/bus/shell tests stay green. Not a regression of this PR (the same lambdas were unpinned in the shell before), but the PR's stated gain, 'AC1 is testable without the shell', does not extend to them.",
    "suggested_fix": "Add source-text needles in tui-hold.test.ts for `runLine: (line, origin, source) => runLine(line, origin, source),`, `getBridge: () => remoteBridge,` and `say: (text) => io.onSystem?.(text),` inside the createTurnLoop block; or build the dep object in a small exported factory a test can call with spies. Word the describe title and the PR body as 'the turn-loop module under a modelled runLine'.",
    "evidence": "mutant:S06-shell-runLine-source-dropped, mutant:S07-shell-getBridge-undefined, mutant:S08-shell-say-noop, mutant:S05-shell-onDetachedFailure-silent (mutation pass, research-evidence/mutation-1.json). Reading: turn-loop.test.ts lines 51-73 against the tui-shell.ts runLine busy branch (8589-8670, 9434). Reported by testing-practices (F-001, F-010), logic (F-004), architecture (F-001) and security (info).",
    "confidence": "medium",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 5019,
    "class_scope": {
      "sites": [
        "tui-shell.ts createTurnLoop call: runLine/source forwarding (S06)",
        "tui-shell.ts createTurnLoop call: getBridge (S07)",
        "tui-shell.ts createTurnLoop call: say (S08)",
        "tui-shell.ts createTurnLoop call: onDetachedFailure (S05)"
      ],
      "enumeration_method": "mutation pass: the four shell-call mutants S05-S08 survived; the other 13 shell mutants were killed (mutation-1.json)."
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#S06-shell-runLine-source-dropped"
    },
    "severity_label": "raised by severity-audit: mutation-1.json#S06-shell-runLine-source-dropped"
  },
  {
    "id": "F-003",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/turn-loop.ts",
    "quote": "replaceQueue(next) {",
    "problem": "`replaceQueue` is the entry point of the PR 999 stale-queue class for `/queue remove`, `/queue edit` and Force, and `remote.getQueue` is how Telegram lines reach the same array. turn-loop.test.ts has no test for either on the real loop: the stale-queue case goes through `removeMainQueue` (the `setQueue` path), the Telegram case uses `enqueueWhileBusy(..., TG_SOURCE)` instead of `enqueueTelegramLine`, and `replaceQueue` is pinned in the shell only by a text needle in tui-shell.test.ts.",
    "impact": "Trigger: `replaceQueue` becomes a no-op, or `getQueue` returns a copy. Outcome: `/queue remove` and Force appear to succeed while the line still runs, or Telegram lines are pushed onto an array the drain no longer reads and are stranded. All ten turn-loop tests stay green.",
    "suggested_fix": "Add two tests: enqueue two lines while busy, `replaceQueue([second])`, settle, and assert only the second runs; call `loop.remote.enqueueTelegramLine(...)` while busy, then `replaceQueue(...)` and settle, and assert the Telegram line still runs with its source.",
    "evidence": "mutant:T14-replaceQueue-noop, mutant:T16-remote-getQueue-copy (mutation pass, research-evidence/mutation-1.json). Reported by logic (F-001) and testing-practices (F-003, F-007).",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 90,
    "class_scope": {
      "sites": [
        "turn-loop.ts replaceQueue (T14)",
        "turn-loop.ts remote getQueue (T16)"
      ],
      "enumeration_method": "mutation pass: T14 and T16 survived while T15 (setQueue) and S13 (shell Force replaceQueue call) were killed (mutation-1.json)."
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#T14-replaceQueue-noop"
    },
    "severity_label": "raised by severity-audit: mutation-1.json#T14-replaceQueue-noop"
  },
  {
    "id": "F-004",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/turn-loop.ts",
    "quote": "takeForced: () => deps.forced.takeNext(),",
    "problem": "The harness `paint` is a no-op and the base's `paintMainQueue();` text pins at the held gate and the push sites were removed by this PR, so nothing asserts that `enqueue` repaints after the push or that the idle dispatch repaints before it runs the head. `drainWhenIdle` is tested only with an idle runner and an empty force hand-off: neither the forced branch (`takeForced`) nor the guard (`isIdle` false must dispatch nothing) has a test.",
    "impact": "Trigger: an edit removes either `deps.paint()` call, drops `takeForced`, or hard-wires `isIdle`. Outcome: a stale queue panel, a forced line skipped at the recipient choice, or a recipient-choice answer dispatched into a running turn, with a green suite.",
    "suggested_fix": "Make the harness `paint` a counter that records the queue length at call time and assert it after `enqueue`, `enqueueWhileBusy` and the idle dispatch; add two cases: `drainWhenIdle` while busy dispatches nothing, and with a forced item pending it runs the forced line first.",
    "evidence": "mutant:T08-enqueue-no-paint, mutant:T13-idle-dispatch-no-paint, mutant:T11-idle-takeForced-undefined, mutant:T12-idle-isIdle-always-true (mutation pass). Reported by logic (F-001) and testing-practices (F-002, F-006).",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 103,
    "class_scope": {
      "sites": [
        "turn-loop.ts enqueue paint (T08)",
        "turn-loop.ts idle dispatch paint (T13)",
        "turn-loop.ts idle takeForced (T11)",
        "turn-loop.ts idle isIdle guard (T12)"
      ],
      "enumeration_method": "mutation pass: T08, T11, T12, T13 survived (mutation-1.json)."
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#T08-enqueue-no-paint"
    },
    "severity_label": "raised by severity-audit: mutation-1.json#T08-enqueue-no-paint"
  },
  {
    "id": "F-005",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/turn-loop.ts",
    "quote": "queue.push({ id: `mq${seq++}`, question: line, displayQuestion: displayLine,",
    "problem": "Item ids, positions beyond q1, the question/display split and the detach failure path are not asserted. Every harness call passes `line === displayLine`, ids are never read, the 'queued as q<N>' position is checked only for N=1, `failures` is recorded by the harness but never asserted, and no test makes a detached run reject.",
    "impact": "Trigger: a constant id, a constant return of 1, a question/display swap (also of the `line`/`displayLine` arguments of `enqueueWhileBusy`), or a no-op `onDetachedFailure`. Outcome: duplicate ids break `/queue remove|edit` targeting, a wrong number misleads the operator, the display text reaches the model, or a failed `/model` goes unreported, all with a green suite.",
    "suggested_fix": "Give the harness distinct display strings and assert the item fields and the line the runner receives; enqueue three lines while busy and assert q1, q2, q3 and distinct ids; make the fake `/model` detach reject once and assert `h.failures`, or delete the field.",
    "evidence": "mutant:T07-remote-nextId-constant, mutant:T07b-enqueue-id-constant, mutant:T21-enqueue-returns-1, mutant:T17-enqueue-question-display-swapped, mutant:T20-whileBusy-line-display-swapped, mutant:T05-drain-onDetachedFailure-noop (mutation pass). Reported by logic (F-001) and testing-practices (F-004, F-005, F-008).",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 59,
    "class_scope": {
      "sites": [
        "turn-loop.ts remote nextId (T07)",
        "turn-loop.ts enqueue id (T07b)",
        "turn-loop.ts enqueue return position (T21)",
        "turn-loop.ts enqueue question/display (T17)",
        "turn-loop.ts enqueueWhileBusy line/display (T20)",
        "turn-loop.ts drain onDetachedFailure (T05)"
      ],
      "enumeration_method": "mutation pass: T05, T07, T07b, T17, T20, T21 survived (mutation-1.json)."
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#T07-remote-nextId-constant"
    },
    "severity_label": "raised by severity-audit: mutation-1.json#T07-remote-nextId-constant"
  },
  {
    "id": "F-006",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/tui/remote-queue-wiring.test.ts",
    "quote": "expect(shellOccurrences(loop, \"remote.runQueued(\")).toBe(2);",
    "problem": "The same two-line turn-loop.ts needle (`readFileSync(turn-loop.ts)` and `remote.runQueued(` counted twice) is pasted into three tests, at the end of the one it belongs to (AC4) and at the end of the flow 399 T-2 (topic-history restore) and flow 397 L-1 (modal change subscription) tests, which are about neither the queue nor the drain. busy-dispatch.test.ts also pins the module's internal text `queue: () => queue,`, which turn-loop.test.ts now covers by behaviour (the stale-queue case). Reported by style, architecture, regression and testing-practices.",
    "impact": "Trigger: moving or renaming one `remote.runQueued(` call in turn-loop.ts. Outcome: three tests fail, two of them with a title about something else, and the failure points the reader at the wrong subject. Source-text pins on a module that now has behavioural tests are the pattern this PR set out to remove.",
    "suggested_fix": "Keep the count once, in the AC4 test the comment refers to, and delete the other two. Drop the `queue: () => queue,` needle from busy-dispatch.test.ts if the behavioural stale-queue case is judged enough.",
    "evidence": "git diff of remote-queue-wiring.test.ts: three hunks add the same two lines (about lines 419, 446 and 476); `keryx ctx rg -F 'remote.runQueued(' src/tui/remote-queue-wiring.test.ts` returns 3 matches.",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/tui/remote-queue-wiring.test.ts: AC4 test (kept)",
        "src/tui/remote-queue-wiring.test.ts: flow 399 T-2 test",
        "src/tui/remote-queue-wiring.test.ts: flow 397 L-1 test"
      ],
      "enumeration_method": "keryx ctx rg -F 'remote.runQueued(' over src/tui/remote-queue-wiring.test.ts."
    },
    "line": 419
  },
  {
    "id": "F-007",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/tui/turn-loop.ts",
    "quote": "four drain sites used to be loose closures inside `launchTuiAgentShell`, where the OpenTUI renderer",
    "problem": "The module header misstates what moved and does not say where the seam stops. The drain was already one `createMainQueueDrain` (PR 999), so its sites were not loose closures; what moved here is the queue array, the id counter, the busy-time enqueue step and the composition of remote wiring and drain. 'Four' counts the factory's methods (including `detach`), while the sibling test header says 'the three drain sites'. The header reads as if AC1 is now covered, but it does not name what stays outside the seam: the busy branch of `runLine` in tui-shell.ts (the `classifyBusyDispatch` cases, `requeuePendingEdit`, the lease-held enqueue, the async recipient dock), which the test replaces with a fake. The `say` dep is documented as 'One line' although callers add their own trailing newline.",
    "impact": "Trigger: a maintainer edits the real busy branch (a new `classifyBusyDispatch` case, a reordered lease check). Outcome: they read 'AC1 ... here now', assume the shell's busy routing is under test, and turn-loop.test.ts stays green. The 113 lines against the 250-400 the operator asked for are not explained where the next maintainer looks.",
    "suggested_fix": "Rewrite the header: say that the queue, the counter, the busy-time enqueue step and the remote/drain composition live here; add a 'Not covered' paragraph naming `runLine`'s busy routing and the source-text tests that pin its calls (busy-dispatch, tui-bus, tui-hold, remote-queue-wiring); use one count and name the drain methods; document `say` as 'text with its own trailing newline'.",
    "evidence": "turn-loop.ts lines 1-8 and 25-26; turn-loop.test.ts lines 1-11; main-queue.ts createMainQueueDrain (PR 999) and its methods; tui-shell.ts base diff (the old code already built `drainSites = createMainQueueDrain({`).",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 4
  },
  {
    "id": "F-008",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/tui/turn-loop.ts",
    "quote": "// The main turn loop's queue, built once (flow 441, AC1).",
    "problem": "The PR description makes claims the diff does not support. (a) It cites a mutation table 'in turn-loop.ts'; neither turn-loop.ts nor turn-loop.test.ts contains one, and the commit message has none. (b) The counts it gives for three mutants (6, 6, 5 failing tests) differ from a re-run (7, 6, 6). (c) It says `enqueueWhileBusy` replaces 'four push sites of runLine': it replaces one, the other three use `enqueue`, and counting the remote wiring's `nextId` there are five id producers, not four or six. (d) 'mainQueue ... are gone from the shell' holds for identifiers only (see F-001).",
    "impact": "Trigger: a reviewer tries to re-check the mutation evidence that justifies the thin seam. Outcome: it cannot be found in the repository, and the wording overstates how much the extraction centralised. No runtime effect.",
    "suggested_fix": "Put the mutation table in the PR body or the turn-loop.test.ts header with the exact mutations, or drop the claim; correct the push-site wording.",
    "evidence": "grep -i 'mutation|survived' over turn-loop.ts and turn-loop.test.ts returns nothing (logic, architecture); 17 mutations re-run by logic on a scratch copy; git diff of the five push sites. The mutation pass of this round (research-evidence/mutation-1.md) is the table the PR could carry.",
    "confidence": "medium",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 1
  },
  {
    "id": "F-009",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "quote": "turnLoop.drainWhenIdle(",
    "problem": "The shell still holds a second copy of the idle predicate: `turnWorkInFlight` in the `createTurnLoop({...})` call and the `isIdle` lambda passed to `turnLoop.drainWhenIdle` at the recipient choice repeat the same three terms (`chrome.isBusy()`, `foregroundOperation.isActive`, `forceHandoff.isAwaitingSettlement`), the lambda adding `!destroyed` and the lease. The module's `drainWhenIdle(isIdle)` also shares its name with the unrelated `drainWhenIdle` inside `createMainQueueDrain` (main-queue.ts ~282), which checks `workInFlight()` (detached slash work included) and loops through `drainNext`; the loop's method takes a caller predicate, dispatches one item and does not consult detached work. The name hides that difference, and the module claims the shell keeps no second copy.",
    "impact": "Trigger: someone edits the idle predicate in one place, or applies the PR 999 F-025/F-026 fix to the wrong `drainWhenIdle`. Outcome: the two copies drift, or the recipient-choice drain keeps ignoring detached work while every other site honours it (see F-014). Maintenance cost; behaviour equals the merge-base.",
    "suggested_fix": "Let `TurnLoop.drainWhenIdle` take only the extra terms (`!destroyed`, lease not held) and AND them with `drain.workInFlight()` inside turn-loop.ts, so the three base terms and detached work live once; rename one of the two methods (for example `drainAfterRecipientChoice`) and say in its doc comment what it does not consult.",
    "evidence": "tui-shell.ts 5018 (`turnWorkInFlight`) and 8669-8677 (`isIdle` lambda); main-queue.ts 270 and 282-285; turn-loop.ts 100-109; turn-loop.test.ts 207 uses `() => !h.busy`. Reported by architecture (F-003), highload (F-001) and style (F-004).",
    "confidence": "medium",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 8669
  },
  {
    "id": "F-010",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/tui/turn-loop.ts",
    "quote": "enqueueWhileBusy(line: string, displayLine: string, commandName: string | undefined, source?: QueuedMainQuestion[\"source\"]): boolean;",
    "problem": "`enqueueWhileBusy` reads as an unconditional push like `enqueue`, but it first consults `deferredBusyAction(line, commandName)` and returns false without queuing for a session-replacing command; the meaning of the boolean ('false: the caller must refuse') lives only in the doc comment. `enqueue(line, displayLine, source?)` and `enqueueWhileBusy(line, displayLine, commandName, source?)` take two adjacent same-typed strings, so a swapped `line`/`displayLine` type-checks.",
    "impact": "Trigger: a reader of `if (turnLoop.enqueueWhileBusy(...)) return;` at a call site. Outcome: they must open the interface to learn that false means 'not queued, fall through to the refusal'. No wrong behaviour today (argument order matches the former code at every site).",
    "suggested_fix": "Rename for what it does (for example `tryQueueBehindTurn`), or pass `{ line, displayLine, source }` as one object so the two strings are named at the call site.",
    "evidence": "turn-loop.ts interface lines 41-49 and body lines 94-99; the four `turnLoop.enqueue*` call sites in tui-shell.ts (8592 `enqueueWhileBusy`; 8625, 8665 and 9437 `enqueue`).",
    "confidence": "medium",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 47
  },
  {
    "id": "F-011",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/tui/turn-loop.ts",
    "quote": "readonly queue: QueuedMainQuestion[];",
    "problem": "The `queue` getter hands out the live array typed as mutable, next to a `replaceQueue` that exists so the array can be swapped. Every shell caller only reads it (`.length`, an index, `.map`, and the pure `removeMainQueueItem(turnLoop.queue, index)`), so nothing needs write access, yet a future `turnLoop.queue.push(...)` would skip the id counter and the paint that `enqueue` owns. `drain` is typed `ReturnType<typeof createMainQueueDrain<QueuedMainQuestion>>` (an instantiation expression inside `ReturnType`, where main-queue.ts exports no named type), and the shell immediately aliases `remote` and `drain` (`const remoteQueue = turnLoop.remote;`, `const drainSites = turnLoop.drain;`), keeping a second vocabulary for the same objects.",
    "impact": "Trigger: a caller pushes to `turnLoop.queue` directly. Outcome: an item without a counter id or a repaint, the duplication this change removes. The alias form ties turn-loop.ts to the factory's inferred shape and makes the drain's method set invisible from the interface. Readability and a latent footgun; not a defect today.",
    "suggested_fix": "Type the getter `readonly queue: readonly QueuedMainQuestion[]` (the shell never mutates it; `drainIdleMainQueue` keeps the internal mutable reference), export a named `MainQueueDrain` type from main-queue.ts and use it for `drain`, and either keep the shell aliases deliberately for the source-text needles and say so, or call `turnLoop.drain.*` directly.",
    "evidence": "turn-loop.ts lines 37-52; tui-shell.ts has about 25 `turnLoop.queue` references and none mutates the array (a regex for push/splice/shift/pop/unshift/sort/reverse/`length =`/indexed assignment over src/tui returns 0 matches; the verifier re-ran it). Reported by architecture (F-002), clean-code (F-004, F-006) and style (F-006).",
    "confidence": "medium",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 39
  },
  {
    "id": "F-012",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/tui/turn-loop.ts",
    "quote": "nextId: () => `mq${seq++}`,",
    "problem": "The id scheme `mq${seq++}` is written twice inside `createTurnLoop`: in `enqueue` and as `nextId` for the remote wiring. The PR's stated purpose is that the counter has one owner, yet the format lives in two places.",
    "impact": "Trigger: the id format changes (prefix, padding). Outcome: one site is updated and the other missed, giving two id shapes in one queue and breaking `/queue edit|remove` matching. Cheap to prevent now.",
    "suggested_fix": "Add `const nextId = (): string => `mq${seq++}`;` next to `let seq` and use it in `enqueue` and in `createRemoteQueueWiring({ nextId, ... })`.",
    "evidence": "turn-loop.ts line 59 (`id: `mq${seq++}``) and line 70. Reported by clean-code (F-002) and style (F-005).",
    "confidence": "high",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 70
  },
  {
    "id": "F-013",
    "reviewer": "review-clean-code",
    "severity": "info",
    "file": "src/tui/turn-loop.test.ts",
    "quote": "loop: undefined as unknown as TurnLoop,",
    "problem": "The harness is a mutable bag built in two passes: `loop` is cast in as `undefined as unknown as TurnLoop` and assigned after `createTurnLoop` because `settleTurn` and the fake `runLine` close over `h`. The fake `runLine` has an unused `_origin` parameter, a non-null `detachedWork.shift()!`, and re-implements the shell's slash-name extraction inline (`line.split(/\\s+/)[0]`). Test 8 flushes a detached run with one bare `await new Promise((done) => setTimeout(done, 0))` macrotask, which is deterministic today (the detached work resolves in microtasks).",
    "impact": "No demonstrated harm: eslint is clean and the suite is deterministic (166 ms). If the shell's slash-name parsing changes, the model silently diverges (the header already says so).",
    "suggested_fix": "Declare `let loop!: TurnLoop` inside the harness builder or build the state first; drop `_origin`; await the detached promise the harness already holds instead of a timer.",
    "evidence": "turn-loop.test.ts lines 36, 51-60, 203; `bunx eslint` on both new files exits 0 (style). Reported by clean-code (F-005), style (F-007) and testing-practices (F-012).",
    "confidence": "medium",
    "pre_existing": false,
    "location_class": "in-diff",
    "line": 36
  },
  {
    "id": "F-014",
    "reviewer": "review-highload",
    "severity": "info",
    "file": "src/tui/tui-shell.ts",
    "quote": "turnLoop.drainWhenIdle(",
    "problem": "The recipient-choice idle drain dispatches one item with a predicate that does not read `drainSites.workInFlight()`, so a late 'main' recipient answer that lands while detached slash work (for example `/model`) is still running and the turn is idle starts the queue head beside that work; an inline slash line dispatched there also leaves the lines behind it stranded. The merge-base `drainIdleMainQueue(mainQueue, {isIdle, takeForced, dispatch})` call had the same predicate, and turn-loop.ts reproduces it. This is the known PR 999 F-025 and F-026 gap, carried unchanged by this PR; reading only, not run in the shell.",
    "impact": "Pre-existing: no change in behaviour at this site, and the operator can already type a line beside detached work. It never blocks. Recorded so the F-025/F-026 fix is applied to this site as well (see F-009).",
    "suggested_fix": "Close it with the F-025/F-026 follow-up (flow 441 deferred items), together with F-009's single predicate.",
    "evidence": "Merge-base tui-shell.ts call of `drainIdleMainQueue` with the same predicate; turn-loop.ts 100-109; main-queue.ts 270 and 282-285; PR 999 round-3 findings F-025 and F-026. Reported by highload (F-001) and architecture (F-003).",
    "confidence": "medium",
    "pre_existing": true,
    "location_class": "pre-existing",
    "line": 8669
  }
]
```

## Mutation pass

`keryx review mutate` ran 42 mutants in a scratch copy (baseline exit 0, 8 test files): **killed 26, survived 16, timeout 0, invalid 0**. Records: `research-evidence/mutation-1.json` and `mutation-1.md`. The mutants were proposed by review-testing-practices; severity-audit read the survivors cited as `mutant:<id>` in F-002 to F-005.

Survivors (16): T05, T07, T07b, T08, T11, T12, T13, T14, T16, T17, T20, T21 (all in `turn-loop.ts`); S05, S06, S07, S08 (the shell's `createTurnLoop` call).

## Stage counts

Consolidated findings: 14 (five overlapping classes merged across reviewers). Dropped by pre-filter: 0. Refuted by the verifier: 0 (14 of 14 confirmed by site-check, 0 by execution; the F-002 to F-005 gaps are carried by the mutation pass instead). Dropped by scope-B rules: 0. Retained: 14.

Severity audit: 4 raised minor to major (F-002, F-003, F-004, F-005, each on a surviving cited mutant); none lowered; evidence ids recorded in findings.json under severity_audit. Reviewers: 9 of 9 returned, no non-results, no re-dispatch.

**Not run:** Vantage overlays (not applicable: this is the Keryx repository, not Vantage); greptile; cross-family review; `review complete`; the full repository test suite (only the eight queue, hold, bus and shell test files and the verifier's checks); a mounted shell or live TUI session (the verdict on shell behaviour rests on reading, the source-text tests and the mutation pass).

## Metadata

- Orchestrator: `vantage-review`
- Generic engine: `review-orchestrator` (`.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md`, read in `/home/altsay/keryx-fdm-t3b`)
- Vantage overlays: none selected; all skipped (not a Vantage repository, no `src/**` Vantage frontend scope)
- Keryx projection path: `.metaproject/skills/gdskills/review/review-orchestrator/` (generated projection, read-only)
- Vantage rule files read: none apply; the Keryx engine's own rubric and schemas were used
- Project-local reviewer packages: `keryx review reviewers --json` lists 0 `project` reviewers (28 bundled), so no project package overrode a built-in definition
- Routing audit: graph_used yes (scope B from `keryx review blast-radius`), wiki_used not-relevant, ctx_used yes (`keryx ctx rg` and `keryx ctx run`), raw_rg_used no (raw git diff and file reads carried the `keryx:raw` marker)
