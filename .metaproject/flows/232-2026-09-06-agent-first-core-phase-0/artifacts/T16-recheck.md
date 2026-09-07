# T16 Independent M10 Recheck

## Verdict

**Stage 1: FAIL — one blocker/spec gap remains.** The root correction closes the original `max_tool_calls` wiring defect: a native child configured for one actual tool invocation now executes one tool, stops after one provider request, returns `BudgetExhausted`, and reports `calls≤1` independently from `rounds≤10`.

The newly exposed `max_rounds` limit is not enforced as the public contract describes. With `max_rounds: 1`, an offline child completed two tool-bearing model rounds and then made a third, tool-free wrap-up provider request. Its prompt and reservation still promised “up to 1 model turns” and `rounds≤1`. Per dispatch, Stage 2 acceptance stopped after this Stage 1 gap. This report preserves the initial T16 failure separately and makes no global quality claim.

## Review scope

- Branch: `codex/agent-first-core`
- Parent/base: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Scope: M10 child budget correction and the AC4/AC5 benchmark, stress, and scripts checks named by `232-T16-recheck`
- Excluded: M01 routing, T18 lint work, concurrent health/MCP HTTP work, broad tests, external providers/models, network calls
- Relevant source snapshot hashes:
  - `src/commands/agent.ts`: `4373fcf772749206695d0f0b90a37af3131a38264bb2624d64df0ab681a844bf`
  - `src/harness/tool/builtin/spawn-subagent-tool.ts`: `39fd4bb27ca2194739c6cad390069df69da941085af59a0e3fd193a388499a50`

## Stage 1 — specification compliance

| Criterion | Verdict | Evidence |
|---|---|---|
| AC3: actual configured round/call limits are independent and stop with truthful reasons | **NOT MET** | The original call-cap defect is fixed and the focused child/core tests pass. The independent round probe configured `max_rounds: 1` but observed two actual tool invocations in two tool-bearing provider rounds plus a third provider request for wrap-up, while the child prompt/reservation promised one model turn / `rounds≤1`. |
| AC4: offline stress report uses the existing resolver; containment port has no fallback | **MET** | Independent focused rerun: 3 pass, 0 fail. The stress fixture wrote JSON with the configured resolver value; containment accepted the bound listener port and rejected an absent port. |
| AC5: strict scripts target and compatibility | **MET in M10 scope** | Direct `bun run typecheck:scripts` exited 0. A sequential rerun of `scripts/typecheck.test.ts` passed both current-clean and injected-TS2322 cases (2 pass, 0 fail). |
| No blocker/major/minor M10 logic defect | **NOT MET** | F-002 is a blocker because an advertised, model-facing budget permits more provider/tool rounds than configured and reports a contradictory reservation. |

## Finding

### [F-002] `max_rounds` permits an extra tool round and wrap-up request beyond its advertised hard limit

- **Severity:** blocker
- **Files:** `src/harness/tool/builtin/spawn-subagent-tool.ts:376`, `src/commands/agent.ts:1642`
- **Symbol:** `createSpawnSubagentTool` / `runAgentTurnCore`
- **Problem:** The tool description says `max_rounds` “limits model rounds,” the child instruction says “up to N model turns,” and the result reserves `rounds≤N`. The core loop increments the round, runs the provider and all tool calls, and checks only afterward whether `roundState.round > roundState.maxRounds`. Existing core tests explicitly encode this N+1 behavior. A non-unattended native child also performs a tool-free wrap-up provider request after detecting the excess round.
- **Impact:** A caller using the new explicit `max_rounds` field cannot bound provider turns or tool-bearing rounds to the stated value. For `max_rounds: 1`, the observed execution made three provider requests and two actual tool invocations, even though the result claimed `rounds≤1`. This violates AC3's requirement for an actual configured round budget and truthful terminal evidence.
- **Reproduction:** `bun .metaproject/flows/232-2026-09-06-agent-first-core-phase-0/artifacts/T16-recheck-round-budget-probe.ts`. It uses an in-memory provider and the built-in `get_cwd` read tool only.
- **Suggested fix:** Enforce the public child round limit before issuing any provider request beyond it, including the wrap-up request, and add a child-path regression that asserts total provider requests and actual tool invocations for `max_rounds: 1`. If the old direct-agent N+1 threshold must remain compatible, adapt the child boundary explicitly rather than describing that threshold as a hard model-turn limit.
- **Class scope:** The complete child limit path was inspected: model-facing description/schema (`spawn-subagent-tool.ts:370-391`), validation/mapping (`:471-482`), child prompt/deps (`:822-835`), and core stop condition/wrap-up (`agent.ts:1642-1672`). Current child tests assert default/capped reservation text and call-budget behavior but do not exercise actual `max_rounds` enforcement. Existing direct-agent tests at `agent.test.ts:850-1025` intentionally expect a round beyond the limit to execute.

