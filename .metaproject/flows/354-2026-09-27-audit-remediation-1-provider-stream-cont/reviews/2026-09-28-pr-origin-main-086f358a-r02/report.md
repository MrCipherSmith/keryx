# Review round 2 (fix round) — flow 354, PR #774

**No blockers, merge-ready.** Reviewed `origin/main..086f358ac18a47e7ef11ad85b4f85c93ac418a4e` (round 2) against round 1's head `b87a94d0718932f587e8e7e261338d5a7bc8d7de`. All 4 actionable round-1 findings are fixed and test-covered; the 1 deferred finding remains open and unchanged, exactly as the operator decided. review-logic, review-regression and review-testing-practices re-reviewed the fix commit itself (086f358a) and raised nothing new.

## Prior findings — disposition this round

| Global id | Round 1 severity | Round 2 verdict | Disposition |
|---|---|---|---|
| `#review-regression-F-001` | major | refuted (execution) | acted-on |
| `#review-architecture-F-001` | minor | refuted (execution) | acted-on |
| `#review-architecture-F-002` | info | refuted (execution) | acted-on |
| `#review-testing-practices-F-001` | minor | refuted (execution) | acted-on |
| `#review-logic-F-001` | info | confirmed (execution) | dismissed-deprioritised (operator decision, findings.md L-16) |

Round 1's package (`2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133`) was closed separately via `keryx review complete` with these five dispositions before this round's ingest ran.

### review-regression-F-001 (MAJOR) — refuted, fixed
`RunAgentTurnResult.caughtToolErrors` (agent.ts) is now filled by the sequential loop's catch and by both `runConcurrentSpawnBatch` defensive floors, and folded into `crashed` by `trigger-dispatch.ts:869-873` and `trigger-agent-task.ts:582-587`. Verified by reading both fold sites in full (not just the diff hunk) — `crashed` is assigned before `normal`/`why`/`closing` are computed downstream, so the fold is load-bearing, not decorative. Four tests exercise it end-to-end through the real dispatch wiring (`extraTools` seam), all passing at 086f358a: `agent.test.ts` "AC4 (flow 354, L-12): a throwing tool.invoke in the SEQUENTIAL loop degrades..." and "review r1 (item 1): a throwing spawn_subagent call in the CONCURRENT batch's own defensive floor also lands in caughtToolErrors"; `trigger-dispatch.test.ts` and `trigger-agent-task.test.ts` "review r1 (item 1, MAJOR regression): a tool that throws is recorded as a crashed/failed run, not a silent completion".

### review-architecture-F-001 — refuted, fixed
`estimateTaskCostUsd` now takes `providerId` and applies `OPENAI_CACHED_INPUT_DISCOUNT` only for `"openai"`/`"openai-codex"`; every other provider is billed at the full input rate. `tui-shell.test.ts` "recordTurnTaskCostBestEffort: a non-OpenAI provider's cacheReadTokens are billed at the full input rate, not discounted" passes.

### review-architecture-F-002 — refuted, fixed
Compat `mergeUsage` now takes `cacheReadTokens` and reads `usage.prompt_tokens_details.cached_tokens`, confirmed against x.ai's documented response shape. `openai-compat-provider.test.ts` "review r1 (item 4): usage.prompt_tokens_details.cached_tokens populates the normalized usage's cacheReadTokens" passes, and a companion test proves absence stays `undefined`, never `0`.

### review-testing-practices-F-001 — refuted, fixed
The AC7 runtime test in `shell-agent-repl.test.ts` now wraps the real `BusClient.leave()` to record whether the lease is still held at the instant it fires, and asserts it is — proving `leaveBus()` runs strictly before `releaseLease()`, the exact ordering the deleted source-text audit checked. `findings.md`'s R-I3 row and the test's own name were updated to say the runtime test is now a strict superset, not merely equivalent.

### review-logic-F-001 — confirmed, deferred (operator decision)
The compat adapter's in-band-`{error}`-with-no-pending-tool-call gap is untouched by 086f358a (the commit only changes `mergeUsage`/`cacheReadTokens` in this file). `stream-contract.test.ts` still pins it at 12/12 pass. `docs/requirements/keryx-audit-remediation/findings.md` now records it as ledger row **L-16**, "open (review r1, item 5): deferred, not fixed in this flow." Dismissed on round 1's package as `dismissed-deprioritised`, evidence `docs/requirements/keryx-audit-remediation/findings.md L-16, decided-by: altsay (operator, helyx 2026-09-28)`.

## Delta review (086f358a itself)

review-logic, review-regression and review-testing-practices reviewed the fix commit's own diff (13 files, 371 insertions / 17 deletions). Focus areas per dispatch:

