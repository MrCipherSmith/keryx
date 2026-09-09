# T19 Implementation Spec — Strict Model-Round Budgets

## Problem

`AgentDeps.maxRounds` is documented as a maximum number of model round trips, and `spawn_subagent.max_rounds` exposes that promise directly. The loop currently checks `round > maxRounds` only after executing the excess response and its tools. An interactive child then makes another provider request for a tool-free summary. The independently reproduced `max_rounds: 1` case therefore makes three provider requests and two tool invocations while reporting `rounds≤1`.

## Required behavior

1. Treat `maxRounds` as an inclusive hard ceiling on every `provider.stream()` request in one `runAgentTurn` call.
2. A text-only completion within the final allowed round remains a clean completion.
3. When a tool-bearing or reprompting response uses the final allowed round, execute only work contained in that allowed response, then stop with `finishReason: "budget"`; do not issue another provider request.
4. When `maxRounds` is zero, issue no provider request and stop with the round-budget reason.
5. Preserve the independent `maxToolCalls` counter and its more specific `finishReason: "tool-call-budget"` when that cap is reached in the allowed round.
6. Preserve interactive reset: offer it when another round would be required; if reset is accepted, raise the ceiling before the next provider request. Cancellation stops locally without a model wrap-up.
7. A no-progress stop may use a model wrap-up only when a round remains; that wrap-up counts against `maxRounds`. If no round remains, stop locally.
8. Keep child status mapping truthful: a strict round stop maps to `BudgetExhausted`; no hidden summary request is made.

## Test plan

- Add a core regression with `maxRounds: 1` whose provider emits one tool per request; assert one provider request, one actual invocation, `finishReason: "budget"`, and no wrap-up request.
- Strengthen the child `max_rounds: 1` status test to count provider requests and fleet tool events; assert exactly one of each and `BudgetExhausted`.
- Correct obsolete N+1 tests to assert inclusive strict semantics rather than deleting coverage: exact-ceiling stop, interactive reset/cancel, unattended zero-round history/terminal state, and round-vs-call reason independence.
- Run the focused agent, budget, child, external seam, and stress tests; run scoped ESLint plus root/scripts TypeScript checks.

## Compatibility

The correction intentionally changes only behavior that violated an explicit configured/documented maximum. Existing defaults, environment resolution, text-only completion, tool-call budgets, repeated-signature limits, terminal-state shapes, and reset behavior remain. The former N+1 tool round and unbudgeted summary request are obsolete expectations, not compatibility guarantees.

## Files

- `src/commands/agent.ts` — enforce/check inclusive provider-round capacity and avoid unbudgeted wrap-up.
- `src/commands/agent.test.ts` — update legacy round-loop expectations and terminal-state fixtures.
- `src/commands/agent-tool-call-budget.test.ts` — add strict core regression and preserve independent call-cap assertions.
- `src/harness/tool/builtin/spawn-subagent-tool.ts` — update round-budget comments if needed; behavior flows through the core.
- `src/harness/tool/builtin/spawn-subagent-tool.test.ts` — strengthen child-path strict cap regression and correct old N+1 prose.
- `scripts/stress/keryx-shell-stress.ts` — keep M4 semantics truthful if focused verification exposes stale wording.

## Routing audit

- `graph_used: yes` — graph context identified the module but reported 130 uncommitted code files; it was treated as stale and bounded source reads were authoritative.
- `wiki_used: no (not-relevant)` — the frozen AC, independent executable reproduction, and current source fully define this fix.
- `ctx_used: yes` — searches and executable evidence use `keryx ctx`; bounded direct reads covered every dispatched target file.
- `raw_rg_used: no`.
