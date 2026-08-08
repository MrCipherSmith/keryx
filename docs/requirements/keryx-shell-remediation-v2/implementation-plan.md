# Keryx Shell Remediation v2 — Implementation Plan
Version: 1.0.0

## Branch policy

Settled by the owner on 2026-08-07: **every flow branches from
`docs/benchmark-run-report` and merges back into it.** Not `main`. The benchmark
package, its evidence, the findings and these fixes travel together, and PR 251
carries the whole thing to `main` when it is done.

## Flows

Four defects, four flows. One is already open.

| Flow | Defect | State | Files it touches |
|---|---|---|---|
| **new** | P1 — dynamic-import edges | to create | `src/gdgraph/build.ts`, the edge record, cycle detection, fixtures |
| **139** | P3 — verification vs brevity | open, criteria written | `src/commands/shell.ts`, a regression fixture |
| **new** | P2 — the unofferable grant | to create | `src/lib/shell-permissions.ts` (`suggestShellPatterns`), tests |
| **new** | P4 — install/doctor visibility | to create | `scripts/install.sh`, a new CLI command, `command-registry.ts` |

## Order, and why

**P1 → P3 → P2 ∥ P4.**

P1 is first because it is the concrete wrong answer *and* because it is P3's
fixture. Flow 139's AC4 asserts that the agent qualifies a tool result rather
than restating it — if P1 is still broken when that test is written, a passing
run cannot distinguish "the agent checked" from "the agent got lucky", and if P1
is fixed *afterwards* the fixture silently starts passing for the wrong reason.
Flow 139's AC5 exists to record exactly this and must be honoured.

P3 second: it is the structural one, it changes every answer keryx gives, and it
is the only one where over-correcting is a real risk.

P2 and P4 touch nothing P1 or P3 touch and can run in parallel, in either order,
by anyone.

## What each flow must not do

| Flow | Must not |
|---|---|
| P1 | Reclassify edges the regex fallback found. It has no kind; guessing one re-introduces the same class of error at a different layer |
| P1 | Change `affected`/`orphans` semantics as a side effect. If dependants counts move, that is a separate decision with its own evidence |
| P3 | Turn "check when the result is the deliverable" into "verify everything". The A1 re-run shows a verifier inventing a correction; the cost is not only tokens |
| P3 | Trade away brevity. AC3 exists for this |
| P2 | Remove the prefix offer for clean commands. The feature is fine; the predicate is wrong |
| P4 | Implement the Linux domain allowlist. That is netns-plus-relay feature work and is out of scope |
| P4 | Change the `KERYX_SANDBOX_SHELL` default. It has a stated rationale; overturning it is a product decision |

## Definition of done, per flow

1. Acceptance criteria written **before** freeze, in the flow's own file, hard
   and checkable — the criteria in [specification.md](specification.md) are the
   starting text, not a substitute.
2. `keryx flow freeze <id>` then `keryx flow start <id>`.
3. Implementation with tests that fail before the change and pass after.
4. `keryx health run` clean.
5. `keryx flow ac confirm <id> <ACn>` per criterion, with the evidence in the
   note.
6. PR into `docs/benchmark-run-report`; `keryx flow implemented <id> --pr <url>`.

## Re-measurement

The fixes are proven by tests, and then *re-measured* by the benchmark — in that
order, never the reverse. The fixtures were frozen from run 2 before any fix
landed, and the expected answers are recorded in
[`evidence/grading-key.md`](../keryx-shell-benchmark/evidence/grading-key.md).

Run 3 procedure and its four blocking decisions:
[run-3-runbook.md](../keryx-shell-benchmark/run-3-runbook.md).

**A fix that only the benchmark can demonstrate is not done.** The benchmark
found these defects; it does not get to be the thing that certifies them fixed.
