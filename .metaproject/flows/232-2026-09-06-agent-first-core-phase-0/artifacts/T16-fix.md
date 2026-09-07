# M10 child budget correction

The independent T16 probe found that spawn_subagent.max_tool_calls fed maxRounds and never configured the child invocation cap. The root fixed that wiring after RED regression evidence.

- max_tool_calls now passes the nonnegative safe integer invocation cap into child AgentDeps.maxToolCalls. Zero is a deny-all cap.
- max_rounds is a separate positive safe integer; default 10, existing hard maximum 24. Invalid limits fail before provider creation.
- External runtimes with explicit native limits are rejected because this seam cannot enforce those limits; it does not silently claim enforcement.
- Reservation text states both configured bounds. BudgetExhausted preserves the child terminal reason. The original round exhaustion regression now uses max_rounds.
- M4 stress checks actual BudgetExhausted at two tool calls with an independent round cap. The hang probe reports only its observed four-second window, without claiming an infinite hang or a missing longer deadline.

## Evidence

- New regressions before fix: 13 pass, 3 fail, raw 2026-09-06T11-51-34-919Z_run.log.
- Three focused budget/child/external files after fix: 36 pass, 0 fail, 159 assertions; raw 2026-09-06T12-02-00-599Z_run.log.
- Original independent probe after fix: one provider request, BudgetExhausted, reservation rounds≤10 calls≤1; raw 2026-09-06T12-05-19-389Z_run.log. Its second-request result counter is absent/zero because no second request occurs; it is not used as the actual invocation count.
- Actual M4a fixture: BudgetExhausted at cap2/rounds10, PASS; M4b remained RISK at its four-second observation window. Raw 2026-09-06T12-02-23-028Z_run.log. Later wording clarifies observation limits.
- Root-owned scoped ESLint clean; raw 2026-09-06T12-03-18-916Z_run.log. Strict scripts check found a helper return annotation widening away child status; corrected to SpawnSubagentTool. Final script check is required before acceptance.

Independent T16 recheck is pending. This report does not mark the whole flow verified.
