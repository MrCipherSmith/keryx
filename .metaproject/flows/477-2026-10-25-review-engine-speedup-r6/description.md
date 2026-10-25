# Review engine speedup, step 4: plan estimate against actual time in the round report (R6, E8.1)

Status: draft (flow-init skill formalizes this)
Source: user description (origin: human-request)

## Problem

A round records its plan estimate (`plan.json`: dispatches and a minutes range, from `estimateRound`) and never records what the round actually took. `report.md` does not say "plan 28-70, actual about 43", so calibrating the estimate is only possible by a replay over file mtimes, as in doc 21. The operator also reads the calendar time of the round, which the estimate does not include: on vantage-frontend #8086 the plan was 44-110 minutes, the calendar time first-to-last raw was 106 minutes, and one pause of 59 minutes sat inside it (about 46 active minutes, at the plan's lower bound).

## Expected Outcome

- A new module projects `plan.json` (else `plan-confirmation.json`) and the mtimes of `raw/*.txt` into one line: the plan range and dispatches, the actual time from the first to the last raw reply, the pauses longer than 10 minutes (count and total) and the active time without them.
- `keryx review complete` writes that line into `report.md` (replacing the one it wrote before, never duplicating it) and prints it. A package without raw replies or without a recorded plan says which part is missing instead of inventing a number.
- The review panel's per-review lines show the same line for the open round (actual so far) and the closed one.
- The estimate does not change: `TYPICAL_DISPATCH_MINUTES=2`, `CHILD_DEADLINE_MINUTES=5`, `ASSUMED_PARALLEL_DISPATCHES=4`, `DEFAULT_MAX_DISPATCHES=40`, `DEFAULT_MAX_MINUTES=90` keep their values, and a test pins them.

## Outcome criteria

- Запрос (дословно): «/home/altsay/arena/ideas/pr-review-management/23_KERYX_IMPLEMENTATION_PROMPT.md» (source: Helyx message 226364, 2026-10-25; R6 first: Helyx message 226906; decision to add the line and leave the estimate alone: poll 292)
- Эффект (формализация агента): after a round the operator reads, in the report, the plan against the actual time and how much of the actual time was pauses, so the estimate can be judged without a replay and a long calendar time is not mistaken for a wrong estimate.
- Как наблюдать (предложение агента): on a copy of vantage-frontend #8174 the line shows 28-70, about 43 minutes and no pauses; on a copy of #8086 it shows 44-110, 106 minutes calendar and one pause of 59 minutes; a repeated `review complete` leaves one line.

## Out of Scope

R5 (optional roles). Any change to the estimate parameters or the confirmation thresholds. Measuring the time after the last raw (verifier, premise, ingest, publication), which no file records. Tokens per round. Using `wave-events.jsonl` as the clock (it exists only for rounds run after flow 474; the raw mtimes cover older packages too).
