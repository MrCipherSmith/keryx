# Stale queue capture: reproduction (F-016)

Head f6b16a38. The script builds the drain with the real `createMainQueueDrain` and
`removeMainQueueItem` from `src/tui/main-queue.ts`, and mirrors the shell exactly where it matters:
`let mainQueue`, the factory given `queue: mainQueue` once (tui-shell.ts:7966), the queue replaced by
`mainQueue = removeMainQueueItem(...)` (tui-shell.ts:4997 setQueue, 8049 forceMainQueue), and later
lines pushed on the live variable (tui-shell.ts:8579, 8617, 9439). `ran` is what the drain dispatched
at the turn settle; `liveQueue` is what the panel shows.

Command: `bun run <scratchpad>/stale.ts` (not committed; it imports the worktree).

```
control, no reassign: push a,b                 {"ran":["a"],"settles":0,"liveQueue":["b"]}
remove q1 of [a,b] then settle                 {"ran":["a"],"settles":0,"liveQueue":["b"]}
push a, remove it, push b                      {"ran":["a"],"settles":0,"liveQueue":["b"]}
force-style reassign on [x] then push b        {"ran":["x"],"settles":0,"liveQueue":["b"]}
```

Reading the rows:

- Row 1 is the control (no replacement): `a` runs, `b` waits. Correct.
- Row 2: the operator removed `a` (`/queue remove 1`); the live queue is `[b]`, but the drain runs `a`,
  the line the operator deleted.
- Row 3: `a` is removed and `b` is queued afterwards; the drain still runs `a`, and `b` is never taken.
- Row 4: `x` was forced (removed from the queue, handed to the force hand-off, run once); the drain
  runs `x` a second time from the old array.

Base 01e0dbfe read the live variable at every site (`forceHandoff.takeNext() ?? mainQueue.shift()` at
base lines 9617, 9926, 10022). The captured array was introduced by commit 83838859 (the round-1
fix for F-003).

Mutation evidence: S22-set-queue-in-place (setQueue edits the array in place, the fix for this
class) SURVIVES all eight test files; S24-factory-takes-a-copy is killed only because tui-hold.test.ts
pins the literal text `queue: mainQueue,`, which is the buggy form.
