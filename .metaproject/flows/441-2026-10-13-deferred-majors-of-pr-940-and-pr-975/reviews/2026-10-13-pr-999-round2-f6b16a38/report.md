# Review report: PR 999 (flow 441 T3, queue drain), round 2

Orchestrator: vantage-review. Generic engine: review-orchestrator. Round 2 of 3. Head f6b16a38cd6dd201125a0bfc91627d2c00e4d698, base 01e0dbfe44d1f2423720e0040655dab4bef5721a. Mode all. Round 1: `2026-10-13-pr-github-com-mrciphersmith-keryx-pull-999`.

Verdict: request changes. 0 blockers, 1 major from reading (F-016, a regression the round-1 fix introduced), 3 minors (F-017 to F-019), 1 info (F-020). F-017 cites a surviving mutant, so `severity-audit` raises it to major (see "Severity audit" below). Nine of ten round-1 findings are closed; F-001 is closed for the drain and open for one reader (F-019).

## Round-1 findings: disposition at f6b16a38

| Round 1 | Disposition | Evidence |
|---|---|---|
| F-001 (slash work that outlives its handler) | Closed for the drain; partial overall. The six sites (`/schedule`, `/goal`, `/search-provider`, `/search-connect`, `/model`, `/connect` and `/provider`) go through `detachSlashWork`, the counter is in `queueWorkInFlight`, and its end drains. Mutants S12 to S20 and S14 to S19 (one per site) are killed. Left open: the bus wake's `isIdle` does not read the counter (F-019), and the wake is not re-checked when the work ends (F-018). | tui-shell.ts 7961-7980, 8776, 8790, 8833, 8867, 9306, 9365 |
| F-002 (operation-complete site unpinned) | Closed. Mutant S10 (call deleted) is killed; tui-hold.test.ts counts the call exactly once. | mutation-1 |
| F-003 (shell wiring unpinned) | Closed as asked, and it introduced F-016. S05 to S08, S11, S21 of the factory fields are killed. The factory binds `queue` by value; the source audit pins that exact text. | F-016 |
| F-004 (one-sided AC4 bound) | Closed. The self-requeue test asserts the exact run, queue and settle counts; the spent-budget case is covered (N23, N24 killed). | main-queue-drain.test.ts 294-329 |
| F-005 (re-queue noise under a held lease) | Closed. `drainNext` stops at the first line that does not lower the count (`exhausted`); N07 and N08 killed; test "a line that puts itself back" passes. Not exercised through the real shell (see F-016, which interacts). | main-queue.ts 218-229 |
| F-006 (budget counted one forced item) | Closed. `pendingCount` is in the budget; N18, N19, N22 killed. | foreground-operation.ts 126 |
| F-007 (wrong pointer in two titles) | Closed. No `(behaviour: main-queue.test.ts)` remains in src/tui. | rg |
| F-008 (stale comments) | Closed except the lease-site comment, reported in F-020. | tui-shell.ts 10019-10022 |
| F-009 (`drained` meant three things) | Closed. `DrainOutcome` is `started`, `empty`, `exhausted`; N05, N11, N23 killed. | main-queue.ts 198 |
| F-010 (N+1 paints) | Unchanged, info, no action. | |
| F-011 to F-015 (pre-existing) | Unchanged. F-011 (the idle path and Force are single-item drains) still holds; F-013 gets a second consequence from F-016. | |

## The fixer's known gap: /tasks, /resume, /clear do not hold the queue

It does not matter for the queue, and no finding is raised.

- `/tasks` (tui-shell.ts 8736) only prints text through `trackCommandWork`; it starts no turn, touches no history and holds no overlay, so a queued line running beside it is the same as running beside any inline command.
- `/new`, `/clear` and `/resume` are in `BUSY_REFUSED_COMMANDS` (busy-dispatch.ts), so `deferredBusyAction` refuses them while a turn runs and they can never be queued. Only non-slash lines reach the held-lease queue gate. Nothing can therefore sit in the queue behind them. They run from the idle path when the operator types them, which is the pre-diff behaviour.

## Questions
- Q1 (AC1, from round 1): AC1 says the test lives in the TUI shell; the PR gives a model plus source-text pins. Still pending with the operator; noted, not blocking this round. F-016 is the concrete case the model cannot see, which is evidence for the operator's decision: a model built on `createMainQueueDrain` with a fixed array proves the factory, not the binding.

