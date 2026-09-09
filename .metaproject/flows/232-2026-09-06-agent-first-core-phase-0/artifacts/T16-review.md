# T16 Independent M10 Logic Review

## Verdict

**Stage 1: FAIL — one blocker/spec gap.** The direct `AgentDeps.maxToolCalls` path is a real invocation counter and its history/terminal behavior is truthful, but the production `spawn_subagent.max_tool_calls` path still converts the configured call limit into `maxRounds`. A child configured with `max_tool_calls: 1` can execute two tools and report `Completed`.

Per the T16 dispatch constraint, Stage 2 acceptance was stopped after the Stage 1 spec gap. No global quality verdict is made; T9 remains independently `INCOMPLETE` because required ESLint is unavailable.

## Review scope

- Branch: `codex/agent-first-core`
- Parent/base: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Scope: the M10 budget/terminal/spawn and benchmark/stress/typecheck files named in dispatch `232-T16`
- Excluded: M01 routing work, concurrent health/MCP HTTP changes, broad tests, external providers/models, network calls
- Source snapshot hashes relevant to the blocker:
  - `src/commands/agent.ts`: `2d363c16a3ccb7fbf78d068ea366f64963f00e8f665456ddaf1fb2839e2e6f1f`
  - `src/harness/tool/builtin/spawn-subagent-tool.ts`: `67fb794d825e6ff67d5e3ff8eaf978de84689bda02525f9799a7c68664f1612e`

## Stage 1 — specification compliance

| Criterion | Verdict | Evidence |
|---|---|---|
| AC3: actual configured round/call limits are independent and stop with truthful reasons | **NOT MET** | Direct `AgentDeps.maxToolCalls` behavior passed an offline finite-cap probe. The production child path fails: `spawn_subagent.max_tool_calls` is read as `maxRounds` and omitted from `childDeps.maxToolCalls`; the offline child probe configured `1`, executed two tools, requested two provider rounds, and returned `Completed`. |
| AC4: offline stress report uses the existing resolver; containment port has no fallback | **MET in M10 scope** | The focused tests for offline stress serialization and present/missing containment ports passed in both the initial T16 run and the later captured run. Source inspection confirms `resolveAgentMaxRounds()` and strict port validation. |
| AC5: strict scripts target and package wiring | **MET in the stable M10 snapshot; current rerun externally contaminated** | `tsconfig.scripts.json` includes both benchmark and stress trees, `package.json` wires `typecheck:scripts` into `check`, and the injected-error test observes `TS2322`. T8's immutable stable evidence is 11/11. T16's initial run also returned 11/11; after the source freeze was released, the captured rerun returned 10/11 solely because concurrent out-of-scope `src/harness/tool/metaproject-adapter.ts` work no longer typechecked through the scripts import graph. This is not attributed to M10 and is not a current global PASS. |
| No blocker/major/minor M10 defect | **NOT MET** | F-001 is a blocker because it is an explicit AC3 gap with an executable reproduction. |

## Finding

### [F-001] `spawn_subagent.max_tool_calls` still limits rounds and permits excess child tool invocations

- **Severity:** blocker
- **File:** `src/harness/tool/builtin/spawn-subagent-tool.ts:470`
- **Symbol:** `createSpawnSubagentTool`
- **Problem:** The tool schema advertises `max_tool_calls` at lines 378/390, but lines 470–476 deliberately parse it into `maxRounds`; the sole child `AgentDeps` construction at lines 810–827 passes only `maxRounds`. The new `finishReason === "tool-call-budget"` mapping at lines 1175–1181 is therefore unreachable for the configured native-child path.
- **Impact:** The model/caller can request `max_tool_calls: 1`, the child can execute multiple actual tool invocations in the first provider round, and the result can be reported as `Completed`. This is the exact configuration shape AC3 says must not be represented by `maxRounds`.
- **Reproduction:** `bun .metaproject/flows/232-2026-09-06-agent-first-core-phase-0/artifacts/T16-child-budget-probe.ts`. It uses only an in-memory provider and built-in read tools. Observed: `configuredMaxToolCalls=1`, `actualToolResultsBeforeCompletion=2`, `providerRequests=2`, `resultStatus="Completed"`, and `MAE reservation: rounds≤1`.
- **Fix:** Parse and validate `max_tool_calls` as an independent `maxToolCalls` value and pass it to `childDeps.maxToolCalls`. Keep `maxRounds` independently configured/defaulted; if model control of rounds is needed, expose a separate `max_rounds` field. Update the child prompt/output and replace the tests that currently assert `max_tool_calls` means rounds. Add the preserved probe as a regression test and assert both the child status and actual tool-result count.
- **Class scope:** All production occurrences were enumerated with `bun src/cli.ts ctx rg 'max_tool_calls|maxToolCalls' src scripts --glob '!*.test.ts'`. For this model-facing child budget class, the complete pipeline is the schema/description (`spawn-subagent-tool.ts:378,390`), sole parser (`:470-476`), sole child dependency construction (`:810-827`), terminal mapper (`:1175-1181`), and current stress consumers (`scripts/stress/keryx-shell-stress.ts:628,745`). Direct benchmark `AgentDeps.maxToolCalls` producers are already effective and are outside the broken child pipeline.

