STATUS: DONE_WITH_CONCERNS

# T16 Final Independent Review — M10 Budget Corrections (post-T19)

## Scope

- Branch: `codex/agent-first-core`
- Base / merge-base: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Reviewer: `review-logic`, independent — did not author T8, T19, or any prior T16 artifact.
- Stage 1 (specification compliance) covers dispatch `232-T16-final` task items (1)–(7) and
  acceptance criteria AC3/AC4/AC5 of flow 232. Stage 2 (code quality) was entered only after
  Stage 1 passed.
- Excluded and not reviewed: `src/security/*` and `.metaproject/flows/233-*` (concurrent
  workers), M01 routing, T18 lint scope, external providers, network, and any model API call.

Source SHA-256 of every reviewed file, at review time:

| File | SHA-256 |
|---|---|
| `src/commands/agent.ts` | `a9f55fa1fc0e377eeded958a1ee6828ef8d425ae05ba884bf93234bf1437f604` |
| `src/commands/agent.test.ts` | `11f6d11e513bcdc7b032b6669e5f89a02e467836292ec8f81fd71d4a3c721eb6` |
| `src/commands/agent-tool-call-budget.test.ts` | `fddc17f29a91ab11d192e3e53d8dc996863d6a509d7e5465fb4b983c381e5ed7` |
| `src/harness/tool/builtin/spawn-subagent-tool.ts` | `bcb86caa2461ffccd35899aefbc1fbdfe5b5434a4213a5fc93d12479fda4d198` |
| `src/harness/tool/builtin/spawn-subagent-tool.test.ts` | `0b7d9a3a945cb9c802092d81bf7c1b1dea963b20e0016ef56d919cc6fa111153` |
| `scripts/stress/keryx-shell-stress.ts` | `c240bbaef6354c04d71d4983257724212cf55f0ed633d7a17c2570b28d5e7b13` |
| `scripts/stress/keryx-shell-stress.test.ts` | (unmodified; read for AC4 evidence) |
| `scripts/benchmark/run-containment.ts` | (read for AC4 evidence) |
| `scripts/typecheck.test.ts`, `tsconfig.scripts.json` | (read for AC5 evidence) |

Preserved earlier T16 evidence is unchanged: `T16-recheck-round-budget-probe.ts` still hashes
`9be925af4701a9fe3a3ee44185808c753966d5019a80dfaa175a1c7c112ef009`, the value recorded in
`T16-recheck.md`. Nothing under `artifacts/` other than this report, `T16-final-result.json`,
and the two new `T16-final-*.ts` probes was written.

## Summary

- blocker: 0
- major: 1
- minor: 3
- info: 0

The two defects the earlier T16 rounds found are closed on the current code, verified by
re-running the preserved probes unchanged and by eleven new core-level and four new child-level
probe cases written for this review. `maxRounds` is now an inclusive hard ceiling on
`provider.stream()` calls per `runAgentTurn`, `maxToolCalls` is a genuinely independent
invocation counter with its own terminal reason, and the child's reservation and prompt text
report the limits that are actually enforced (including the 24-round cap when the model asks
for more). AC3, AC4 and AC5 are met.

One major remains, adjacent to AC3 rather than inside its literal wording: the unattended
`TerminalState` for a **no-progress** stop is emitted with `reason: "budget_exhausted"` while
both the round budget and the call budget still have capacity. The three minors are two stale
doc comments in the functions T19 restructured and one duplicated guard.

## Stage 1 — specification compliance

