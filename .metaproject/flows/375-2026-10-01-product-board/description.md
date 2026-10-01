# Product board: flow board as a dashboard

Status: draft

Source: operator flow prompt `~/prompts/keryx-supervisor/flow-A-product-board.md` (2026-09-30); PRD draft `~/notes/flowA-product-board-prd-draft.md`; open questions A1-A3 answered by the operator through a Telegram poll on 2026-10-01 03:48 UTC, all three with the recommended option.

## Problem

The state of the product is visible only as activity: the governance report and the flow summary say what was done, not which of the claims are proven. `keryx product open` lists the closed-but-never-checked intents (321 of 321 at G1) but not as one board, and not alongside what is still in progress or already verified.

## Expected Outcome

One page, `keryx product map`, built only from the derived product index `.metaproject/data/product/`, shows the state of the product rather than activity.

- Columns: in progress / closed in code / effect verified / effect not verified. "Closed in code" holds the last 10 closed flows without an observation; every other closed flow without an observation is in "effect not verified", split into accepted unverifiable and never checked (decision A3).
- Each card shows the flow, its intent, the ACs by verification kind (exec / invariant / judged / none), the outcome criterion and the observed outcome when there is one.
- Above the columns: counters claims / proven / accepted unverifiable / never checked, and contradictions. A contradiction is deterministic only: a closed flow whose observed effect is no-effect or harmed (decision A2). Text contradictions between flows are out of scope.
- Rendered through the existing `keryx dashboard build/open` as static HTML plus a board view in the TUI `/product` surface and a readline text form. No new store, no `keryx serve` live mode.
- A stale or missing index is said out loud (non-zero exit and the command name in the CLI, a visible banner in the HTML), never shown silently.
- The board gates and blocks nothing.
- `keryx product` gains exactly one command, `map` (3 of the 4 allowed by the bulk budget in `docs/requirements/keryx-product-module/implementation-plan.md`); `admit`, `show` and `list` stay refused.

Decision A1 (operator, poll 2026-10-01 03:48 UTC): the G1 product gate is lifted for `map` only; the G1 readout planned for 2026-10-28 stays untouched. decided-by: altsay (poll answer).

## Outcome criteria

Within 10 days the operator opens the board on their own, without a reminder, at least once and decides something from it: closes, cancels or checks an effect.

## Out of Scope

- Live mode through `keryx serve`, a new store, or any gate fed by the board.
- Text contradictions between flows, which need a judge model.
- Changing the G1 gate or the product index schema.
- Live runs of external agents (tests use fakes).
