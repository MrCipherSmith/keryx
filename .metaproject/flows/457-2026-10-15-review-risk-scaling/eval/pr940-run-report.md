# PR #940 live eval: new review plan (Opus rerun)

Reviewers and verifiers on Opus. Head 489d410f, diff 216 KB, 57 files. Plan v1 routing (before the "code is always deep" rule).

## Plan
15 slices: 5 deep (03, 07, 09, 10, 13; 07 and 10 audit samples), 10 light. 23 reviewer dispatches run vs 37 old plan (-38%; plan-eval said 21 without the 2 regression dispatches). Estimate 12–30 min (old 20–50); measured ~14 min incl. ~4 min waiting for the subagent cap. 3 verifier dispatches. ~2.4M reviewer + 0.23M verifier tokens.

## Recall
- F-001 found by logic-5 F-002 (same mechanism; light slice-15)
- F-007 found by sec-1 SEC-002
- F-008 found by sec-1 SEC-002 and sec-2 SEC-1
- R-SEC-bc02c45d found by sec-1 SEC-001 (as blocker)
3/3 majors + 1/1 uncertain; nothing missed.

## Extras (13 distinct from 18 raw blocker/major)
Confirmed (8): E1 isIrreversibleAsk weaker copy of the decisions check; E2 dispatch-check cannot find its schema in the npm build; E3 BUSY_REFUSED_COMMANDS misses /sessions; E5 subagent concurrency 3→10 with no 429 recovery; E7 retry state keyed by role, never reset; E8 answer replay ignores offered options; E10 trust-mode triggers get 200 rounds + follow-through; E12 the model can forge an operator answer through slate_note.
Refuted (5): E4, E6, E9, E11, E13. Precision 8/13 = 0.62.

## Verdict
Equal on known defects (4/4), better on confirmed extras, fewer dispatches → better overall.
