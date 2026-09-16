---
review_run_id: pr-558-2026-09-15T15-22-00Z-r03
orchestrator: review-orchestrator
verdict: APPROVE
context_mode: light
model_strategy: adaptive
current_model: deepseek-flash
model_assignment: tier=standard provider=deepseek model=deepseek-flash (tier_resolution=session-fallback)
agents:
  - review-logic
  - review-architecture
  - review-testing-practices
scope:
  pr: 558
  base: b618e46632b336d3edefb99a3a7d43956e3d3900
  head: f82e966b9c3d8cb9b955758fbf33bf2b4c2660bb
  files_changed: 25
generated_at: 2026-09-15T15:22:00Z
---

# AI Review Report — fix round 2

## Executive Summary

All three `major` findings of round 1 are closed in `f82e966b`; no regression was
introduced by the fix. One `info` remains open (roster-level, not a defect).
Merge risk: none identified in this round's scope.

## Review Context

Scope A: `merge-base...HEAD` over the fix as well as the feature — 25 files, 1619
changed lines, 0 dropped by the pre-filter. Scope B recomputed because the
changed-file set moved. Verification mode `annotate`.

## Prior findings — dispositions

| Finding | Disposition | Evidence |
|---|---|---|
| F-558-02 | `acted-on` | `MIN_ASK_USER_OPTIONS` shared by `chooseSelfAnswer` and both `invoke()` guards; a test asserts the refusal against the real tool. |
| F-558-03 | `acted-on` | `readBounded` races the read against a timer; the ceiling is passed only when `process.stdin.isTTY !== true`; expiry returns `ASK_USER_UNANSWERABLE`. Four tests pin expiry, fast path, unbounded default, and `0` = no ceiling. |
| F-558-01 | `acted-on` | The interception enumerates the skipped guarantees; the invocation-budget exemption is documented with its reason rather than charged. |
| F-558-04 | `dismissed-incorrect` | Wave C refutation: the subject is prose outside the repository. |
| F-558-05 | `dismissed-incorrect` | Wave C refutation: a duplicate of F-558-02 with no independent claim. |

## Findings

### F-558-06: `ask_user` is still offered on surfaces that cannot answer it

- Severity: info
- Reviewer: review-architecture
- File: `src/commands/interactive-agent-tools.ts`
- Lines: 191
- Confidence: high
- Status: open

Problem:
The tool stays in the session roster even where no host can display a question.
The fail-closed sentinel now reports that honestly, but the roster still invites
the call.

Why it matters:
One wasted round-trip per attempt. A cost, not a defect — hence `info`.

Suggested fix:
Drop `ask_user` from the roster when no host is registered, through the existing
`--deny-tools` mechanic rather than a new switch.

## Fix Order

1. F-558-06 — optional; no merge dependency.

## Validation Plan

- `bunx tsc --noEmit`
- `bunx eslint` on the touched files
- `bun test` over the eleven suites covering this surface (393 tests)

## Notes For Follow-Up Agents

`ask_user` must stay `risk: "read"`: merging the question axis into
`resolveApprovalDecision` would let `auto` self-approve destructive actions as a
side effect. `resolveQuestionAnswerer` is the axis to extend, and the
`unattended` check must keep winning over it.
