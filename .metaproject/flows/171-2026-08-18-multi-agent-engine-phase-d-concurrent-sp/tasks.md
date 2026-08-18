# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Context already complete via reviewed requirements package — no context-collector dispatch needed. |
| T2 | implement | Superseded by T5/T6/T7's finer breakdown (kept as the default umbrella; close alongside T5). |
| T5 | implement | D1a: `executeWaves` next to `planWaves` in `scheduler.ts`. D1's ledger-race verification (PRD R8) — confirm `RemainingBudgetLedger`'s grant/decrement has no `await` between check and decrement. Plan steps 1, 4. |
| T6 | implement | D1b/D1c: scoped concurrent `spawn_subagent` branch in `agent.ts`'s tool-call loop, result-order preservation, new `maxConcurrency` config field. Plan steps 2-3. |
| T7 | implement | D2a/D2b: thread `finishReason` out of `runAgentTurn`; consume in `spawn-subagent-tool.ts` to set `SubagentCompletionStatus` on all 5 branches (Completed/BudgetExhausted/NoProgress/Timeout/Denied/Error). Plan steps 5-6. |
| T3 | test | AC9-AC12 test coverage across `scheduler.test.ts`, `spawn-subagent-tool.test.ts`, `agent.test.ts`. Plan step 7. |
| T8 | docs | Flip requirements package status notes (README/prd/specification/implementation-plan/agent-protocol) to implemented with runtime evidence, once T5-T7 land. Plan step 8. |
| T4 | review | Self-review + code-verifier + review-orchestrator (this touches sensitive core harness code — the interactive turn loop and the shared budget ledger — extra scrutiny on the R8 race concern) + prepare PR. |
