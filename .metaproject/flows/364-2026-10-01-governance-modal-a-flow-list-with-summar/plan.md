# Implementation Plan

Status: ready for review (before freeze)

## Approach

Three layers, each usable without the next.

1. **Data** (governance aggregate). Add `effect` and `summary` to `FlowGovernance`, derived from
   `description.md` and `flow.tasks` with the existing description-intent helpers. No model.
   Rendered in the markdown report too, so CLI and modal agree.
2. **Read-only completion check** (flow service). Extract the gate evaluation out of `complete()` into
   one function. `complete()` keeps its transition, attempt record and signature around it; the new
   `checkComplete()` calls the same function on a read of `flow.json` and writes nothing. Expose it as
   `keryx flow check-complete <id> [--json]` and register it in the command descriptor registry. Add the
   PR merge state to `TrackerAdapter.prStatus`.
3. **Modal** (TUI). Turn `/governance` into two tabs: Flows (selectable list with summary and effect,
   `c` check, `x` close) and Report (today's markdown view). Check and close run in-process, like the
   report runner, never through the JobRegistry.

Close requires check passed, PR merged (or merged commit recorded), and a check newer than the flow's
`updatedAt`; then a typed confirmation of the flow id; then the real `complete()`. The gate is never
bypassed: `complete()` re-evaluates everything itself.

## Steps

1. Branch from `origin/main`. Read `src/flow/description-intent.ts`, `src/governance/*`, and the
   `complete()` gate block on main.
2. Governance data: `effect`, `summary` types, extraction, aggregate, markdown lines, reader
   compatibility. Tests (AC1, AC2).
3. Tracker: optional `state` on `prStatus`, mapped to a merge state. Tests.
4. Flow service: extract gate evaluation; add `checkComplete`; CLI `flow check-complete`; descriptor
   registry entry; byte-identical `flow.json` test (AC4).
5. TUI: Flows tab, selection, check/close actions with clickable labels, typed confirmation, repaint and
   report re-run after close, `inputBlocked` guard (AC3, AC5-AC7).
6. Docs: CLI reference for `flow check-complete`, the `/governance` modal keys, CHANGELOG.
7. Self-review, PR, review round, CI.

## Risks

- **Gate extraction drift.** Refactoring `complete()` can change gate order or the recorded attempt.
  Existing `complete` tests (review-gate e2e, confirm-token, completion attempts) must pass unchanged.
- **Side effects inside gates.** The review gate or the health gate may write files (caches, records).
  A check that writes them is not read-only. Verify each gate; when one writes, either pass a no-write
  option or report that gate as "evaluated only on close".
- **Slow gates in the TUI.** Health and the tracker calls take seconds. Run the check asynchronously,
  paint "Checking…", and ignore a result that arrives after the selection or the modal changed.
- **Closing from the wrong branch.** `flow complete` writes `flow.json` in the current checkout. Show the
  current branch in the close confirmation.
