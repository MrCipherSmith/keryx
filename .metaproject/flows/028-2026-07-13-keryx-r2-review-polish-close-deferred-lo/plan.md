# Implementation Plan — Flow 028 (R2 review polish)

Status: frozen scope (8 deferred LOW/INFO items)

## Approach

Close the 8 deferred review items, test-first, reusing existing primitives. Most are in R2-new
files (safe polish of this track's own code); H (tool-call fail-closed) and E (planning evidence
disposition) touch prior-wave modules — apply ONLY a minimal behavior-tightening change; if either
requires a real refactor, STOP and report. Deterministic/offline; deps `{}`; fail-closed preserved.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | security/logic |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | security/logic |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd /Users/Goodea/goodea/keryx`, branch `feature/keryx-r2-review-polish`).

## Steps

1. T1: scope from the review deferred list (description.md).
2. T5 (RED): tests for the fixable items (offline, injected id/clock + fakes):
   - **H**: `inheritBudget` (isolation.test.ts) — parent WITH `maxToolCalls`, child OMITTING it →
     `{ok:false}` (deny, fail-closed); parent WITHOUT `maxToolCalls`, child omitting → still ok
     (runtime-only, unchanged); child WITH a cap ≤ parent → ok (unchanged). `planWaves`
     (scheduler.test.ts) — a wave of cap-less children under a capped parent → the plan denies
     (propagated) OR each such child is rejected (per the deny rule). Re-assert existing runtime
     aggregate accounting unchanged.
   - **A**: executor `buildEvidence` — given run/session/correlation ids on the input, the evidence
     `causal.runId/sessionId/correlationId` equal those inputs (not fresh idSeq values).
   - **B**: a `makeProvider(name, model, baseUrl?, deps)` factory returns the right provider per name
     (anthropic w/ + w/o key → fallback; ollama; fake); shell + harness both route through it.
   - **C**: covered by existing tests staying green (DRY refactors) + maybe a small usage/const test.
   - **D**: provenance default-root — omit `registrationProvenance` → derived + taint-linked to root.
   - **E**: bound-wave planning evidence artifact.kind is NOT `child-result:DONE` (a neutral/PLANNED
     disposition), while per-attempt isolation stays intact.
   - **F**: executor outcome `evidenceRefs` uses the SAME prefixed encoding as the receipt.
   - **G**: smoke guard replaced with an observable assertion (still CI-inert without the flag).
   RED before T6.
3. T6 (GREEN): implement all 8 (H = DENY per user; E minimal-or-STOP). Reuse-only. Make T5 green.
4. T7 (review, security): H genuinely fail-closed (cap-less child under capped parent denied; no
   fail-open; runtime dimension unchanged; no unintended W13/W12 regression); A evidence joins the
   run; B/C behavior-preserving; E disposition no longer reads as completion + isolation intact; F
   consistent; G observable + still inert; no regression (tsc + full suite ≥ baseline); reuse-only;
   deps `{}`; D-02; secrets safe; determinism; frozen untouched.
5. `keryx health run`; confirm ACs; completion (option B) + PR (no co-authorship).

## Verification

Gate: `tsc` clean; full `bun test` ≥ 1325 pass / 2 skip + new green; a cap-less child under a capped
parent is DENIED (H fail-closed); contained-process evidence carries the real run/session/correlation
ids; one shared provider factory; provenance default-root covered; planning evidence not stamped
completed; consistent evidenceRefs; observable smoke guard; deterministic; no new dependency; D-02;
secrets safe; frozen surface untouched.

## Risks

- **H over-denying / breaking intended cap-less scenarios** → deny ONLY when the parent HAS a
  maxToolCalls budget AND the child omits it; parent-without-cap path unchanged; if existing W12/W13
  tests reveal the cap-less-under-capped-parent pattern is intended, STOP and report (reconsider clamp).
- **H/E cascading into a prior-wave refactor** → minimal behavior-tightening only; STOP-and-report guard.
- **A changing the executor input contract** → add OPTIONAL run/session/correlation fields to
  `RunContainedProcessInput` (fall back to idSeq when absent) so existing callers/tests don't break.
- **B/C behavior drift** → factory + helpers must be behavior-identical; existing shell/harness/select
  tests stay green.
- **E disposition enum** → prefer an existing neutral disposition; do NOT extend a frozen enum without
  reporting.
- **Rewriting reused primitives / new dep / non-determinism / flow.json write** → reuse-only; deps `{}`;
  injected id/clock; no fs; T7 greps.
- **Wrong-worktree / index-guard** → guard directives in every dispatch.