- **The `extraTools` test-only seam** (`DispatchDeps.extraTools`, `AgentTaskDeps.extraTools`): confirmed unreachable by any real caller. `keryx ctx rg "extraTools" src` (worktree) returns exactly 4 hits — the two interface declarations and their two use sites, both gated by `...(deps.extraTools ?? [])`. Both production call sites of `runTriggerOnce`/`runTrigger` (`trigger.ts:155`, `schedule.ts:186`) pass `overrides: {}`, and `TriggerRunOverrides` is documented "Production passes none; tests drive a real dispatch". No CLI flag, schedule config, or hook wiring can reach either field.
- **`caughtToolErrors` cannot be set on a turn with no tool exception**: read all three push sites in full function context (not diff hunks). The sequential loop's push is inside the `catch` around `executeCall` only. `runConcurrentSpawnBatch`'s two floors push only when the sequential-fallback loop's own `catch` fires, or when a wave-error's `partialResults` genuinely has no entry for a call — both are pre-existing degrade-not-crash floors, not new failure paths. `runAgentTurn` only attaches the field to its result when `caughtToolErrors.length > 0`, so an ordinary successful turn's result carries no such key.
- **Blast radius / regression check**: `keryx review blast-radius --ref "origin/main..086f358a"` — 26 changed files, 40 files under regression check at depth ≤2, 4 unresolved (absent from graph). Manually enumerated every non-test production caller of `runAgentTurn` at 086f358a (`keryx ctx rg "runAgentTurn\(" src -g '!*.test.ts'`): still 9 call sites, unchanged from round 1's own enumeration; the 7 callers besides `trigger-dispatch.ts`/`trigger-agent-task.ts` (interactive/foreground paths: `goal-command.ts`, `tui-shell.ts`, `shell.ts`, `acp/server.ts`, `wiki/deep-enrich.ts`, `spawn-subagent-tool.ts`) do not read `.caughtToolErrors` and do not use a caught rejection as an outcome classifier, so the fix's blast radius stays contained to the two files it touches.
- **Testing practices**: the four new/changed tests are in-process unit tests against synthetic providers/tools, no network, consistent with repo conventions. No new gap identified.

**No new findings.** The delta is a correct, narrowly-scoped, well-tested fix.

