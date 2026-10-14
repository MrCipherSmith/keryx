# Review run keep-alive heartbeat and --head on review complete

Status: approved by the operator (relayed by the coordinator, 2026-10-14)
Source: the two limits left open by flow 447 (origin: agent-finding)

## Problem

Flow 447 closed the gaps behind a stalled autonomous review run, and left two limits:

1. The stderr heartbeat follows progress, so it is not a timer. A healthy child that reads for a
   long stretch without a change in phase, rounds or tokens prints nothing, and a wrapper with an
   idle rail still kills the run.
2. `keryx review complete` has no `--head`. A package recorded against the wrong commit (for
   example by a run that predates the head in the prompt) cannot be closed against the commit
   that was actually reviewed, and the child cannot be told to pass it there.

## Expected Outcome

A review run prints a line at least once a minute while it is alive, and stops printing when it
ends or stalls. `review complete` takes `--head <sha>` like `start`, `attach` and `ingest`, and
the head gate checks that commit without being loosened.

## Outcome criteria

- Запрос (дословно): «Operator asked to keep fixing keryx while the live review runs. Close the two limits you reported», relayed by the coordinator on 2026-10-14
- Эффект (формализация агента): a wrapper with an idle timeout of a few minutes sees a live review run as live; a run that really stalls is still stopped by `--stall-minutes` and the lines end with it; a round reviewed at a commit the manifest did not record can be closed against the commit it did review, and a head that is not the pull request's head still fails the gate
- Как наблюдать (предложение агента): `keryx review run --autonomous --json 2>err` fills `err` with a `heartbeat:` line every minute with no change in progress; `keryx review complete <pkg> --head <sha>` on a package with a different recorded head prints a `replaces the head recorded` warning and closes, while `--head <not the PR head>` fails with the first-line message

## Out of Scope

- Raising the 30 minute idle ceiling of `shell_exec`.
- Changing how `resolveTargetHead` prefers the local HEAD.
- Changing the head gate in `complete-head-gate.ts`.
- Making the child's stall detection count the keep-alive lines.