## Regressions the fixes introduced
- F-016: the round-1 fix for F-003 moved the drain into `createMainQueueDrain` and handed it `queue: mainQueue` once. The shell replaces `mainQueue` with a new array on every `/queue remove`, `/queue edit`, queue-nav delete or edit, Force and Telegram-queue drop, so the drain keeps reading the array it was given. Introduced by commit 83838859; the base read the live variable at every site.

## Not run
- Shell mount (still no headless seam), greptile, cross-family review, ledger build, `review complete`.
- No separate reviewer agents were dispatched this round. The orchestrator applied the logic, regression and testing-practices lenses itself, because the round's questions (does each fix hold, mutation pass, regressions) are narrow; `research.json` lists those three lenses, not an agent run. The one major was verified by execution (research-evidence/stale-queue-repro.md) instead of a verifier agent.
- Blast radius (scope B) was not recomputed; pre-existing items F-011 to F-015 are carried from round 1 without re-reading beyond what the diff touches.
- Baseline suite at head: 8 files, 298 pass, 67 skip, 0 fail. The full repository suite was not run (CI runs it).

## Mutation pass
48 mutants over `drainNext`, `createMainQueueDrain`, `ForegroundForceHandoff.pendingCount`, `queueWorkInFlight`, `detachSlashWork`, the six detached-site wrappers, the three drain sites, the factory wiring, `setQueue` and `forceMainQueue`. Command: `bun test src/tui/main-queue-drain.test.ts src/tui/main-queue.test.ts src/tui/tui-bus.test.ts src/tui/tui-hold.test.ts src/tui/remote-queue-wiring.test.ts src/tui/foreground-operation.test.ts src/tui/busy-dispatch.test.ts src/tui/tui-shell.test.ts` (baseline green). Run in a scratch copy.

Killed 46, survived 2, timeout 0, invalid 0.

| Survivor | Where | Change | What it means |
|---|---|---|---|
| S21-detach-end-only-on-success | src/tui/tui-shell.ts:7976 | `void work.finally(() => {` to `void work.then(() => {` | No test rejects a detached slash command. If the work throws, the counter is never lowered, `queueWorkInFlight` stays true and the queue stops draining until the shell restarts (F-017). |
| S22-set-queue-in-place | src/tui/tui-shell.ts:4996 | `mainQueue = next;` to `mainQueue.splice(0, mainQueue.length, ...next);` | This is the fix for F-016. It passes every test, so no test distinguishes the buggy form from the fixed one (F-016). |

S24 (`queue: [...mainQueue]`) and S23 (`mainQueue.splice(index, 1)` in `forceMainQueue`) are killed only by source-text audits, one of which pins the buggy form `queue: mainQueue,` itself. The 44 other mutants are killed by behaviour or by a structural pin that matches the intended wiring.

## Severity audit
F-017 cites a surviving mutant; `keryx review severity-audit` raises a cited survivor to major. The pre-audit judgement was minor: today's code is correct and only a plausible one-word regression goes unpinned. The rubric rule is applied as written.

## Lanes
- review-regression: F-016 (regression from the F-003 fix); round-1 dispositions for F-001, F-005, F-006.
- review-testing-practices: F-017; the mutation pass; dispositions for F-002 to F-004, F-007.
- review-logic: F-018, F-019; dispositions for F-008, F-009; the /tasks, /resume, /clear question.
- Style/clean-code reading: F-020.

## Pre-existing (never blocks)
- F-011 to F-015 carry over unchanged from round 1 (see its report). Not re-reported here.

## Verified clean
- `drainNext` terminates: every pass either lowers `pending()` or returns, and the budget is the entry count (N01, N02, N23, N24 killed; the three outcome tests pass).
- The forced item goes before the queue and a pending hand-off drains nothing at the settle and operation-complete sites (N12, N13, N17 killed).
- The lease-release and detached-end sites stay out while anything is in flight (N14 killed) and each is wired to the right drain (S11, S13 killed).
- The six detached sites all hold the queue (S14 to S19 killed); `/model` and `/connect` keep the question waiting until the picker closes, which is what AC2 asked for.
- `queueWorkInFlight` has all four inputs, each pinned (S01 to S04 killed).
- `onSettle` fires only when the drain ends empty (N09, N10, N11 killed).
- `drainIdleMainQueue(mainQueue, ...)` reads the live variable and has its own idle and `destroyed` guards; it is unaffected by F-016.

