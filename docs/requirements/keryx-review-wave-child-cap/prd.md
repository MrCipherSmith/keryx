# PRD: review dispatch counts child agents per wave

Status: DRAFT for the operator (decision: poll 181, 2026-10-15). Not frozen.

## Problem

`SUBAGENT_TURN_MAX_CHILDREN = 32` (`src/harness/tool/builtin/spawn-subagent-tool.ts:337`) caps the children one parent turn may spawn; the ledger is renewed only by `resetBudget()` at a new parent turn (`:914-918`). A deep review run in one orchestrator turn (flow 204 chunk waves, 12+ reviewers per wave) reaches 32 and the next reviewer is refused ("MAE child count 32"). In review 7643 this rejected the Sigma reviewer and left the package draft/INCOMPLETE until the operator told the agent to continue.

## Decision

Keep the per-turn cap. A review dispatch counts children per wave: each wave has its own counter of 32. No new global limit is removed: the number of waves is already bounded by the chunk plan (`DEFAULT_MAX_PASSES = 25`).

## Design constraint (fail-closed)

The model must not be able to lift the cap by inventing wave names. A wave key is accepted only if it names a pass of the package's recorded chunk plan (or the single "round" wave of a package without a plan). An unknown key counts against the turn counter as before.

## Out of scope

- The default 32, the runtime pool (16 concurrent children), other spawn paths.
- Chunk planning itself (flow 204 / 451).

## Acceptance criteria (draft)

- AC1: `spawn_subagent` accepts an optional `review_wave` (package path + pass id). With a valid wave the child counts against that wave's own counter of 32 and not against the turn counter. Check: unit test in `src/harness/tool/builtin/spawn-subagent-tool.test.ts` - 32 children in wave A, then 32 more in wave B are admitted; the 33rd in a wave is refused.
- AC2: A `review_wave` that does not name a pass of the package's chunk plan, or whose package is outside the project, is ignored: the child counts against the turn counter and the call is not refused for that reason alone. Check: unit test with an invented wave id (turn cap still refuses the 33rd).
- AC3: The turn counter is unchanged for calls without `review_wave`: the existing `SUBAGENT_TURN_MAX_CHILDREN` tests pass without edits. Check: the same test file.
- AC4: The refusal text names the cap, whether it was a wave or the turn, and the next step (finish the wave with `review chunks record`, or for the turn continue in a new turn). Check: unit test on the refusal message.
- AC5: The review-orchestrator skill (both copies, byte-identical, under the 1615-line ceiling) tells the dispatcher to pass `review_wave` for chunk-plan waves. Check: skill-text test.
- AC6: The ledger total for a package stays bounded: waves x 32 never exceeds `DEFAULT_MAX_PASSES` x 32 for one turn. Check: unit test that the 26th wave is refused.
- AC7: CHANGELOG and the review guide describe the per-wave count and the fail-closed rule. Check: docs coverage tests stay green.
