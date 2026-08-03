---
id: branching-on-a-value-whose-domain-you-never-wrote-down
kind: lesson
status: active
created: 2026-08-03
tags: [review, fix-rounds, types, exhaustiveness, root-cause]
---

# Every blocker in six review rounds came from branching on a value whose domain was never written down

Six review rounds on one branch produced twelve blockers. When they are laid side
by side, they are not twelve mistakes. They are **one** mistake, made six times
in the recorded rounds and twice in the two rounds that predate the per-round
files.

## The evidence

| finding | the branch | what the value ALSO meant |
|---|---|---|
| F-013 | `record.failures.length` | the window is pruned only in `recordFailure`, so a stale record counts forever |
| F-022 | "structure has no spellings" | `Object.assign`, spread, `fromEntries`, `defineProperty`, class fields, chained `Map.set` |
| F-033 | `code === 0` | not only "clean" but "this mode does not refuse" — and `advisory` never refuses |
| F-034 | `tokens[2]` | `bun build` takes any number of positionals |
| F-040 | `gate === "pass"` | not only "nothing found" but "found something the policy said to REDACT" |
| F-041 | `tokens[0]==="bun" && tokens[1]==="build"` | an env prefix, a runner flag, a sub-script |

Six for six. Each is one `if` on a value whose full range of meanings was never
enumerated anywhere — not in the code, not in a comment, not in my head.

## The counter-evidence, which is what makes this actionable

Three places in the same codebase DO enumerate the domain, as a total `switch`
over a union with **no default arm**:

- `outcomeOf` (`serve-turn.ts`) — every `HarnessRunOutput["status"]`
- `isServerFault` (`serve-turn-store.ts`) — every `TurnReadFailure`
- `isDefiniteAbsence` — the same union, the other question

Across six rounds of adversarial review, **zero** defects were found in any of
those three enumerations. The one finding that named `isServerFault` was about
its docstring claiming more call sites than it had — the enumeration itself was
correct.

Three sites with the discipline: nothing. Six sites without it: a blocker each.

## The rule

**Before writing a branch, write the domain of the thing you are branching on.**
Not "consider it" — write it, somewhere a compiler or a reader can check.

In order of strength:

1. **Make it a type the compiler checks.** A discriminated union plus a total
   `switch` with no `default`. Then a new member is a compile error, not a
   fall-through into whichever arm is last. Verified: adding a fourth outcome to
   `HookOutcome` in `src/commands/security.ts` fails `tsc`.
2. **If the value is a number or a boolean, it is probably the wrong shape.**
   `code === 0` carried two unrelated meanings because an exit code is a channel
   with no room for a reason. Replacing it with `HookOutcome` is what made the
   second meaning impossible to overlook.
3. **If the domain belongs to someone else, go read it.** `tokens[2]` and the
   two-token `bun build` match were both answered by `bun build --help`, which I
   read only after a reviewer shipped a scanner through the gap.
4. **If it cannot be enumerated, say so.** A pattern over source text has no
   closed domain, which is exactly why those guards lost a spelling per round.
   Write the known gaps down as executable tests and stop claiming closure.

## Why "be more careful" is not the answer

The six blockers were written across six rounds, each one immediately after
reviewing the previous one and recording a lesson about it. Attention was not
the missing ingredient. What was missing was a place where the enumeration had
to exist before the branch could compile.

Related: [[regex-guards-lose-to-spellings]] is the same failure over an open
domain — text — where no enumeration is possible and the honest move is to stop
claiming one. [[a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker]]
records the pattern before its cause was identified.