```json keryx:findings
[
  {
    "id": "F-016",
    "reviewer": "review-regression",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "quote": "queue: mainQueue,",
    "problem": "createMainQueueDrain is built once with `queue: mainQueue`, and its take and pending read `deps.queue` for the life of the shell. The shell does not keep one array: `mainQueue` is a `let` that is replaced with a new array by setQueue (tui-shell.ts:4997, reached from remote-queue-wiring.ts removeMainQueue, editMainQueue, requeuePendingEdit and dropQueuedTelegramLines) and by forceMainQueue (tui-shell.ts:8049). Lines are pushed onto the live variable (8579, 8617, 8659, 9439). After the first replacement the drain reads the array it was given at start-up, which no longer has anything to do with the panel. Before the round-1 fix every site read the live variable (`forceHandoff.takeNext() ?? mainQueue.shift()` at base lines 9617, 9926, 10022). main-queue-drain.test.ts builds its model with a fixed `queue: shell.queue` array, so it cannot see this, and tui-hold.test.ts pins the exact text `queue: mainQueue,`.",
    "impact": "Trigger: the operator queues two lines behind a running turn and removes or edits one (/queue remove 1, /queue edit 1 then submit, the queue-nav Delete or Edit, or the Telegram queue is dropped), or uses Force on any queued line; the turn then settles. Outcome, reproduced against the real createMainQueueDrain and removeMainQueueItem: (a) the removed line is dispatched anyway, as a turn with whatever approvals it raises (rows 2 and 3 of the repro: ran [a] where a was deleted, live queue [b]); (b) a Forced line runs twice, once from the hand-off and once from the stale array (row 4); (c) lines queued after the replacement are never taken by the settle, operation-complete, lease-release or detached-end sites: the panel shows them as queued and only the next typed line (drainIdleMainQueue reads the live variable) moves them. onSettle also fires against the stale array, so the bus wake sees a non-empty live queue and wakes nothing. Everything before the first replacement works, which is why every test passes.",
    "suggested_fix": "Pass the queue as a getter: `queue: () => mainQueue` in the shell, `deps.queue()` in main-queue.ts take and pending. (Alternative: make setQueue and forceMainQueue edit the array in place.) Add a model case that replaces `shell.queue` with removeMainQueueItem between the enqueue and the settle and asserts the removed line does not run and a line queued afterwards does; change the tui-hold audit from `queue: mainQueue,` to the getter form.",
    "evidence": "research-evidence/stale-queue-repro.md (executed against the real factory; four scenarios). mutant:S22-set-queue-in-place survived: the in-place fix passes all eight test files, so nothing tells the bug from the fix. S24 is killed only by the source-text pin of the buggy text. git log -S shows `queue: mainQueue,` first appears in 83838859.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:4997 (setQueue: remove, edit, requeue edit, drop Telegram lines)",
        "src/tui/tui-shell.ts:8049 (forceMainQueue)",
        "src/tui/tui-shell.ts:7966 (the captured reference)"
      ],
      "enumeration_method": "keryx ctx rg for `mainQueue = ` in tui-shell.ts (exactly two reassignments) and for `deps.setQueue(` in remote-queue-wiring.ts (four calls); keryx ctx rg for `deps.queue` in main-queue.ts (take and pending are the only two readers)."
    },
    "line": 7966,
    "pre_existing": false
  },
  {
    "id": "F-017",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "quote": "void work.finally(() => {",
    "problem": "detachSlashWork is the shell half of the F-001 fix and lives in tui-shell.ts, so it is covered only by source-text checks (the helper body contains `drainSites.onDetachedWorkDone();`, the call count is six). The model test lowers the counter by hand (`endDetached`). Nothing runs a detached promise that rejects. Mutant S21 changes `.finally` to `.then` and passes every test.",
    "impact": "Trigger: an edit turns `.finally` into `.then` (or moves the decrement into the success path), and a detached /model, /connect, /goal, /schedule or /search-* handler throws (redetect failing is enough). Outcome: detachedSlashWork stays above zero, queueWorkInFlight stays true, and no site drains again, so every later queued line waits until the shell restarts; the same edit also leaves an unhandled rejection. Mutant S21 survived.",
    "suggested_fix": "Move the counter and the wrapper into main-queue.ts (createMainQueueDrain returns `detach(work)` and includes the counter in its own in-flight check) so main-queue-drain.test.ts drives it with a promise that resolves and one that rejects; or pin `.finally(() => {` in the tui-hold helper-body audit.",
    "evidence": "mutant:S21-detach-end-only-on-success",
    "confidence": "high",
    "line": 7976,
    "pre_existing": false
  },
  {
    "id": "F-018",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/tui/main-queue.ts",
    "quote": "onDetachedWorkDone: drainWhenIdle,",
    "problem": "The turn-settle site wakes the bus when its drain ends empty, and the bus wake re-checks the inbox only on that call or on a poll that brought a new event (bus-wake.ts onPoll gates on newEvents). The detached-end site shares the drain but not the wake: when /model, /connect or another detached command finishes with nothing left in the queue, drainWhenIdle drains nothing and calls onSettle never.",
    "impact": "Trigger: a bus message is waiting in the inbox while the operator queued a slash command with detached work (for example /model) behind a turn; the turn settles, the picker opens, the operator picks, the work ends. Outcome: the queue is empty and the shell idle, but the waiting bus message is not woken until a later poll delivers another event or another turn settles. Present on main in the same shape (the base also skipped the wake after a drain that ran a slash command), so not a regression of this diff; the hold the fix adds makes the end of the detached work the natural place to wake.",
    "suggested_fix": "Have onDetachedWorkDone behave like onTurnSettle without the hand-off gate it does not need: `if (workInFlight()) return; if (drain() === \"empty\") deps.onSettle();`. The lease-release and operation-complete sites have the same omission; decide for all three and add a model case.",
    "evidence": "main-queue.ts 263-278; bus-wake.ts onPoll/onSettle contract (lines 98-114); tui-shell.ts 9998-10005.",
    "confidence": "medium",
    "line": 277,
    "pre_existing": false
  },
  {
    "id": "F-019",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "quote": "isIdle: () =>",
    "problem": "Round 1 F-001 listed the bus wake among the things that treat the shell as idle while detached slash work runs. The fix gave the drain the one definition (queueWorkInFlight) and did not give it to the other reader: the bus wake's isIdle checks chrome.isBusy, foregroundOperation.isActive, the queue length and the lease, and not detachedSlashWork or forceHandoff.isAwaitingSettlement.",
    "impact": "Trigger: /goal (or /schedule, /search-*) is running detached, or a /model picker is open, and a bus poll delivers a new wake-eligible message. Outcome: the poll path starts a bus-message turn (runLine with an empty line) beside the detached work, on the same history for /goal. The onSettle variant of this is now closed; the onPoll variant is not. Reachable on main as well (typing during /goal while idle), so low blast, but it is the same definition the PR introduced and left out of one reader.",
    "suggested_fix": "Include the shared predicate in isIdle (queueWorkInFlight is defined above the controller's construction in the same scope) or expose it from the factory and read it in both places.",
    "evidence": "tui-shell.ts 7962-7963 (queueWorkInFlight) and 10000-10005 (isIdle); mutant S25 shows the queue term of isIdle is pinned, nothing pins the in-flight term.",
    "confidence": "medium",
    "line": 10000,
    "pre_existing": false
  },
  {
    "id": "F-020",
    "reviewer": "review-clean-code",
    "severity": "info",
    "file": "src/tui/tui-shell.ts",
    "quote": "drainSites.onTurnSettle();",
    "problem": "Three small points on the new drain, none with a trigger today. (1) onTurnSettle drains while detachedSlashWork is above zero (it checks the hand-off but not the counter), so a typed question that settles beside a running /goal drains the next queued line beside it; the same overlap exists on main by typing. (2) The sites do not check `destroyed`, unlike drainIdleMainQueue's caller; a detached command that ends after the shell is torn down would drain into a disposed shell if lines remain. (3) The lease-site comment (10019-10022) still says the drain is 'skipped outright while a turn is still busy' and does not point at drainSites, although the guard is now the wider queueWorkInFlight. The empty drain also paints once for nothing.",
    "impact": "No observable outcome found. (2) needs a queue that is non-empty at teardown and a detached command still running; runLine's own guards were not traced.",
    "suggested_fix": "None required; fold (3) into the next edit of that comment, and consider a `destroyed` guard in the factory deps if teardown with queued lines is reachable.",
    "evidence": "tui-shell.ts 9944, 10019-10026; main-queue.ts 263-279.",
    "confidence": "low",
    "line": 9944,
    "pre_existing": false
  }
]
```