## Independent evidence

### Reproduced blocker

- Probe source: `T16-child-budget-probe.ts`
- Probe source SHA-256: `72eb6d0266360752206f9f893077dee0a53bb7cdf355c969c6f5b8488c220215`
- Captured command: `bun src/cli.ts ctx run bun /tmp/keryx-t16-child-budget-probe.ts`
- Raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-45-05-615Z_run.log`
- Raw log SHA-256: `81311075d69f252824ab2b921877614f39d8c48146a92faeeee64cbf4a775b4f`

```json
{
  "configuredMaxToolCalls": 1,
  "providerRequests": 2,
  "actualToolResultsBeforeCompletion": 2,
  "toolResultIds": ["cwd", "list"],
  "resultStatus": "Completed",
  "resultIsError": false,
  "reservationLine": "MAE reservation: rounds≤1 runtime≤300000ms children=1"
}
```

### Direct core behavior that does pass

An independent offline batch of three delegate-shaped calls with `AgentDeps.maxToolCalls: 2` invoked exactly two tools sequentially (`peakActive=1`), emitted three contiguous tool history messages including an accurate `2/2` rejection for the third call, made one provider request, returned `finishReason: "tool-call-budget"`, and emitted/rendered exactly one `tool_call_budget_exhausted` terminal state.

- Raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-45-11-085Z_run.log`
- SHA-256: `5137779e273c6ede874f83e21e0be0cf50fe63ff2f81e62a9cf6f59f056b3560`

This proves the defect is wiring at the child configuration boundary, not the core invocation counter.

### Focused tests and concurrent snapshot drift

- Initial T16 focused run before the concurrent health edits: **11 pass, 0 fail, 51 assertions**.
- Later gdctx-captured run: **10 pass, 1 fail, 51 assertions**. The only failure is the scripts typecheck test observing an out-of-scope current error at `src/harness/tool/metaproject-adapter.ts:495`; the six budget tests, two containment tests, offline stress test, and injected-error test all passed.
- Later raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-44-57-453Z_run.log`
- Later raw log SHA-256: `654882420abbc2129268251b6099b4d19b878b55735889d18a89c3d1faad7734`
- Stable T8 M10 log: `.metaproject/data/gdctx/raw/2026-09-06T11-11-52-566Z_run.log`, SHA-256 `5556c5182fe6a682fe035ce390219b8a3afbcd48d4ddebd53801ef99eaaf228a` (**11 pass, 0 fail**).

## Unsupported claims separated from measured behavior

- T8's statement that child status maps the call-cap stop to `BudgetExhausted` describes a syntactic mapper but not reachable configured behavior. F-001's probe shows the child never receives the call cap.
- T8's broad statement that `keryx-shell-stress.ts` "runs import-safely" is stronger than measured behavior: the guarded `main()` does not execute on import, but module initialization still calls `mkdtempSync` at line 247 and creates a `keryx-stress-*` directory. This is informational and was not promoted to a Stage 2 finding because the dispatch stops quality acceptance after a Stage 1 gap; AC4's executable offline report behavior passed.

## Routing audit

- `graph_used: yes` — used for M10 navigation; it reported 22 uncommitted code files and was treated as stale, so current source reads were authoritative.
- `wiki_used: yes` — read the wiki index and `components/src-commands.md` for context; known stale prose was not treated as evidence.
- `ctx_used: yes` — all code searches and persisted command evidence used `keryx ctx`; direct small line reads were bounded.
- `raw_rg_used: no`.
