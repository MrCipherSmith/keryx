# Review Report — flow 354, PR #774 (round 1)

Repo: MrCipherSmith/keryx · Branch: fix/audit-remediation-1 · Head: b87a94d0718932f587e8e7e261338d5a7bc8d7de
Range: origin/main..b87a94d0718932f587e8e7e261338d5a7bc8d7de (21 files)
Reviewers dispatched (Wave A/B): review-logic, review-architecture, review-security-code, review-testing-practices, review-regression (scope B, blast-radius computed).
Wave C: review-verifier (verification_mode: filter).
External PR comments: collected via `keryx review comments collect` — 0 comments on this PR.

## Stage counts

- Findings reported by domain reviewers: 5 (0 blocker, 1 major, 2 minor, 2 info)
- Verified by review-verifier: 5 checked (3 by execution, 2 by site-check) — 5 confirmed, 0 refuted, 0 unverifiable
- Retained after filter (verification_mode: filter): 5

## Findings by severity

### Major (1)

**[review-regression#F-001]** `src/commands/agent.ts:3339` — The sequential tool-loop's new try/catch (AC4, flow 354 L-12) degrades any exception thrown by `executeCall` to a per-call `isError:true` tool result instead of letting it reject `runAgentTurn`'s promise. `src/commands/trigger-dispatch.ts`'s `dispatchLocked` (crashed declared :786, assigned only in the catch at :858 around `runAgentTurn`) and `src/commands/trigger-agent-task.ts`'s `runLocked` (crashed declared :499, assigned only at :567) both use that caught/rethrown error as their unattended run's ONLY crash signal, folded into `dispatchLocked`'s `normal` (gates the health gate and whether `service.taskDone({disposition:'completed'})` runs) and `runLocked`'s equivalent `why`/`outcome` classification. `RunAgentTurnResult` (agent.ts:699-725) carries no other field recording "a tool call threw this turn". Verified empirically: a throwaway probe reproducing the PR's own AC4 scenario showed the real returned result object is completely empty (`{}`) after a caught tool exception — nothing on it lets either trigger caller detect that a tool threw. A tool-execution exception during an unattended trigger-dispatch/trigger-agent-task run can now be recorded "completed"/"ok" even though a tool call inside it genuinely crashed. Verifier verdict: **confirmed** (execution — read both callers' crash-signal wiring plus an empirical probe of the real result object).

### Minor (2)

**[review-architecture#F-001]** `src/tui/tui-shell.ts:1390` — `estimateTaskCostUsd` applies the OpenAI-specific `OPENAI_CACHED_INPUT_DISCOUNT` (50%) to any `cacheReadTokens` value with no check on which provider produced it, even though `recordTurnTaskCostBestEffort` has `providerId` in scope one line above the call. `NormalizedUsage.cacheReadTokens` is provider-agnostic by its own type signature, so a future adapter (or provider whose real cache-discount rate differs from OpenAI's) that populates this field would be silently billed at the wrong rate. No live bug today — only the OpenAI adapter populates the field currently. Verifier verdict: **confirmed** (site-check — read `estimateTaskCostUsd`'s signature/body and the caller).

**[review-testing-practices#F-001]** `src/commands/shell-agent-repl.test.ts` (and `docs/requirements/keryx-audit-remediation/findings.md` R-I3 row, `CHANGELOG.md`) — The deleted `shell-bus.test.ts` source-text audit (R-I3) checked that `leaveBus()` runs before `releaseLease()` in the shared `finally`; its replacement runtime test (`shell-agent-repl.test.ts:821-865`) only asserts both handles end up `undefined`, never their order. The PR's own comment/findings.md/CHANGELOG call the replacement "strictly stronger", which is true in one dimension (real handles, real crash path) but not in this one — a future edit swapping the two calls' order (currently correct in `shell.ts:2950-2955`) would pass every remaining test while silently reintroducing the original race. Verifier verdict: **confirmed** (execution — ran the replacement test and read its assertions plus the production order).

### Info (2)

**[review-architecture#F-002]** `src/harness/provider/compat/openai-compat-provider.ts:232` — The OpenAI-compat adapter's `mergeUsage` was not updated to populate `cacheReadTokens`, even though this same file's own doc comment records that x.ai (routed through this adapter) returns an equivalent `cached_tokens` field. Pre-existing gap, not introduced by this diff (the changed hunks don't touch `mergeUsage`); the L-11 fix is incomplete relative to its own documented evidence of a sibling adapter carrying the same signal. Verifier verdict: **confirmed** (site-check — read `mergeUsage` and the doc comment).

**[review-logic#F-001]** `src/harness/provider/compat/openai-compat-provider.ts` — The compat adapter never reads an in-band `{"error":{...}}` envelope that isn't attached to a pending tool call; the stream ends with no terminal event at all in that shape. Pre-existing, unchanged by this diff, explicitly out of AC1's scope, and pinned/documented by the PR's own new `stream-contract.test.ts` as a deliberately deferred gap. Verifier verdict: **confirmed** (execution — ran `stream-contract.test.ts`, the named test exists and asserts exactly this).

## Reviewer summaries

- **review-security-code**: DONE, 0 findings. Verified the mandatory credential-leak check across the flow journal's L-10 probe entries, the new openai-provider test/comment, and the credential-boundary.test.ts header rewrite — clean in all three. Broader scan of the full diff found no injection, unsafe interpolation, untrusted-response-trust, or path-traversal/unsafe-delete issues.
- **review-logic**: DONE, 1 info finding (above). All AC1–AC8 claims traced to actual diff hunks (not just doc/test claims) and confirmed correct; ran the full touched-test-file set plus all provider adapter suites, 100% green.
- **review-architecture**: DONE_WITH_CONCERNS, 2 findings (above, F-001 minor/F-002 info). `cacheReadTokens`'s placement/typing in `NormalizedUsage` and its threading to the one real consumer were confirmed sound; no layer/dependency/module-boundary violations found elsewhere in the diff.
- **review-testing-practices**: DONE_WITH_CONCERNS, 1 minor finding (above). Confirmed `stream-contract.test.ts` genuinely runs all 3 rows against all 4 adapters (12/12 pass, no adapter silently skipped) and every AC's cited test name exists and asserts what it claims. Mutation-testing pass was not run (blocked by the round's read-only constraint plus a harness Edit-permission denial); substituted direct code-path tracing per the skill's own fallback guidance.
- **review-regression** (scope B, blast-radius computed via `keryx review blast-radius`): DONE_WITH_CONCERNS, 1 major finding (above). Checked all 5 assigned focus areas; the other 4 (`cacheReadTokens` consumers, the 4 providers' stream-contract change's only real caller, `provisionWorktrees`'s zero production callers, `tui-shell.ts` cost-estimate's zero external callers) were clean.

## Verifier

review-verifier ran against all 5 consolidated findings, verification_mode `filter`: 3 verified by execution (running the exact test file/probe cited), 2 by site-check (reading the exact cited lines/signatures). 5/5 confirmed, 0 refuted, 0 unverifiable. No finding was authored and verified by the same reviewer.

## Acceptance criteria cross-check (informational — not a Jev pass, orchestrator reading the diff directly)

AC1–AC8 in `.metaproject/flows/354-.../acceptance-criteria.md` were each independently traced to the diff by review-logic (spec-compliance gate) and cross-checked by review-testing-practices (test-claim accuracy) and review-security-code (credential-leak check on the AC2 probe). No AC was found unimplemented or misrepresented. The one process/documentation inaccuracy found (AC6's "R-I3 ... already covered" claim, not fully true per review-testing-practices#F-001) is filed as a minor finding above, not a spec-gate failure — the underlying deletion is safe today.

## Not fixed

Per this round's scope, no source file was edited. This is read-only review output for flow 354 round 1.

```json keryx:findings
[
  {
    "id": "F-001",
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-logic-F-001",
    "severity": "info",
    "file": "src/harness/provider/compat/openai-compat-provider.ts",
    "line": null,
    "quote": null,
    "problem": "The OpenAI-compat adapter never reads an in-band `{\"error\":{...}}` SSE envelope that is NOT attached to a pending tool call. When the stream ends in that state, the generator emits neither a `provider_error` nor a `model_end` — the async iterable simply ends with no terminal event at all.",
    "impact": "Pre-existing behavior, unchanged by this diff, explicitly out of AC1's scope, and pinned/documented by the new stream-contract.test.ts itself as a known, deferred gap.",
    "suggested_fix": "No action required for this PR. Worth a follow-up flow item if compat gateways are observed sending in-band error envelopes outside a tool-call context in production.",
    "evidence": "src/harness/provider/stream-contract.test.ts ~lines 170-191 (test 'compat: CURRENT (unchanged, documented gap) ...'); openai-compat-provider.ts post-loop branch ~1295-1351; bun test src/harness/provider/stream-contract.test.ts -> 12 pass.",
    "confidence": "high",
    "reviewer": "review-logic"
  },
  {
    "id": "F-001",
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-architecture-F-001",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "line": 1390,
    "quote": "const costUsd = estimateTaskCostUsd(profile, input.inputTokens, input.outputTokens, input.cacheReadTokens);",
    "problem": "estimateTaskCostUsd applies OPENAI_CACHED_INPUT_DISCOUNT (documented OpenAI-specific) to any cacheReadTokens value with no check on which provider produced it, even though providerId is in scope one line above the call.",
    "impact": "NormalizedUsage.cacheReadTokens is a provider-agnostic field; a future adapter populating it would be silently billed at OpenAI's rate even if its real discount differs. No live bug today since only OpenAI populates the field.",
    "suggested_fix": "Gate the discount on provider identity (pass providerId through to estimateTaskCostUsd), or move to a per-provider discount lookup table analogous to priceInputPerMillion/priceOutputPerMillion.",
    "evidence": "src/tui/tui-shell.ts:1334-1350 (estimateTaskCostUsd) and :1374-1408 (recordTurnTaskCostBestEffort); keryx ctx rg cacheReadTokens confirms only openai-provider.ts writes it.",
    "confidence": "high",
    "reviewer": "review-architecture"
  },
  {
    "id": "F-002",
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-architecture-F-002",
    "severity": "info",
    "file": "src/harness/provider/compat/openai-compat-provider.ts",
    "line": 232,
    "quote": "function mergeUsage(\n  promptTokens: number | undefined,\n  completionTokens: number | undefined,\n  totalTokens: number | undefined,\n): NormalizedUsage {",
    "problem": "This diff adds cacheReadTokens support only to the native OpenAI adapter's mergeUsage, not to the structurally identical OpenAI-compat adapter's mergeUsage, even though this file's own doc comment records that x.ai returns an equivalent cached_tokens field.",
    "impact": "Cost accounting for OpenAI-compatible gateways reporting cached_tokens (x.ai and potentially others) still drops the cache-discount signal. Not introduced by this diff (mergeUsage untouched by the diff hunks).",
    "suggested_fix": "Follow-up: read the compat gateway's cached-token usage field and populate cacheReadTokens the same way L-11 did for the native adapter, once the F-001 provider-discount-rate gating is resolved.",
    "evidence": "keryx ctx rg 'prompt_tokens_details|cached_tokens|mergeUsage' src/harness/provider/compat/openai-compat-provider.ts; doc comment lines 79-81 citing x.ai's cached_tokens:512; mergeUsage body (232-250) has no such handling.",
    "confidence": "medium",
    "reviewer": "review-architecture"
  },
  {
    "id": "F-001",
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-regression-F-001",
    "severity": "major",
    "file": "src/commands/agent.ts",
    "line": 3339,
    "quote": "result = { output: `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true, };",
    "problem": "The sequential tool-loop's new try/catch (AC4, flow 354 L-12) converts any exception thrown by executeCall into a per-call isError:true tool result instead of letting it reject runAgentTurn's promise as it did before.",
    "impact": "trigger-dispatch.ts's dispatchLocked and trigger-agent-task.ts's runLocked both use the caught/rethrown error from runAgentTurn as their unattended run's ONLY crash signal, gating whether the run is recorded completed/failed. A tool-execution exception can now go completely unrecorded if the turn otherwise finishes cleanly.",
    "suggested_fix": "Have runAgentTurn/RunAgentTurnResult surface that at least one executeCall exception was caught this turn, and have dispatchLocked/runLocked fold that into their own crashed/why computation instead of relying solely on the outer catch around runAgentTurn.",
    "evidence": "trigger-dispatch.ts:786,858,866-873,909,918-937; trigger-agent-task.ts:499,567; RunAgentTurnResult (agent.ts:699-725) has no exception-count field; blast-radius.json lists both files at hop 1 via agent.ts.",
    "confidence": "high",
    "reviewer": "review-regression",
    "class_scope": {
      "sites": ["src/commands/trigger-dispatch.ts:858", "src/commands/trigger-agent-task.ts:567"],
      "enumeration_method": "rg 'runAgentTurn\\(' -g '!*.test.ts' src -> 9 non-test call sites; read every call site's surrounding try/catch — trigger-dispatch.ts and trigger-agent-task.ts are the only two using the caught error as a correctness-affecting outcome classifier."
    }
  },
  {
    "id": "F-001",
    "global_id": "2026-09-28-pr-origin-main-b87a94d0718932f587e8e7e26133#review-testing-practices-F-001",
    "severity": "minor",
    "file": "src/commands/shell-agent-repl.test.ts",
    "line": null,
    "quote": "expect(leaseBox.current).toBeUndefined();\n    expect(busBox.current).toBeUndefined();",
    "problem": "The deleted shell-bus.test.ts source-text audit (R-I3) checked that leaveBus() runs before releaseLease() in the shared finally. Its replacement runtime test only asserts both handles end up undefined, never their order.",
    "impact": "The PR's claim that the replacement is 'strictly stronger' is inaccurate on this dimension. A future edit swapping the two calls' order (currently correct) would pass every remaining test while silently reintroducing the original race.",
    "suggested_fix": "Add an order assertion to the runtime test (e.g. a shared sequence counter), or correct the three places claiming full equivalence (test comment, findings.md R-I3 row, CHANGELOG.md).",
    "evidence": "shell-agent-repl.test.ts:821-865 (no order assertion); shell.ts:2950-2955 (leaveBus(); releaseLease(); order correct but unguarded); findings.md R-I3 row and CHANGELOG.md both assert 'stronger'/'already covered'.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": ["src/commands/shell-agent-repl.test.ts:790-865", "docs/requirements/keryx-audit-remediation/findings.md (R-I3 row)", "CHANGELOG.md (0.3.18 R-I3 entry)"],
      "enumeration_method": "Read full diff for shell-bus.test.ts deletion, read replacement test in full, then keryx ctx rg 'R-I3' across findings.md and CHANGELOG.md."
    }
  }
]
```
