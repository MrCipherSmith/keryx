# T19 verification — strict model-round budgets

## Result

T19's bounded implementation gate passes. `maxRounds` is now an inclusive ceiling on actual `provider.stream()` requests. A final tool-bearing round, an action-request reprompt, or a no-progress summary cannot create a request after the ceiling. `maxToolCalls` remains an independent ceiling on tool invocations.

No global suite was run, as required by the dispatch. Independent review remains assigned to another worker.

## TDD evidence

- Spec written before production: `T19-spec.md`.
- Initial RED: `.metaproject/data/gdctx/raw/2026-09-06T12-22-51-489Z_run.log` — 21 passed, 2 failed. Both failures proved the existing code admitted provider requests/tool invocations beyond `maxRounds: 1`.
- First GREEN: `.metaproject/data/gdctx/raw/2026-09-06T12-25-32-731Z_run.log` — 110 passed, 0 failed across the core agent, independent call-budget, and native child suites.
- Final bounded integration set: `.metaproject/data/gdctx/raw/2026-09-06T12-28-50-292Z_run.log` — 129 passed, 0 failed, 502 assertions across seven files.

## Reproduction result

The independent T16 probe was rerun unchanged:

- Evidence: `.metaproject/data/gdctx/raw/2026-09-06T12-28-36-521Z_run.log`
- Configured `max_rounds`: 1
- Provider requests: 1
- Actual tool invocations: 1
- Child status: `BudgetExhausted`
- Reservation text: `rounds≤1`

This corrects the original 3-request/2-invocation observation while retaining truthful child status.

## Verification commands

| Check | Result | Evidence |
|---|---:|---|
| Focused agent/child/script tests | PASS — 129/0 | `.metaproject/data/gdctx/raw/2026-09-06T12-28-50-292Z_run.log` |
| Main TypeScript target | PASS | `.metaproject/data/gdctx/raw/2026-09-06T12-29-07-607Z_run.log` |
| Scripts TypeScript target | PASS | `.metaproject/data/gdctx/raw/2026-09-06T12-29-10-108Z_run.log` |
| Scoped ESLint over six dispatched files | PASS — 0 findings | `.metaproject/data/gdctx/raw/2026-09-06T12-29-11-540Z_run.log` |
| Original offline strict-cap probe | PASS | `.metaproject/data/gdctx/raw/2026-09-06T12-28-36-521Z_run.log` |

The focused set covered `agent.test.ts`, `agent-tool-call-budget.test.ts`, the native and external spawn-subagent suites, the offline stress fixture, containment checks, and scripts typecheck regression tests. It used scripted providers only; no model or network call was made.

## Behavior and compatibility

- The pre-request guard counts every provider request against the same inclusive counter.
- `maxRounds: 0` stops before provider or tool activity.
- A text-only finish on the last permitted request remains a clean finish.
- A tool-bearing last request executes only that request's admitted calls, then stops with `finishReason: "budget"` before another model request.
- The optional no-progress summary is allowed only when capacity remains and consumes that capacity.
- Interactive reset raises the ceiling before the next request. Cancel/no reset produces a local stop notice.
- Unattended exhaustion emits the existing `budget_exhausted` terminal state without another provider request.
- `maxToolCalls` continues to count only actual invocations, and a tool-call cap still maps to `BudgetExhausted` independently of the round cap.
- Tests and comments that encoded the obsolete `N+1` behavior now assert the strict inclusive contract rather than dropping coverage.

## Changed files

- `src/commands/agent.ts` — added the inclusive pre-request guard, bounded reprompt and no-progress paths, and documented exact round semantics.
- `src/commands/agent.test.ts` — replaced obsolete extra-round expectations with strict stop/reset/terminal assertions.
- `src/commands/agent-tool-call-budget.test.ts` — added strict one-round and zero-round regressions while preserving independent invocation-cap coverage.
- `src/harness/tool/builtin/spawn-subagent-tool.test.ts` — strengthened the native child regression to count real provider requests and tool events.
- `src/harness/tool/builtin/spawn-subagent-tool.ts` — clarified that child round reservations are inclusive and count optional summaries.

## Routing audit

- `graph_used: yes` — gdgraph was consulted for task navigation, but its context reported 130 uncommitted code files; conclusions rely on current source and focused execution rather than treating the graph as fresh.
- `wiki_used: not-relevant` — the frozen acceptance criteria and executable independent reproduction fully define this local loop invariant.
- `ctx_used: yes` — searches, source excerpts, diffs, test output, typechecks, lint, and probe evidence were routed through gdctx.
- `raw_rg_used: no`.

