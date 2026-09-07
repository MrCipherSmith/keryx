# T20 Implementation Spec — Close the T16 Final Review's Four Findings

## Scope

Close `T16-final-review.md`'s four findings, regression first (F-001), then the
three documentation/duplication corrections (F-002, F-003, F-004). No other
behavior changes. Files owned: `src/commands/agent.ts` (+ its two focused
tests) and `src/harness/tool/builtin/spawn-subagent-tool.ts` (+ its test).

## F-001 (major) — untruthful terminal reason on the no-progress stop

**Current defect** (`src/commands/agent.ts`, `runAgentTurnCore`, the
unattended branch of the no-progress guard):

```ts
const noProgress = !executedAny && calls.length > 0;
if (noProgress) {
  if (deps.unattended === true) {
    await emitTerminalState(io, deps, options, "budget_exhausted");
    return { finishReason: "no-progress" };
  }
  ...
```

Neither the round budget nor the tool-call budget caused this stop — the
per-signature `MAX_ATTEMPTS_PER_HASH` guard did. `emitTerminalState` is
called with the round-budget reason regardless, so the persisted
`terminal-state.json` and the `io.onTerminalState` callback both misattribute
the cause. This is the class of untruthful budget reporting M10 exists to
remove.

**Fix.** `TerminalStateReason` (`src/session/slate-terminal-state.ts:18-22`)
already carries an unused `"other"` member reserved "for a future caller",
but a member named `"other"` is not itself a truthful, specific label — a
consumer reading `reason: "other"` still cannot distinguish a no-progress
stop from any future unclassified stop. Per the dispatch's compatibility
guard ("if changing the union would break a recorded consumer, say so and
choose the smallest truthful option"): `TerminalStateReason` has exactly one
production consumer (`agent.ts`) and one type-only test (`slate-terminal-state.test.ts`,
comment-only reference to the old 3-member union) — grep confirms no
exhaustive `switch`/lookup keyed on the union exists anywhere in `src/`, so
widening it by one honestly-named member is the smallest option that stays
truthful, not the smallest textual diff. Add `"no_progress"` to the union,
alongside `"ask_user_unanswerable"`, `"budget_exhausted"`, and
`"tool_call_budget_exhausted"` — matching the existing pattern of one
specific member per distinct stop cause — and update the doc comment.
Change the one call site to pass `"no_progress"` instead of
`"budget_exhausted"`. No other `emitTerminalState` call site changes:
`agent.ts`'s round-budget site, the `ask_user` interception site, and the
tool-call-budget site already pass the reason that matches their own cause.

**Regression.** Add a test to `src/commands/agent-tool-call-budget.test.ts`
(the file already dedicated to "genuine budget stops keep their reason"
coverage) mirroring the reviewer's C11 probe: `unattended: true`, generous
`maxRounds`/`maxToolCalls` (both left with capacity), a tool that fails
identically every round so the per-signature guard denies the 4th attempt
and the turn stops with `finishReason: "no-progress"`. Assert via
`io.onTerminalState` that the emitted `TerminalState.reason` is
`"no_progress"`, not `"budget_exhausted"`, and that provider-request/
invocation counts leave both budgets with capacity remaining (proving the
stop was not actually a budget stop). Existing tests in the same file
already cover the two genuine-budget-stop reasons (`"budget"` /
`"tool-call-budget"` finish reasons); no existing assertion pins the
no-progress path to `"budget_exhausted"`, so this is additive.

## F-002 (minor) — stale `offerRoundLimitReset` doc comment

`agent.ts:1712`'s doc comment states cancel/thrown-picker/unwired-picker
"falls through to the existing `finishWithBudgetSummary` wrap-up unchanged".
Under T19 that is false: `stopAtRoundLimit` prints a local notice and
returns `"stop"`; the caller returns `finishReason: "budget"` with no
further provider request (`agent.test.ts:985` asserts exactly one request).
`finishWithBudgetSummary` is reached only from the no-progress branch when a
round remains. Rewrite the final sentence of the comment to say so.

## F-003 (minor) — `SubagentCompletionStatus` doc omits the tool-call-budget mapping

`spawn-subagent-tool.ts`'s `SubagentCompletionStatus` doc comment describes
`"BudgetExhausted"` only as the child's own `maxRounds` running out. The
actual mapping (`status = finishReason === "budget" || finishReason ===
"tool-call-budget" ? "BudgetExhausted" : ...`) deliberately collapses both
reasons. Extend the bullet to name both, matching the dispatch's framing —
runtime behavior is already correct; only the doc undersells it.

## F-004 (minor) — duplicated round-ceiling guard

The trailing block at the end of the `for (;;)` loop body in
`runAgentTurnCore` is byte-identical to the loop-entry guard: same
condition (`roundState.round >= roundState.maxRounds`), same
`stopAtRoundLimit()` call, same `"reset"` continue, same
`{ finishReason: "budget" }` return. It is also the loop body's last
statement, so falling off the end reaches the entry guard on the very next
iteration with identical effect. Delete the trailing copy — a bare
`for (;;)` loop already re-enters at the top, so removing the duplicate
changes zero observable behavior; every case that exercised it (a
tool-bearing response landing exactly on the final round) is still caught by
the entry guard on the loop's next pass. No test currently exercises the
trailing copy independently of the entry guard (the review's own
`enumeration_method`/reproduction confirms probes C1–C11 and the committed
regressions are explained by the entry guard alone).

## Non-goals

- No change to the round/call budget semantics themselves (T19's inclusive
  ceiling contract stays exactly as specified in `T19-spec.md`).
- No change to `SubagentCompletionStatus`'s actual value set or mapping
  logic — F-003 is documentation only.
- No change to any file outside the two owned production files and their
  two owned test files.

## Test plan

1. Add the F-001 regression to `agent-tool-call-budget.test.ts` (RED first:
   run it against the unmodified code to confirm it fails on the current
   `"budget_exhausted"` reason, then implement the fix and confirm GREEN).
2. Re-run the reviewer's two probes unchanged (`T16-final-core-budget-probe.ts`,
   `T16-final-child-budget-probe.ts`) — all fifteen cases must still report
   `pass: true`, and C11's `terminalStateReasons` must now read
   `["no_progress"]` instead of `["budget_exhausted"]`.
