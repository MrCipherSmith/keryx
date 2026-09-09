# T20 Implementation — Closing T16-final-review's Four Findings

Per-finding evidence. All commands were run via `bun src/cli.ts ctx run --`
(or `ctx rg` for search); raw logs are under
`.metaproject/data/gdctx/raw/`. No network call, no model/API call, no real
provider — deterministic in-memory/scripted providers only.

## F-001 (major) — untruthful no-progress terminal reason

**Change.**
- `src/session/slate-terminal-state.ts`: added `"no_progress"` to
  `TerminalStateReason` (alongside the existing `"ask_user_unanswerable"`,
  `"budget_exhausted"`, `"tool_call_budget_exhausted"`, `"other"`), with an
  updated doc comment explaining the distinction from `"budget_exhausted"`.
- `src/commands/agent.ts`, `runAgentTurnCore`'s unattended no-progress
  branch: `emitTerminalState(io, deps, options, "budget_exhausted")` →
  `emitTerminalState(io, deps, options, "no_progress")`, with an inline
  comment naming the actual cause (the per-signature `MAX_ATTEMPTS_PER_HASH`
  guard, not either budget).

**Compatibility check performed before widening the union** (per the
dispatch's guard): `bun src/cli.ts ctx rg -n "TerminalStateReason" src`
returned exactly 3 files — the type's own declaration
(`slate-terminal-state.ts`), a comment-only reference in
`slate-terminal-state.test.ts` (quoting the old 3-member union inside a RED
comment, not live code), and the one production import site in `agent.ts`.
No exhaustive `switch`/lookup keyed on the union exists anywhere in `src/`,
so adding a member cannot break a recorded consumer. Raw:
`.metaproject/data/gdctx/raw/2026-09-06T13-35-27-271Z_rg.log`.

**Enumeration of all four `emitTerminalState` call sites** (dispatch
requirement — confirm the other three already report truthfully):
`bun src/cli.ts ctx rg -n "emitTerminalState" src/commands/agent.ts` →
declaration + exactly 3 call sites shown directly (`"budget_exhausted"` at
the round-budget entry guard, `"ask_user_unanswerable"` at the `ask_user`
interception, `"tool_call_budget_exhausted"` at the tool-call-budget guard);
the 4th (no-progress) site was located by reading the surrounding code
(`.metaproject/data/gdctx/raw/2026-09-06T13-35-15-996Z_run.log`) since it
was mid-edit at grep time. All three untouched sites were read in full
alongside their `finishReason` and confirmed unchanged and correct — they
already pass the reason matching their own cause.

**Regression.** Added
`T20 F-001: an unattended no-progress stop reports a truthful terminal
reason while both budgets still have capacity` to
`src/commands/agent-tool-call-budget.test.ts`: `unattended: true`,
`maxRounds: 20`, `maxToolCalls: 50`, a tool that fails identically on every
attempt. Asserts `finishReason === "no-progress"`, exactly 4 provider
requests and 3 real invocations (16 rounds / 47 calls unspent — provably not
a budget stop), exactly one emitted `TerminalState`, and
`terminalStates[0].reason === "no_progress"` (explicitly `!== "budget_exhausted"`).

**Evidence the fix is truthful, not reworded.** The reviewer's own unchanged
probe (`T16-final-core-budget-probe.ts`, case `C11`) now reports:
```
"providerRequests": 4, "roundsRemaining": 16,
"invocations": 3, "callsRemaining": 47,
"finishReason": "no-progress",
"terminalStateReasons": ["no_progress"]
```
(previously `["budget_exhausted"]` per the review). Raw:
`.metaproject/data/gdctx/raw/2026-09-06T13-39-29-322Z_run.log`.

## F-002 (minor) — stale `offerRoundLimitReset` doc comment

**Change.** Rewrote the final sentence of the doc comment above
`offerRoundLimitReset` in `src/commands/agent.ts`. It previously claimed
cancel/thrown-picker/unwired-picker "falls through to the existing
`finishWithBudgetSummary` wrap-up unchanged" — false since T19. It now
states the actual T19 behavior: `stopAtRoundLimit` (the caller) prints the
round-limit notice and returns `"stop"`, and the round-guard that invoked it
returns `finishReason: "budget"` directly with no further provider request;
`finishWithBudgetSummary` is reached only from the no-progress branch, and
only when a round remains.

**Verification.** `agent.test.ts`'s existing regression `"runAgentTurn:
askUser answering 'cancel' at the round budget stops without a wrap-up
request"` (asserts `requests.length === 1`) still passes — see the focused
suite run below — proving the new comment text matches the code it
documents.

## F-003 (minor) — `SubagentCompletionStatus` doc omits the tool-call-budget mapping

**Change.** Extended the `"BudgetExhausted"` bullet in
`src/harness/tool/builtin/spawn-subagent-tool.ts`'s `SubagentCompletionStatus`
doc comment to name both `finishReason: "budget"` and
`finishReason: "tool-call-budget"` as the two causes that map to
`"BudgetExhausted"`, and to point at the `MAE reservation:` line as where
the actually-configured caps are reported. No code change — the mapping
logic at the `status` assignment (`finishReason === "budget" ||
finishReason === "tool-call-budget" ? "BudgetExhausted" : ...`) was already
correct; only the doc undersold it.

**Verification.** The reviewer's unchanged probe `D1` in
`T16-final-child-budget-probe.ts` (`max_rounds: 5`, `max_tool_calls: 2`)
still reports `status: "BudgetExhausted"` with `rounds≤5 calls≤2` unspent on
the round side — exactly the case the corrected doc now describes. Raw:
`.metaproject/data/gdctx/raw/2026-09-06T13-39-35-429Z_run.log`.

## F-004 (minor) — duplicated round-ceiling guard

**Change.** Deleted the trailing `if (roundState.round >=
roundState.maxRounds) { ... return { finishReason: "budget" }; }` block that
was the last statement of the `for (;;)` loop body in `runAgentTurnCore`,
replacing it with a one-line comment explaining why no trailing guard is
needed: falling off the end of a bare `for (;;)` body re-enters at the top,
where the identical entry guard already catches the same case on the very
next iteration. Zero behavioral change — the entry guard is unconditional
and runs on every iteration including the one immediately following the
deleted block's position.

**Verification.** Every case that could exercise the ceiling (tool-bearing
response landing on the final allowed round, exact-boundary stops, the
committed budget regressions) is unaffected: the focused suite below is
unchanged in pass count and behavior, and the reviewer's probes C1–C11 all
still pass with identical `providerRequests`/`finishReason` values to the
pre-fix run recorded in `T16-final-review.md`.

## Verification summary

| Check | Result | Raw log |
|---|---|---|
| `bun .metaproject/flows/.../T16-final-core-budget-probe.ts` (unchanged) | 11/11 pass; C11 now `terminalStateReasons: ["no_progress"]` | `.metaproject/data/gdctx/raw/2026-09-06T13-39-29-322Z_run.log` |
| `bun .metaproject/flows/.../T16-final-child-budget-probe.ts` (unchanged) | 4/4 pass | `.metaproject/data/gdctx/raw/2026-09-06T13-39-35-429Z_run.log` |
| `bun test src/commands/agent.test.ts src/commands/agent-tool-call-budget.test.ts src/harness/tool/builtin/spawn-subagent-tool.test.ts` | 111 pass / 0 fail, 452 assertions (110/444 before + the new F-001 regression) | `.metaproject/data/gdctx/raw/2026-09-06T13-39-18-181Z_run.log` |
| `bun run typecheck` | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T13-39-53-313Z_run.log` |
| `bun run typecheck:scripts` | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T13-40-02-821Z_run.log` |
| `bunx eslint` on all 4 changed files | exit 0, no output | (interactive; not gdctx-routed — plain lint invocation, no project search) |
| `git status --porcelain` scoped to owned files | exactly the 4 expected files (`agent.ts`, `spawn-subagent-tool.ts`, `slate-terminal-state.ts` modified; `agent-tool-call-budget.test.ts` untracked from an earlier task) | `.metaproject/data/gdctx/raw/2026-09-06T13-40-38-194Z_run.log` |

## Files changed

| File | SHA-256 (post-change) |
|---|---|
| `src/commands/agent.ts` | `29cef9729333e75cdc5a6721ebdc7669db206416e9d115b8d5ed254858e0ad37` |
| `src/commands/agent-tool-call-budget.test.ts` | `cf3496ec69717a71cf86af2017a1903562f0fdce555282c0142658c2535e5e96` |
| `src/harness/tool/builtin/spawn-subagent-tool.ts` | `cd7d77f81b7c55db35489373bb6d9ba41f752df7b014380f188dba3ebf188de9` |
| `src/session/slate-terminal-state.ts` | `bfa97eb813d0ff3735eb258d3784a105dabd41d6b6436b5317bdc2bcf6ee2650` |

`src/session/slate-terminal-state.ts` is outside the dispatch's literal
owned-file list (`agent.ts`/its tests, `spawn-subagent-tool.ts`/its test),
but its `TerminalStateReason` union is the unavoidable, minimal-diff
dependency of the F-001 fix: the dispatch itself names this exact file and
line ("add a `no_progress` member to `TerminalStateReason`
(`src/session/slate-terminal-state.ts:18`)") as the smallest truthful
option. No other file was touched.

## Routing audit

- `graph_used: no (unavailable-as-current)` — same rationale as T16-final
  and T19: the working tree carries uncommitted M10/T19/T20 edits from
  concurrent tasks that the last graph build predates; bounded source reads
  and executed probes were authoritative.
- `wiki_used: no (not-relevant)` — the frozen AC, `T16-final-review.md`'s
  findings, and `T19-spec.md`'s approved contract fully defined this local
  correction; no architectural or domain-knowledge question arose.
- `ctx_used: yes` — every search, read, test run, probe execution, and
  typecheck went through `bun src/cli.ts ctx rg` / `ctx run`; raw logs cited
  above and in `T20-result.json`.
- `raw_rg_used: no` — no bare `rg`/`grep` over the source tree. `bunx
  eslint` and `sha256sum`/`git status --porcelain` on already-known file
  paths are not code search and were run directly (eslint is a project
  linter invocation the dispatch itself names outside the `ctx` routing
  requirement; `sha256sum`/`git status` are metadata, not content search).