| Criterion | Verdict | Evidence |
|---|---|---|
| (1) `maxRounds` is an inclusive hard ceiling on every `provider.stream()` request in one `runAgentTurn`, wrap-up included | **MET** | Pre-request guard at `agent.ts:1257`; probe C3 shows a no-progress wrap-up consuming the 5th of 5 rounds (requests=5, last request tool-free) and C4 shows no wrap-up when the ceiling is already spent (requests=4/4). Raw `2026-09-06T13-26-54-764Z_run.log` |
| (2) `maxRounds: 0` issues no provider request and stops with the round-budget reason | **MET** | Probe C9: `providerRequests=0`, `invocations=0`, `finishReason="budget"`, even with an interactive picker wired. Raw `2026-09-06T13-26-54-764Z_run.log`; committed regression `agent-tool-call-budget.test.ts` "zero maxRounds stops before provider or tool activity", raw `2026-09-06T13-23-24-585Z_run.log` |
| (3) text-only finish inside the final allowed round is clean; a tool-bearing final round runs only its own tools then stops with `finishReason: "budget"` and no further request | **MET** | Probe C1 (maxRounds 2, tool then text): requests=2, `finishReason=null`, text delivered, no `[budget]` notice. Probe C2 (maxRounds 1, text-only): requests=1, clean. Tool-bearing side: preserved `T16-recheck-round-budget-probe.ts` rerun — requests=1, invocations=1, `BudgetExhausted`. Raws `2026-09-06T13-26-54-764Z_run.log`, `2026-09-06T13-18-40-919Z_run.log` |
| (4) interactive reset raises the ceiling before the next request; cancel stops locally with no wrap-up | **MET** | `offerRoundLimitReset` mutates `roundState.maxRounds` before the loop re-tests it (`agent.ts:1746`); committed regressions `agent.test.ts:935` (reset → 3 requests, "Round limit increased — 41") and `agent.test.ts:985` (cancel → exactly 1 request, no wrap-up). Probe C7 shows an `AbortSignal` cancellation stopping mid-batch with one request and one invocation. Raws `2026-09-06T13-23-24-585Z_run.log`, `2026-09-06T13-26-54-764Z_run.log` |
| (5) `maxToolCalls` counts actual successful invocations across batches, is independent of `maxRounds`, and yields `finishReason: "tool-call-budget"` | **MET** | Probe C8 (maxRounds 10, maxToolCalls 1): requests=1, invocations=1, `finishReason="tool-call-budget"` — the round budget is untouched and the reason is not relabelled. Probe C10 (maxToolCalls 0): `tool.invoke` never reached, invocations=0. Committed regressions cover cross-round accumulation and non-consumption by unknown/denied calls. Raws `2026-09-06T13-26-54-764Z_run.log`, `2026-09-06T13-23-24-585Z_run.log` |
| (6) `spawn_subagent` maps `max_tool_calls` and `max_rounds` to distinct limits; reservation/prompt text is truthful; a strict round stop maps to `BudgetExhausted` | **MET** | Probe D1 (`max_rounds:5`, `max_tool_calls:2`): reservation `rounds≤5 calls≤2`, system instruction carries both, call cap binds first at 2 requests / 2 invocations. D2: a child finishing inside its budget is `Completed`, not blanket `BudgetExhausted`. D3: `max_rounds:100` is capped to 24 and **every** model-facing and result-facing number reports 24, never 100. D4: `max_tool_calls:0` stops the child at one request with `calls≤0`. Preserved `T16-child-budget-probe.ts` rerun: `rounds≤10 calls≤1`, one request. Raws `2026-09-06T13-23-01-968Z_run.log`, `2026-09-06T13-18-45-752Z_run.log` |
| (7) benchmark/stress scripts terminate finitely with typed errors; the stress report uses the existing resolver | **MET** | `resolveContainmentPort` (`run-containment.ts:115`) throws `RangeError` for an absent/out-of-range port — no fallback default. The stress report (`keryx-shell-stress.ts:1023-1032`) is written from `resolveShellSandboxMode(process.env)` and `resolveAgentMaxRounds()`. The hang probe M4b is bounded by `Promise.race` with a 4 s window and states honestly that it does not establish the longer deadline. Focused execution: 3 pass / 0 fail, raw `2026-09-06T13-23-29-634Z_run.log` |
| **AC3** (M10): offline stub proves the actual configured round/call budget stops execution with a truthful terminal reason; `maxToolCalls` is never silently ignored or represented by `maxRounds` | **MET** | Rows (1)–(6) above. Both budgets stop execution at their configured value and report the reason belonging to the budget that stopped it (`budget` vs `tool-call-budget`; `budget_exhausted` vs `tool_call_budget_exhausted`). The `max_tool_calls`→`maxRounds` conflation of the first T16 round is gone: D1 shows the two limits carried separately end to end. Raws `2026-09-06T13-26-54-764Z_run.log`, `2026-09-06T13-23-01-968Z_run.log`, `2026-09-06T13-18-40-919Z_run.log`, `2026-09-06T13-18-45-752Z_run.log` |
| **AC4** (M10): stress JSON creation uses an existing resolver and writes a report in the offline fixture; optional containment port is handled with no unsafe default | **MET** | `keryx-shell-stress.test.ts` runs the script offline with `KERYX_AGENT_MAX_ROUNDS=7` and asserts exactly one `stress-*.json` whose `maxRounds` is 7 — i.e. produced by `resolveAgentMaxRounds()`, not a literal. `run-containment.test.ts` asserts the bound port is accepted and `undefined` throws. 3 pass / 0 fail, raw `2026-09-06T13-23-29-634Z_run.log` |
| **AC5** (M10): a scripts TypeScript check covers the benchmark/stress scripts and fails on an injected type error; root and scripts checks pass without external model calls | **MET** | `tsconfig.scripts.json` includes `scripts/benchmark/**` and `scripts/stress/**`; `scripts/typecheck.test.ts` asserts membership of `run-ablation.ts`, `run-containment.ts`, `keryx-shell-stress.ts` in the parsed file set, then proves an injected `TS2322` fails an extending project. 2 pass / 0 fail (raw `2026-09-06T13-23-39-457Z_run.log`); `bun run typecheck` exit 0 (raw `2026-09-06T13-23-53-162Z_run.log`); `bun run typecheck:scripts` exit 0 (raw `2026-09-06T13-24-00-402Z_run.log`). No network or model call in any of them |