3. `bun test src/commands/agent.test.ts src/commands/agent-tool-call-budget.test.ts src/harness/tool/builtin/spawn-subagent-tool.test.ts`.
4. `bun run typecheck` and `bun run typecheck:scripts`.
5. `bunx eslint` on every changed file.

## Files

- `src/session/slate-terminal-state.ts` — add `"no_progress"` to
  `TerminalStateReason`; update the doc comment above the union (this file is
  not in the dispatch's owned-file list, but the union it defines is the
  direct, unavoidable dependency of the F-001 fix in `agent.ts`; the change
  is a one-line additive widening, not a behavior change, and is the
  "smallest truthful option" the dispatch's own compatibility constraint
  calls for).
- `src/commands/agent.ts` — F-001 (call-site reason), F-002 (doc comment),
  F-004 (delete duplicate guard).
- `src/commands/agent-tool-call-budget.test.ts` — F-001 regression.
- `src/harness/tool/builtin/spawn-subagent-tool.ts` — F-003 (doc comment
  only).

## Routing audit

- `graph_used: no (unavailable-as-current)` — same rationale as T19/T16-final:
  the working tree has uncommitted M10/T19/T20-in-progress edits the last
  graph build predates; bounded source reads and executed probes are
  authoritative for this file-level fix.
- `wiki_used: no (not-relevant)` — the frozen AC, `T16-final-review.md`'s
  findings, and `T19-spec.md`'s approved contract fully define this local
  correction; no architectural/domain question arose.
- `ctx_used: yes` — every search and read went through `bun src/cli.ts ctx
  rg` / `ctx run`.
- `raw_rg_used: no`.
