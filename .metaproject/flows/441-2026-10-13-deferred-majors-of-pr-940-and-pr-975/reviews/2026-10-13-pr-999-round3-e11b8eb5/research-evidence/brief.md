# Round 3 brief: PR 999 (flow 441 T3, main-queue drain), the last round under the three-round cap

Project / worktree root: /home/altsay/keryx-fdm-t3 (git worktree, branch of PR 999). Do NOT edit, commit, push or
stash anything in it. Evidence you write goes only under
/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/2026-10-13-pr-999-round3-e11b8eb5/research-evidence/
(create files there; nothing else).

Head: e11b8eb5. Base (merge-base with origin/main): 01e0dbfe44d1f2423720e0040655dab4bef5721a.
Round-2 head: f6b16a38. Round 3 reviews merge-base..HEAD (scope A) and, for the regression reviewer, the blast radius
(scope B, file: .../round3-e11b8eb5/blast-radius.json, brief rules below).
Scope A code: src/tui/main-queue.ts, src/tui/tui-shell.ts, src/tui/foreground-operation.ts and the tests
(src/tui/main-queue-drain.test.ts new, busy-dispatch, foreground-operation, remote-queue-wiring, tui-bus, tui-hold,
tui-shell tests). The rest of scope A is committed review packages and gdgraph data under .metaproject: not code to
review, do not file findings on it.
The round-3 delta is `git diff f6b16a38..e11b8eb5` (7 files, +216/-67). It is the fix commit e11b8eb5 for the round-2
findings. THE FIX IS NEW CODE: review it on its own merits, and report what it broke.

Rules: .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md section "Severity (canonical)" is the only
severity rubric. Result schema: .metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json
(reply starts with a `STATUS:` line, then a `REVIEW_RESULT` JSON block, then a short markdown summary). Each finding
carries `quote` (verbatim code from `file`), problem, impact (trigger + observable outcome), suggested_fix, evidence,
confidence; blocker/major also class_scope (sites + enumeration method). A claim of runtime harm with no reproducible
path is `info`. Tools: `keryx ctx rg` for searches (never bare rg), `keryx ctx run -- <cmd>` for long output; the Bash
tool refuses raw cat/sed/ls, so use Read and Grep or add `# keryx:raw <reason>` when raw output is needed.

## What the fix commit claims (verify each against the code, not the commit message)

Round-2 findings and the claimed fixes (round-2 report: /home/altsay/keryx-fdm/.metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-999-round2-f6b16a38/report.md and its findings.json):
- F-016 (major): the drain captured `queue: mainQueue` once, while the shell replaces `mainQueue` on /queue remove/edit and Force.
  Claimed fix: `queue: () => mainQueue` and `deps.queue()` in take and pending (main-queue.ts, tui-shell.ts 7963).
- F-017: the detached-work counter and `.finally` lived in tui-shell.ts, untested with a rejecting promise.
  Claimed fix: the counter moved into the factory as `detach(work)` with `work.then(end, end)`; `workInFlight()` is exposed.
- F-018: the detached-end, lease-release and operation-complete sites never woke the bus. Claimed fix: `onSettle` moved
  inside the factory's `drain`, so every drain that ends "empty" calls `deps.onSettle()` (bus wake).