Stage 1 passes. Stage 2 follows.

## Findings

### [F-001] Unattended no-progress stop reports the round-budget terminal reason while both budgets still have capacity

- **Severity**: major
- **File**: `/Users/Goodea/goodea/keryx/src/commands/agent.ts:1680`
- **Symbol**: `runAgentTurnCore` — no-progress branch
- **Problem**: when every tool call in a round is denied by the per-signature attempt guard
  (`MAX_ATTEMPTS_PER_HASH`), the loop returns `finishReason: "no-progress"`, which is correct.
  For an unattended run it first emits `emitTerminalState(io, deps, options, "budget_exhausted")`.
  That reason is the round-budget one. `TerminalStateReason` already distinguishes
  `tool_call_budget_exhausted` from `budget_exhausted` and carries an `other` member, so the
  distinction is expressible and is drawn everywhere else.
- **Impact**: the machine-readable stop record an unattended operator or automation consumes
  (`io.onTerminalState`, and the persisted `terminal-state.json` next to `slate.json`)
  misattributes the cause. The obvious remediation it invites — raising
  `KERYX_AGENT_MAX_ROUNDS` / `max_rounds` — cannot help, because the round budget was not the
  constraint. This is the same class of untruthful budget reporting M10 exists to remove, on the
  one stop path that is not itself a budget stop.
- **Reproduction**: probe case `C11` in
  `/Users/Goodea/goodea/keryx/.metaproject/flows/232-2026-09-06-agent-first-core-phase-0/artifacts/T16-final-core-budget-probe.ts`
  — unattended, `maxRounds: 20`, `maxToolCalls: 50`, a tool that fails identically each round.
  Observed: `providerRequests=4` (16 rounds remaining), `invocations=3` (47 calls remaining),
  `finishReason="no-progress"`, `terminalStateReasons=["budget_exhausted"]`.
  Raw: `.metaproject/data/gdctx/raw/2026-09-06T13-26-54-764Z_run.log`.