## How this review was run
- **Run by:** review-orchestrator (round 2, fix round), flow 354
- **Scope:** `origin/main..086f358ac18a47e7ef11ad85b4f85c93ac418a4e`, round 2, PR #774
- **Reviewers:** review-logic, review-regression, review-testing-practices (delta); review-verifier (re-verification of round-1 findings)
- **Verification:** execution; confirmed 1, refuted 4, unverifiable 0
- **Not run:** review-architecture, review-security-code, review-highload (no new architectural/security/highload-shaped surface in the delta beyond what round 1 already covered)

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "The OpenAI-compat adapter never reads an in-band `{\"error\":{...}}` SSE envelope that is NOT attached to a pending tool call. When the stream ends in that state, the generator emits neither a `provider_error` nor a `model_end` — the async iterable simply ends with no terminal event at all.",
    "impact": "Pre-existing behavior, unchanged by this round's fix commit (086f358a touches only mergeUsage/cacheReadTokens in this file, not the post-loop branch). Deliberately deferred and now ledgered at docs/requirements/keryx-audit-remediation/findings.md row L-16, not re-raised as new.",
    "suggested_fix": "No action required for this PR. Worth a follow-up flow item if compat gateways are observed sending in-band error envelopes outside a tool-call context in production.",
    "evidence": "src/harness/provider/stream-contract.test.ts ~lines 170-191 (test 'compat: CURRENT (unchanged, documented gap) ...'); openai-compat-provider.ts post-loop branch (unchanged by 086f358a); bun test src/harness/provider/stream-contract.test.ts -> 12 pass at 086f358a.",
    "confidence": "high",
    "file": "src/harness/provider/compat/openai-compat-provider.ts",
    "line": null,
    "quote": null,
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-logic-F-001"
  },
  {
    "id": "F-001",
    "reviewer": "review-architecture",
    "severity": "minor",
    "problem": "estimateTaskCostUsd applies OPENAI_CACHED_INPUT_DISCOUNT (documented OpenAI-specific) to any cacheReadTokens value with no check on which provider produced it, even though providerId is in scope one line above the call.",
    "impact": "NormalizedUsage.cacheReadTokens is a provider-agnostic field; a future adapter populating it would be silently billed at OpenAI's rate even if its real discount differs.",
    "suggested_fix": "Gate the discount on provider identity (pass providerId through to estimateTaskCostUsd), or move to a per-provider discount lookup table.",
    "evidence": "src/tui/tui-shell.ts:1334-1350 (estimateTaskCostUsd) and :1374-1408 (recordTurnTaskCostBestEffort).",
    "confidence": "high",
    "file": "src/tui/tui-shell.ts",
    "line": 1390,
    "quote": "const costUsd = estimateTaskCostUsd(profile, input.providerId, input.inputTokens, input.outputTokens, input.cacheReadTokens);",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:1390"],
      "enumeration_method": "carried forward from round 1; re-read at 086f358a"
    },
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-architecture-F-001"
  },
  {
    "id": "F-002",
    "reviewer": "review-architecture",
    "severity": "info",
    "problem": "This diff adds cacheReadTokens support only to the native OpenAI adapter's mergeUsage, not to the structurally identical OpenAI-compat adapter's mergeUsage, even though this file's own doc comment records that x.ai returns an equivalent cached_tokens field.",
    "impact": "Cost accounting for OpenAI-compatible gateways reporting cached_tokens (x.ai and potentially others) still drops the cache-discount signal.",
    "suggested_fix": "Follow-up: read the compat gateway's cached-token usage field and populate cacheReadTokens the same way L-11 did for the native adapter.",
    "evidence": "doc comment lines ~79-81 citing x.ai's cached_tokens:512; mergeUsage body.",
    "confidence": "medium",
    "file": "src/harness/provider/compat/openai-compat-provider.ts",
    "line": 232,
    "quote": "function mergeUsage(\n  promptTokens: number | undefined,\n  completionTokens: number | undefined,\n  totalTokens: number | undefined,\n): NormalizedUsage {",
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-architecture-F-002"
  },
  {
    "id": "F-001",
    "reviewer": "review-regression",
    "severity": "major",
    "problem": "The sequential tool-loop's new try/catch (AC4, flow 354 L-12) converts any exception thrown by executeCall into a per-call isError:true tool result instead of letting it reject runAgentTurn's promise as it did before.",
    "impact": "trigger-dispatch.ts's dispatchLocked and trigger-agent-task.ts's runLocked both use the caught/rethrown error from runAgentTurn as their unattended run's ONLY crash signal, gating whether the run is recorded completed/failed. A tool-execution exception can now go completely unrecorded if the turn otherwise finishes cleanly.",
    "suggested_fix": "Have runAgentTurn/RunAgentTurnResult surface that at least one executeCall exception was caught this turn, and have dispatchLocked/runLocked fold that into their own crashed/why computation instead of relying solely on the outer catch around runAgentTurn.",
    "evidence": "trigger-dispatch.ts:786,858,866-873,909,918-937; trigger-agent-task.ts:499,567; RunAgentTurnResult (agent.ts:699-725) had no exception-count field at round 1's head.",
    "confidence": "high",
    "file": "src/commands/agent.ts",
    "line": null,
    "quote": null,
    "class_scope": {
      "sites": [
        "src/commands/trigger-dispatch.ts:858",
        "src/commands/trigger-agent-task.ts:567"
      ],
      "enumeration_method": "carried forward from round 1 (rg 'runAgentTurn\\(' -g '!*.test.ts' src -> 9 non-test call sites; re-enumerated at 086f358a, unchanged: still 9 call sites, still only these two use the caught error as a correctness-affecting outcome classifier)."
    },
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-regression-F-001"
  },
  {
    "id": "F-001",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "The deleted shell-bus.test.ts source-text audit (R-I3) checked that leaveBus() runs before releaseLease() in the shared finally. Its replacement runtime test only asserts both handles end up undefined, never their order.",
    "impact": "The PR's claim that the replacement is 'strictly stronger' was inaccurate on this dimension at round 1's head. A future edit swapping the two calls' order would have passed every remaining test while silently reintroducing the original race.",
    "suggested_fix": "Add an order assertion to the runtime test, or correct the three places claiming full equivalence.",
    "evidence": "shell-agent-repl.test.ts AC7 describe block; shell.ts finally block (leaveBus(); releaseLease();).",
    "confidence": "high",
    "file": "src/commands/shell-agent-repl.test.ts",
    "line": 863,
    "quote": "expect(leaseBox.current).toBeUndefined();\n    expect(busBox.current).toBeUndefined();",
    "class_scope": {
      "sites": [
        "src/commands/shell-agent-repl.test.ts:790-865",
        "docs/requirements/keryx-audit-remediation/findings.md (R-I3 row)",
        "CHANGELOG.md (0.3.18 R-I3 entry)"
      ],
      "enumeration_method": "carried forward from round 1"
    },
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-testing-practices-F-001"
  }
]
```
