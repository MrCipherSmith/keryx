# T8 Change Report

## Outcome

Phase 0 AC3–AC5 are implemented and the bounded offline acceptance suite is green. `maxToolCalls` is now an independent, validated per-turn ceiling counted at the real `tool.invoke` boundary. Benchmark and stress scripts have a strict TypeScript target, the stress report uses `resolveAgentMaxRounds`, and containment refuses a missing or invalid bound listener port.

No external provider/model was called. No private dataset was read or copied. No commit, branch, index, flow state, frozen acceptance criteria, dependency, or lockfile change was made.

## Behavior implemented

- `AgentDeps.maxToolCalls?: number` accepts non-negative safe integers and remains independent from `maxRounds`.
- Direct invalid `maxToolCalls`/`maxRounds` values throw `RangeError` before history mutation, provider requests, approvals, or tool invocation.
- Unknown tools, invalid inputs, untrusted-content blocks, and denied approvals do not consume the call budget.
- A successful invocation increments the budget immediately before `tool.invoke`; reaching the cap stops the turn without another provider request and returns `finishReason: "tool-call-budget"`.
- Existing `"budget"` and `"no-progress"` finish reasons remain unchanged when the new cap is absent or unreached.
- Finite-cap batches remain ordered/sequential so concurrent `spawn_subagent` predispatch cannot oversubscribe the cap. Existing concurrent behavior remains unchanged when no finite cap is supplied.
- Unattended cap stops emit `TerminalState.reason: "tool_call_budget_exhausted"`; child-agent status maps this stop to `BudgetExhausted`.
- The stress script writes `maxRounds`, runs import-safely, and can produce an empty offline report through an unmatched `--only` selector.
- `resolveContainmentPort` preserves a concrete bound port and throws for absent/out-of-range ports.
- `tsconfig.scripts.json` covers benchmark and stress scripts under the root strict settings. `package.json` exposes `typecheck:scripts` and includes it in `check`.
- Five benchmark process helpers omit `cwd` when absent, satisfying `exactOptionalPropertyTypes`; both stress entrypoints avoid unsafe top-level execution.

## Test case specs

Acceptance command:

```text
bun test src/commands/agent-tool-call-budget.test.ts scripts/stress/keryx-shell-stress.test.ts scripts/benchmark/run-containment.test.ts scripts/typecheck.test.ts
```

Result: 11 pass, 0 fail, 51 assertions. This includes the original seven T6 RED cases and four implementation-edge cases covering invalid limits, unknown/approval-denied calls, accumulation across provider rounds, and preservation of the existing round-budget reason when the independent cap is unreached.

Additional verification:

| Check | Result | Immutable raw log | SHA-256 |
|---|---:|---|---|
| Focused AC3–AC5 suite | 11 pass, 0 fail | `.metaproject/data/gdctx/raw/2026-09-06T11-11-52-566Z_run.log` | `5556c5182fe6a682fe035ce390219b8a3afbcd48d4ddebd53801ef99eaaf228a` |
| Scripts TypeScript | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T11-11-49-748Z_run.log` | `b93b65b9afcd13e93f4fda2aa54ee204580a21cf8cbb6889bd90fab11fb0bbd6` |
| Agent/spawn/terminal regressions | 110 pass, 0 fail | `.metaproject/data/gdctx/raw/2026-09-06T11-11-48-973Z_run.log` | `4897ba9ec58b8ee966d77595323ceffb7a3fba508dfe28e74204e148754f5e5e` |
| Root TypeScript | exit 0 | `.metaproject/data/gdctx/raw/2026-09-06T11-11-35-012Z_run.log` | `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92` |
| Changed-file health | PASS, 0 findings | `.metaproject/data/gdctx/raw/2026-09-06T11-12-35-299Z_run.log` | `237c8c787fed6e06c3c38804c7084c229ba44c9e2ddc1340c50af6e67950180c` |
| Changed-related strict test selection | 604 pass, 0 fail | `.metaproject/data/gdctx/raw/2026-09-06T11-13-11-373Z_run.log` | `b8cd22b287a449c7042505eea17a0f064c53b25d14703d77525401c604e25121` |
| Diff whitespace check | exit 0 | command output empty | n/a |

The full `bun run check` executed 6,846 tests: 6,826 passed, 18 skipped, and 2 failed in files owned by other Phase 0 workers. The independently reproduced failures are:

- `src/mcp/boundary.test.ts`: new `src/mcp/transport/loopback-host.ts` imports `../../lib/serve-config`.
- `src/gdskills/install.test.ts`: the task-implementer input contract source differs from its installed copy.

Full-suite raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-10-24-022Z_run.log`, SHA-256 `1a673d7ba4adf26d7bd4068f503234df81e232be249d17e42e3ee77450117558`. Focused reproduction raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-12-04-845Z_run.log`, SHA-256 `4445d66ebcd9259dba0033af6757eabd850d743c7ac62bf79477097413e6ff12`. Neither failure intersects T8-owned files or behavior.

## Key file hashes

| File | SHA-256 |
|---|---|
| `src/commands/agent.ts` | `2d363c16a3ccb7fbf78d068ea366f64963f00e8f665456ddaf1fb2839e2e6f1f` |
| `src/commands/agent-tool-call-budget.test.ts` | `c25040491fb4726a5d5d1e17a5f95150e0f86043a16809bbe929db5f163c6553` |
| `src/session/slate-terminal-state.ts` | `bd8943542523227433c70c59336bd977056a5923c2033780c26efdac6d48571c` |
| `src/harness/tool/builtin/spawn-subagent-tool.ts` | `67fb794d825e6ff67d5e3ff8eaf978de84689bda02525f9799a7c68664f1612e` |
| `scripts/benchmark/run-containment.ts` | `7b4163772db1f6d6e0ceb8e38d888c7fb0c9fe082b6fd0dd552476c6bdeeac45` |
| `scripts/stress/keryx-shell-stress.ts` | `60e5532a5b7679272922261e187a7b23327be05296a911835a8a1c99b9ef8df7` |
| `scripts/typecheck.test.ts` | `3d1cf8d3648b4e2c0a2f5c5cccc4cb5dfc0aa190c9a30396be4ede3ff5965b03` |
| `tsconfig.scripts.json` | `84f65c69a4dc0b610e2012508a64a98658fc5a263a994643510b6b52ab0436bb` |
| `package.json` | `a9cfc7e533a4d8751a7772a60526a46747dd4fdd456bc5934e45effef1bfbbb1` |

## Routing audit

- `graph_used: yes` — source graph located the agent budget surfaces; its context reported uncommitted code files, so direct source reads were authoritative and the graph was treated as predating those changes.
- `wiki_used: yes` — Phase 0 wiki/context routing was consulted before deep implementation reads.
- `ctx_used: yes` — all searches, test runs, typechecks, health checks, and large outputs used `keryx ctx`/gdctx.
- `raw_rg_used: no`.

## Correction: health gate interpretation

The recorded `keryx health run --changed --source eslint,typescript` output remains valid evidence of what the command returned, but its `PASS` label did not enforce the required ESLint source: the normalized health artifact records `eslint | skipped | required: yes`. Therefore T8 does **not** claim a complete quality PASS. TypeScript and the bounded tests passed; ESLint was unavailable/skipped and remains an unresolved quality-gate concern for parent integration.
