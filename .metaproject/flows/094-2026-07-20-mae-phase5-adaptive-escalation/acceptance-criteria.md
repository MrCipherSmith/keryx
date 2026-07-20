# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `classifyInitialTier(description, tierOrder)` in `src/harness/child/escalation.ts` is a pure, deterministic keyword/complexity classifier — high-signal terms (critical/security/production/…) pick the highest tier, trivial terms the lowest, and anything else a defined default middle tier.
- AC2: `shouldEscalate(result)` returns `{escalate, trigger?}`: escalate on status NEEDS_CONTEXT/BLOCKED/FAILED, on any `acceptance[].status === "not_met"`, or on a defined metrics threshold; DONE / DONE_WITH_CONCERNS with all acceptance met returns `{escalate:false}`. Pure.
- AC3: `escalate(ladder, ctx, deps)` runs rungs via an injected `runRung(tier, attemptNumber)` starting at the classified rung; on `shouldEscalate` it advances to the next ladder rung as a NEW `attempt.number` on the SAME `branchId`, and stops on the first non-escalating result (success).
- AC4: Each escalation emits a `tier_escalated {from_tier, to_tier, trigger, attempt_number}` event conforming to `docs/requirements/keryx-multi-agent-engine/schemas/agent-event-extensions.schema.json`; `escalate` returns the ordered event trace plus the final result and attempts.
- AC5: Budget self-truncation — before running the next rung the driver admits its reservation to the shared `RemainingBudgetLedger`; a ledger denial stops escalation fail-closed (no further rung, no event), and ladder exhaustion also stops with the last result.
- AC6: The layer is pure/deterministic (injected `runRung`/ledger/idSeq; no `Date.now`/`Math.random`); `escalation.test.ts` covers the classifier, predicate, a cheap→standard escalate path, ladder exhaustion, and budget truncation; the full suite (incl. the zero-`dependencies` guard) passes and `tsc --noEmit` is clean.