## Independent evidence

### Original blocker closure

- Preserved original probe now observes `providerRequests=1`, `resultStatus="BudgetExhausted"`, `resultIsError=true`, and `MAE reservation: rounds≤10 calls≤1`.
- Focused core/child/external budget tests: **36 pass, 0 fail, 159 assertions**.
- Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-10-44-380Z_run.log`
- Raw SHA-256: `528af00bdc1ab826f76729a9581a8bd84b9ddabbc17c8025bcfb2acc63fd6ab3`

### Remaining round-limit blocker

- Probe source: `T16-recheck-round-budget-probe.ts`
- Probe SHA-256: `9be925af4701a9fe3a3ee44185808c753966d5019a80dfaa175a1c7c112ef009`
- Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-14-33-271Z_run.log`
- Raw SHA-256: `d0bdeb15909e63b03d66ad24e005ba4f308cacb7337e86c6dcd18cea95378620`

```json
{
  "configuredMaxRounds": 1,
  "providerRequests": 3,
  "actualToolInvocations": 2,
  "toolNames": ["get_cwd", "get_cwd"],
  "resultStatus": "BudgetExhausted",
  "resultIsError": true,
  "reservationLine": "MAE reservation: rounds≤1 runtime≤300000ms children=1"
}
```

The captured third request contains two prior tool results and the system wrap-up prompt `round limit 2/1`; this distinguishes the two excess tool-bearing rounds from the additional tool-free summary request.

### AC4 and AC5

- AC4 focused tests: **3 pass, 0 fail, 10 assertions**. Raw `.metaproject/data/gdctx/raw/2026-09-06T12-16-00-788Z_run.log`, SHA-256 `4e7ecbe03efd12f32c98ebc2be50d94d98cd235a1d489b674025459eb7910993`.
- Scripts test: **2 pass, 0 fail, 8 assertions**. Raw `.metaproject/data/gdctx/raw/2026-09-06T12-12-29-619Z_run.log`, SHA-256 `6601480367d55f37dfe383f8761d9b2b07739e64935738628f4d85f27a09e9b5`.
- Direct scripts typecheck: exit 0. Raw `.metaproject/data/gdctx/raw/2026-09-06T12-10-53-078Z_run.log`, SHA-256 `b93b65b9afcd13e93f4fda2aa54ee204580a21cf8cbb6889bd90fab11fb0bbd6`.
- An earlier parallel invocation ran the scripts test while the direct scripts typecheck was active; both 5-second subprocess assertions timed out. The sequential rerun above passed and is the applicable evidence. No product defect is assigned to that self-induced contention.

## Schema and legacy compatibility tradeoff

The model-facing `spawn_subagent` schema now makes `max_rounds` an explicit integer with minimum 1, and the description, injected prompt, task text, and reservation all present it as the maximum number of model rounds. The underlying direct-agent `AgentDeps.maxRounds` contract predates that schema and deliberately treats N as a threshold: round N+1 executes before exhaustion is detected, then an interactive child may ask for one final wrap-up model response. Reinterpreting `AgentDeps.maxRounds` globally as a strict count would change established direct-shell behavior and invalidate tests that intentionally preserve the extra round/reset flow. A compatible repair can keep that legacy internal contract while adding a strict child-facing bound or explicit adapter; it must also ensure any wrap-up provider request fits within the advertised child limit. Renaming or documenting `max_rounds` as an excess-round threshold would preserve implementation behavior, but would not satisfy AC3's requirement that the configured round budget actually stop execution.

## Routing audit

- `graph_used: yes` — prior M10 navigation used the graph; it reported uncommitted code and was treated as stale, so current bounded source reads were authoritative.
- `wiki_used: no (not-relevant)` — the frozen AC, dispatch, fix report, tests, and source fully define this bounded recheck.
- `ctx_used: yes` — all searches, probes, tests, and type checks used `keryx ctx`; direct reads were small bounded excerpts.
- `raw_rg_used: no`.