- **Suggested fix**: emit a reason that matches the cause on this path. Either add a
  `no_progress` member to `TerminalStateReason` (`src/session/slate-terminal-state.ts:18`) and
  pass it here, or pass the existing `"other"` until a dedicated member is agreed; add a
  regression asserting the reason for a no-progress stop with round and call capacity
  remaining.
- **Class scope**:
  - sites: `src/commands/agent.ts:1235` (round budget → `budget_exhausted`, correct),
    `src/commands/agent.ts:1517` (`ask_user` interception → `ask_user_unanswerable`, correct),
    `src/commands/agent.ts:1668` (tool-call budget → `tool_call_budget_exhausted`, correct),
    `src/commands/agent.ts:1680` (no progress → `budget_exhausted`, **incorrect**).
  - enumeration_method: `keryx ctx rg -n "emitTerminalState" src/commands/agent.ts` returned the
    declaration at `:954` plus exactly four call sites; each was read together with the
    `finishReason` returned on the same code path and cross-checked against the
    `TerminalStateReason` union at `src/session/slate-terminal-state.ts:18-21`. One of four
    misattributes.
- **Note on provenance**: the misattribution predates T19 (before it, `roundLimitReached ||
  noProgress` shared one branch and one reason). T19 split the branch and kept the round-budget
  reason on the no-progress side, so the site is inside this branch's diff and is now trivially
  separable.

### [F-002] `offerRoundLimitReset`'s contract comment still promises the wrap-up path T19 removed

- **Severity**: minor
- **File**: `/Users/Goodea/goodea/keryx/src/commands/agent.ts:1712`
- **Symbol**: `offerRoundLimitReset` (doc comment)
- **Problem**: the comment states that a cancel, a thrown picker, or an unwired picker "falls
  through to the existing `finishWithBudgetSummary` wrap-up unchanged". Under T19 none of them
  does: `stopAtRoundLimit` prints a local notice and returns `"stop"`, and the caller returns
  `finishReason: "budget"` without another provider request. `agent.test.ts:985` asserts exactly
  that (one request).
- **Impact**: the next editor of this function reads a contract that the code and its own
  regression contradict — the precise failure mode (documentation promising budget behaviour the
  code does not implement) that this milestone was opened to remove.
- **Reproduction**: read `agent.ts:1704-1714` beside the single remaining
  `finishWithBudgetSummary` call site at `agent.ts:1685`; execute `agent.test.ts` (raw
  `.metaproject/data/gdctx/raw/2026-09-06T13-23-24-585Z_run.log`).
- **Suggested fix**: replace the last sentence with the current behaviour — cancel/no-picker
  stops locally with no further provider request; `finishWithBudgetSummary` is now reached only
  from the no-progress path when a round remains.

### [F-003] `SubagentCompletionStatus` documents `BudgetExhausted` as the round budget only, but the tool-call budget maps there too

