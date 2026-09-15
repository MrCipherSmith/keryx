---
review_run_id: pr-558-2026-09-15T15-30-00Z
orchestrator: review-orchestrator
verdict: APPROVE_WITH_SUGGESTIONS
context_mode: light
model_strategy: adaptive
current_model: deepseek-flash
model_assignment: tier=standard provider=deepseek model=deepseek-flash (tier_resolution=session-fallback)
agents:
  - review-logic
  - review-security-code
  - review-architecture
  - review-testing-practices
scope:
  pr: 558
  base: b618e46632b336d3edefb99a3a7d43956e3d3900
  head: 3810d8095e9a58776a079c6b8a752541b8fc5bf6
  files_changed: 17
generated_at: 2026-09-15T15:30:00Z
---

# AI Review Report

## Executive Summary

No blockers. The change closes a genuine false-attribution defect and does not
widen the approval axis (`permission-mode.ts`: 35 insertions, 0 deletions). Three
`major` findings, all additive to fix; two were already disclosed in the PR body,
one (the invocation-budget bypass) is newly named here. Recommended fix order:
F-558-02 (one-line consistency) → F-558-01 (charge or document the budget) →
F-558-03 (timeout).

## Review Context

Scope A: `merge-base...HEAD`, 17 files, 1013 changed lines, 0 dropped by the
pre-filter. Scope B: blast radius computed at depth 2 — 40 files retained, 118
cut by `blast_radius_max_files=40` and recorded as NOT reviewed. Verification
mode `annotate`: verdicts recorded, nothing removed. Spec = the PR body (no
issue linked). Cross-family review was not supplied; that is not the same as
`single-family`.

## Findings

### F-558-01: A self-answered `ask_user` bypasses every `executeCall` guarantee

- Severity: major
- Reviewer: review-logic
- File: `src/commands/agent.ts`
- Lines: 1681
- Confidence: high
- Status: open

Problem:
`selfAnswered ??` short-circuits `executeCall` for the `auto`-mode question. That
function is where schema validation, the unknown-tool refusal, `requestApproval`
and the invocation budget all live.

Why it matters:
The guarantees skipped are the ones an operator assumes still hold. Precisely:
the per-signature attempt guard (`reserveToolAttempt`) and `io.onToolCall` DO
still run, because they sit above and below the call site for every call. But
`hasInvocationCapacity`/`reserveInvocation` (`agent.ts:2203`, `agent.ts:2294`)
are reached only inside `executeCall`, so `maxToolCalls` never sees a
self-answered question.

Evidence:
`selfAnswered ??` at `agent.ts:1681`; the two budget functions appear nowhere
else in the file.

Suggested fix:
State the dropped guarantees in the interception's own comment, and either charge
the invocation budget for the synthetic result or document why a question is
exempt from it.

Regression coverage:
```gherkin
Feature: auto-mode question accounting

  Scenario: a self-answered question is counted
    Given an auto-mode session with maxToolCalls set
    When the model calls ask_user
    Then the invocation budget reflects that call
```

### F-558-02: `auto` answers a one-option question that the tool itself refuses

- Severity: major
- Reviewer: review-logic
- File: `src/harness/tool/builtin/ask-user-tool.ts`
- Lines: 74
- Confidence: high
- Status: open

Problem:
`chooseSelfAnswer` accepts a single usable option while the tool's own `invoke()`
rejects anything under two options.

Why it matters:
The two paths disagree about what a valid question is, and the permissive one is
the path that speaks for the user. Measured, not reasoned.

Evidence:
Executed probe — `chooseSelfAnswer([{id:"a",label:"Only"}])` returned the option;
`createAskUserTool(...).invoke({options:[{id:"a",label:"Only"}]})` returned
`isError=true` with `ask_user requires at least 2 options`.

Suggested fix:
Apply the same minimum in the auto path so a malformed question yields
`NO answer exists` on both paths.

### F-558-03: No timeout on a question — a non-answering host blocks the turn

- Severity: major
- Reviewer: review-architecture
- File: `src/commands/ask-user-readline.ts`
- Lines: 66
- Confidence: high
- Status: open

Problem:
`promptAskUser` awaits `readLine()` with no deadline, and the TUI dock path has
none either.

Why it matters:
The codex elicitation path this repository already owns sets
`DEFAULT_ELICITATION_TIMEOUT_MS` for exactly this reason; `ask_user` has no
equivalent, so a silent host hangs the turn with no diagnostic.

Evidence:
No `timeout` occurrence in `ask-user-tool.ts`; `promptAskUser`'s only await is
unbounded.

Suggested fix:
Reuse the existing ceiling convention and return `ASK_USER_UNANSWERABLE` on
expiry, naming the cause.

## Fix Order

1. F-558-02 — smallest change, removes a user-speaking divergence.
2. F-558-01 — decide charge vs document; touches budget accounting.
3. F-558-03 — add the ceiling; independent of the other two.

## Validation Plan

- `bunx tsc --noEmit`
- `bunx eslint` on the touched files
- `bun test src/commands/agent-permission-mode.test.ts src/commands/permission-mode.test.ts src/harness/tool/builtin/ask-user-tool.test.ts src/tui/ask-user-bridge.test.ts src/commands/ask-user-readline.test.ts`

## Notes For Follow-Up Agents

`ask_user` is `risk: "read"` and must stay out of `resolveApprovalDecision` —
merging the axes would let `auto` self-approve destructive actions as a side
effect. Two further review rounds are expected: `prior_findings` should carry
F-558-01..03 and their dispositions.