- F-019: the bus wake's `isIdle` ignored detached work and the force hand-off. Claimed fix: `isIdle` reads
  `!drainSites.workInFlight()` (the factory's combined predicate) in tui-shell.ts ~9993.
- F-020 (info): stale lease-site comment; claimed updated.
Evidence from the orchestrator (already executed, you may rely on it or re-run it): the stale-queue repro
(research-evidence/stale-queue-repro.ts, run with `bun run <file>` from the worktree) now gives: remove-then-settle runs
the live head `b` and not the removed `a`; remove-all-then-settle runs nothing and wakes once; a forced line runs once.
Baseline: the eight TUI test files pass at head (309 pass, 67 skip, 0 fail).

## What to look for that the fix may have introduced (the orchestrator's specific concerns)

1. Bus wake after EVERY empty drain: `onSettle` now fires from onTurnSettle, onForegroundOperationComplete,
   onLeaseRelease (drainWhenIdle) and detach-end, and also when `drainNext` returns "empty" with pending() already 0
   (no paint, nothing taken). Look for a double wake (two sites firing for one settle, e.g. turn settle then the
   operation-complete or lease-release in the same tick, while `isIdle` is still true because `runWake` -> runLine("",
   "bus-message") has not made chrome busy yet), a wake loop (wake -> turn -> settle -> wake with no new input; what bounds it:
   consecutiveAutoWakes and the cap, bus-wake.ts decideBusWake), a wake while the lease is held, and wakes against a
   half-torn-down shell (no `destroyed` guard in the sites).
2. Repaint storms: `drainNext` calls `paint` once per pass and once more on the empty take; the sites now run `drain()`
   unconditionally (onTurnSettle, onForegroundOperationComplete). Count paints per settle and per lease release.
3. The moved counter / detach in main-queue.ts: `work.then(end, end)` swallows the rejection (before, `.finally` left an
   unhandled rejection on the derived promise; check the six call sites in tui-shell.ts: do they catch their own errors?);
   what if `end` -> drainWhenIdle -> run throws synchronously (unhandled rejection, counter already lowered)?;
   `detach` called while a turn is running; `detached` never negative; detach of an already-settled promise (end runs in a
   microtask, so the queue is held for one tick: any caller that expects an inline release?).
4. `isIdle` now includes `forceHandoff.isAwaitingSettlement` and detached work: can that starve the bus wake (a wake
   that is never retried because nothing calls onSettle after the hand-off settles)? The hand-off's own settle path: does
   it call onTurnSettle?
5. Other holders of a stale `mainQueue` reference: enumerate EVERY place the shell, remote-queue-wiring.ts, addressee-queue.ts,
   main-queue-view.ts, external-operator.ts etc. receive the queue array by value (not via getter) and could be stale after
   `mainQueue = ...` (tui-shell.ts 4997 setQueue, 8040/8049 removal and Force). F-016's class is "captured array".
6. Tests: the new/changed tests in main-queue-drain.test.ts and the source-text audits (tui-hold.test.ts,
   tui-bus.test.ts, busy-dispatch.test.ts, tui-shell.test.ts): does each fail on the parent (red on f6b16a38's production
   files)? Do any pin only text (a source-text audit for `queue: () => mainQueue,`) where a behavioural test could run?
   Is there a model case that replaces the queue array between enqueue and settle (the F-016 case) and one that rejects a
   detached promise (F-017)?
7. Pre-existing items carried from earlier rounds (F-011 to F-015 of round 1, the round-1 package under
   .metaproject/flows/441-.../reviews/2026-10-13-pr-github-com-mrciphersmith-keryx-pull-999/): do not re-raise as new;
   if you touch them, mark `pre_existing: true`.

## prior_findings (round 2) and the disposition you owe

For each of F-016, F-017, F-018, F-019, F-020 give a disposition line in your summary: closed / open / partial /
regressed / withdrawn, checked against the code, with the file:line. File new defects the fix introduced as findings and
list them under "Regressions the fixes introduced".

## Scope-B (regression reviewer only) rules

`keryx review blast-radius --brief` rules: only findings at `major` or above, naming a site in the blast-radius set, that
link to the change. Pass `class_scope` for the caller that breaks.

## Output

`STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`, a `REVIEW_RESULT` block, a summary with the five
dispositions, "Regressions the fixes introduced", and "Verified clean" lines that name the files or commands they rest on.
List the `slices` you covered as ids is not needed (this is not a shell host); state the files you read in full.
Be concise: findings with a trigger and an outcome only.