- **Severity**: minor
- **File**: `/Users/Goodea/goodea/keryx/src/harness/tool/builtin/spawn-subagent-tool.ts:70`
- **Symbol**: `SubagentCompletionStatus`
- **Problem**: the doc says `"BudgetExhausted"` means "the child's OWN `maxRounds` round budget
  ran out … (`runAgentTurn`'s `finishReason: "budget"`)". The mapping at
  `spawn-subagent-tool.ts:1186-1190` assigns `BudgetExhausted` for **both** `"budget"` and
  `"tool-call-budget"`. The collapse is deliberate (T19 verification says so) but undocumented.
- **Impact**: a reader of the type — the parent-facing advisory contract — will attribute a
  tool-call-cap stop to the round budget. Behaviour is correct and the reservation line still
  shows both configured caps, so this is a documentation/type-contract inaccuracy, not a runtime
  defect.
- **Reproduction**: probe `D1` in `T16-final-child-budget-probe.ts` returns
  `status="BudgetExhausted"` for a run stopped by `max_tool_calls: 2` with `max_rounds: 5`
  unspent. Raw `.metaproject/data/gdctx/raw/2026-09-06T13-23-01-968Z_run.log`.
- **Suggested fix**: extend the bullet to name both reasons, e.g. "the child's own round budget
  (`finishReason: "budget"`) **or** tool-call budget (`finishReason: "tool-call-budget"`) ran
  out; the reservation line reports which caps were configured".

### [F-004] The round-ceiling guard is duplicated at the loop tail with no behavioural difference

- **Severity**: minor
- **File**: `/Users/Goodea/goodea/keryx/src/commands/agent.ts:1695`
- **Symbol**: `runAgentTurnCore` — trailing round guard
- **Problem**: the block at `:1695-1699` is byte-identical in condition and effect to the
  loop-entry guard at `:1257-1262`, and it is the last statement of the `for (;;)` body. Falling
  off the end of the body reaches the entry guard on the next iteration and produces exactly the
  same picker offer, the same message, and the same `finishReason: "budget"`.
- **Impact**: two copies of the strict-ceiling rule must be kept in sync by hand. Given that the
  M10 defect history is precisely "the ceiling check was in the wrong place", a future edit that
  changes one and not the other is the concrete cost.
- **Reproduction**: remove `:1695-1699` and the committed budget regressions still describe the
  same behaviour — the entry guard is what probes C1–C11 and the committed tests actually
  observe.
- **Suggested fix**: delete the trailing block, or keep it and add a one-line comment saying it
  is a fast path for the entry guard so nobody edits one alone.

## Confirmed clean areas

- **Inclusive ceiling arithmetic.** `roundState.round` is incremented immediately before each
  `provider.stream()` call and nowhere else except the no-progress wrap-up (which increments
  first, then requests), so `round` equals the number of provider requests issued. The entry
  guard `round >= maxRounds` therefore admits at most `maxRounds` requests. Probes C1–C6, C9,
  C10 and the preserved round probe all agree.
- **Budget validation happens before any side effect.** `validateDirectBudget`
  (`agent.ts:2155`) throws `RangeError` for a negative or non-integer budget before the history
  push, the provider, the approver, or any tool runs — asserted by the committed
  "invalid direct round and tool-call limits fail before provider, approval, or tool activity"
  test over five invalid shapes.
- **`maxToolCalls` counts only real invocations.** The capacity check sits after tool lookup and
  schema validation but before the approval gate (`executeCall`, `agent.ts:2058`), and
  `reserveInvocation` is charged immediately before `tool.invoke` (`agent.ts:2149`), so unknown
  tools, schema failures and denied approvals never consume the budget, and a denied call never
  reaches `invoke`.
- **A child cannot extend its own budget.** `childDeps` (`spawn-subagent-tool.ts:819-838`) wires
  no `askUser`, so `offerRoundLimitReset` returns `"cancel"` immediately for a child; the
  interactive reset path is reachable only from a real host.
- **The child's advertised numbers are the enforced numbers.** `maxRounds` is clamped by
  `Math.min(MAX_SUBAGENT_MAX_ROUNDS, …)` at `spawn-subagent-tool.ts:481` and the clamped value
  is the one used for the system instruction, the injected task text, and the `MAE reservation:`
  line — probe D3 confirms a request for 100 rounds reports 24 in all three places.
- **External runtimes reject native budgets rather than silently dropping them**
  (`spawn-subagent-tool.ts:482-485`).
- **Concurrent-spawn batching cannot bypass the call budget**: the concurrent branch is entered
  only when `maxToolCalls === undefined` (`agent.ts:1471`).
- **AC4/AC5 script surfaces**: the containment port resolver has no default and throws a typed
  `RangeError`; the stress report is resolver-derived; the scripts TypeScript target genuinely
  covers the benchmark and stress trees and genuinely fails on an injected error.

## Evidence

Every row above cites one of these executed artifacts. All runs used deterministic in-memory or
scripted providers; no network call, no API key, no model call was made. Stats disabled
(`KERYX_STATS=0`).

| What ran | Result | Raw log | SHA-256 |
|---|---|---|---|
| Preserved `T16-recheck-round-budget-probe.ts`, unchanged | requests=1, invocations=1, `BudgetExhausted`, `rounds≤1` | `.metaproject/data/gdctx/raw/2026-09-06T13-18-40-919Z_run.log` | `fac57c91238b5db356506b9535231a51e869effcf7f28b8b16e7f47f954bb3fa` |
| Preserved `T16-child-budget-probe.ts`, unchanged | requests=1, `BudgetExhausted`, `rounds≤10 calls≤1` | `.metaproject/data/gdctx/raw/2026-09-06T13-18-45-752Z_run.log` | `dcede35946a38dd7a34bce2d9e56f355e382e42e4909c7b2574e8ead82a1cc54` |
| New `T16-final-core-budget-probe.ts` (C1–C11) | 11/11 assertions pass; C11 records the F-001 observation | `.metaproject/data/gdctx/raw/2026-09-06T13-26-54-764Z_run.log` | `b10c0416a20d99a1b50db4db0dc6964a7809548aed8dc73e749c8c2ce818ac76` |
| New `T16-final-child-budget-probe.ts` (D1–D4) | 4/4 pass | `.metaproject/data/gdctx/raw/2026-09-06T13-23-01-968Z_run.log` | `1a6566cf321b6ac859d69b7c585fd1398fdc4f4d43b3e921375bd29517880bc1` |
| `bun test src/commands/agent.test.ts src/commands/agent-tool-call-budget.test.ts src/harness/tool/builtin/spawn-subagent-tool.test.ts` | 110 pass / 0 fail, 444 assertions | `.metaproject/data/gdctx/raw/2026-09-06T13-23-24-585Z_run.log` | `f1997ae7e2c7d518409dd25e8f9124db078e48d33815a9de12bf8c6c4aa6e81f` |
| `bun test` over the five other spawn-subagent suites + `agent-permission-mode.test.ts` | 60 pass / 0 fail, 175 assertions | `.metaproject/data/gdctx/raw/2026-09-06T13-28-02-406Z_run.log` | `9e546c13260b0cb9eea3e447e5e6f97781935a64738fb2d3d68215e06421c606` |
| AC4: `keryx-shell-stress.test.ts` + `run-containment.test.ts` | 3 pass / 0 fail, 10 assertions | `.metaproject/data/gdctx/raw/2026-09-06T13-23-29-634Z_run.log` | `2192f10267accf6bfead86a5e5485b5d45af6ed2a22ae0ed5de75aaa8c9f342a` |
| AC5: `scripts/typecheck.test.ts` | 2 pass / 0 fail, 8 assertions | `.metaproject/data/gdctx/raw/2026-09-06T13-23-39-457Z_run.log` | `3e43a75265b82d56b2a7ae33cc37040ca81c85912475196acb6ce021b2cb5618` |
| `bun run typecheck` | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T13-23-53-162Z_run.log` | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| `bun run typecheck:scripts` | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T13-24-00-402Z_run.log` | `b93b65b9afcd13e93f4fda2aa54ee204580a21cf8cbb6889bd90fab11fb0bbd6` |

Probe sources written by this review:

| Probe | SHA-256 |
|---|---|
| `T16-final-core-budget-probe.ts` | `1c4c17ce1b15aa8c1f44b2f97197b49af4a735f7e40b7f9439632fd7f3b73bcf` |
| `T16-final-child-budget-probe.ts` | `0ec1eea8580131ac37920afc0c21c5e5ed90fcc4091f02e43866d4909a173d4e` |

## Routing audit

- `graph_used: no (unavailable-as-current)` — `.metaproject/index.md` requires a rebuild before
  quoting the graph, and this review is forbidden from mutating repository state; the graph
  predates the uncommitted M10/T19 edits, so bounded source reads and executed probes are the
  authoritative navigation for a file-level budget invariant.
- `wiki_used: no (not-relevant)` — the frozen acceptance criteria, the approved `T19-spec.md`,
  and executable reproduction fully define this local loop invariant; no architectural or
  domain-knowledge question arose.
- `ctx_used: yes` — every search, command, test run, typecheck and probe execution went through
  `keryx ctx rg` / `keryx ctx run` / `keryx ctx read`; each raw log is cited above.
- `raw_rg_used: no` — no bare `rg`/`grep` over project code. `grep` was used twice, on gdctx's
  own already-produced raw logs, never on the source tree.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "T16#F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/agent.ts",
    "line": 1680,
    "symbol": "runAgentTurnCore",
    "problem": "The unattended no-progress stop emits emitTerminalState(..., \"budget_exhausted\") even though neither the round budget nor the tool-call budget was exhausted; the stop is caused by the per-signature MAX_ATTEMPTS_PER_HASH guard. TerminalStateReason already distinguishes tool_call_budget_exhausted and carries an unused \"other\" member, so the distinction is expressible.",
    "impact": "The machine-readable stop record consumed by unattended operators and automation (io.onTerminalState and the persisted terminal-state.json) misattributes the cause to the model-round budget. The remediation it invites, raising KERYX_AGENT_MAX_ROUNDS or max_rounds, cannot help. This is the same untruthful-budget-reporting class M10 exists to remove, on the one stop path that is not itself a budget stop.",
    "suggested_fix": "Emit a reason matching the cause: add a \"no_progress\" member to TerminalStateReason in src/session/slate-terminal-state.ts:18 and pass it at agent.ts:1680, or pass the existing \"other\" until a dedicated member is agreed. Add a regression asserting the emitted reason for a no-progress stop while round and call capacity remain.",
    "evidence": "Probe case C11 in .metaproject/flows/232-2026-09-06-agent-first-core-phase-0/artifacts/T16-final-core-budget-probe.ts (unattended, maxRounds 20, maxToolCalls 50, identically failing tool) observed providerRequests=4, roundsRemaining=16, invocations=3, callsRemaining=47, finishReason=\"no-progress\", terminalStateReasons=[\"budget_exhausted\"]. Raw log .metaproject/data/gdctx/raw/2026-09-06T13-26-54-764Z_run.log, SHA-256 b10c0416a20d99a1b50db4db0dc6964a7809548aed8dc73e749c8c2ce818ac76.",
    "confidence": "high",
    "dedupe_key": "agent.ts:no-progress-terminal-reason-misattribution",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": true,
    "class_scope": {
      "sites": [
        "src/commands/agent.ts:1235",
        "src/commands/agent.ts:1517",
        "src/commands/agent.ts:1668",
        "src/commands/agent.ts:1680"
      ],
      "enumeration_method": "keryx ctx rg -n \"emitTerminalState\" src/commands/agent.ts returned the declaration at :954 plus exactly four call sites; each was read together with the finishReason returned on the same path and cross-checked against the TerminalStateReason union at src/session/slate-terminal-state.ts:18-21. Three of four are correct; :1680 (no-progress) is not."
    }
  },
  {
    "id": "F-002",
    "global_id": "T16#F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/commands/agent.ts",
    "line": 1712,
    "symbol": "offerRoundLimitReset",
    "problem": "The doc comment still states that a cancel, a thrown picker, or an unwired picker \"falls through to the existing finishWithBudgetSummary wrap-up unchanged\". After T19 none of them does: stopAtRoundLimit prints a local notice and the caller returns finishReason \"budget\" with no further provider request, which agent.test.ts:985 asserts.",
    "impact": "The next editor of the reset path reads a contract that the code and its own regression contradict, which is the documentation-promises-a-budget-the-code-does-not-honour failure mode this milestone exists to remove.",
    "suggested_fix": "Rewrite the final sentence: cancel, a rejected picker, and an unwired picker all stop locally with no further provider request; finishWithBudgetSummary is now reached only from the no-progress path at agent.ts:1685 when a round remains.",
    "evidence": "Read agent.ts:1704-1714 against the single remaining finishWithBudgetSummary call site at agent.ts:1685 (enumerated by keryx ctx rg -n \"finishWithBudgetSummary\" src/commands/agent.ts: declaration :1755, call :1685, comment :1712). agent.test.ts \"askUser answering 'cancel' at the round budget stops without a wrap-up request\" passes, raw .metaproject/data/gdctx/raw/2026-09-06T13-23-24-585Z_run.log.",
    "confidence": "high",
    "dedupe_key": "agent.ts:offerRoundLimitReset-stale-wrapup-doc",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-003",
    "global_id": "T16#F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/harness/tool/builtin/spawn-subagent-tool.ts",
    "line": 70,
    "symbol": "SubagentCompletionStatus",
    "problem": "The type documents \"BudgetExhausted\" as the child's own maxRounds budget running out (finishReason \"budget\"), but the mapping at spawn-subagent-tool.ts:1186-1190 also assigns it for finishReason \"tool-call-budget\". The collapse is deliberate per the T19 verification, but undocumented.",
    "impact": "A reader of the parent-facing advisory status contract attributes a tool-call-cap stop to the round budget. Runtime behaviour is correct and the MAE reservation line still reports both configured caps, so the defect is in the type contract's documentation rather than in execution.",
    "suggested_fix": "Extend the bullet to name both reasons, e.g. the child's own round budget (finishReason \"budget\") or its tool-call budget (finishReason \"tool-call-budget\") ran out, and point at the MAE reservation line for which caps were configured.",
    "evidence": "Probe case D1 in .metaproject/flows/232-2026-09-06-agent-first-core-phase-0/artifacts/T16-final-child-budget-probe.ts: max_rounds 5 with max_tool_calls 2 stops at 2 provider requests with status BudgetExhausted and reservation \"rounds≤5 calls≤2\", i.e. the round budget was unspent. Raw .metaproject/data/gdctx/raw/2026-09-06T13-23-01-968Z_run.log, SHA-256 1a6566cf321b6ac859d69b7c585fd1398fdc4f4d43b3e921375bd29517880bc1.",
    "confidence": "high",
    "dedupe_key": "spawn-subagent-tool.ts:BudgetExhausted-doc-omits-tool-call-budget",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  },
  {
    "id": "F-004",
    "global_id": "T16#F-004",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/commands/agent.ts",
    "line": 1695,
    "symbol": "runAgentTurnCore",
    "problem": "The trailing round-ceiling guard at agent.ts:1695-1699 is identical in condition and effect to the loop-entry guard at agent.ts:1257-1262 and is the last statement of the for(;;) body, so falling off the end reaches the entry guard on the next iteration with the same picker offer, message and finishReason.",
    "impact": "Two hand-synchronised copies of the strict-ceiling rule. Given that the M10 defect history is exactly \"the ceiling check was in the wrong place\", an edit that changes one copy and not the other is the concrete maintenance cost.",
    "suggested_fix": "Delete the trailing block, or keep it and add a one-line comment marking it a fast path for the entry guard so the two are not edited independently.",
    "evidence": "Both guards read in full from bounded excerpts of src/commands/agent.ts (:1256-1262 and :1695-1699); the trailing block is the final statement of the loop body. Every executed observation of the ceiling (probes C1-C11, raw .metaproject/data/gdctx/raw/2026-09-06T13-26-54-764Z_run.log, and the committed budget regressions, raw .metaproject/data/gdctx/raw/2026-09-06T13-23-24-585Z_run.log) is explained by the entry guard alone.",
    "confidence": "medium",
    "dedupe_key": "agent.ts:duplicate-round-ceiling-guard",
    "blocking_merge": false,
    "related_skill": "review-logic",
    "learning_candidate": false
  }
]
```
