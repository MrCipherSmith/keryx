# Implementation Plan

Status: ready to freeze

## Approach

A pure decision layer that composes the existing primitives; the actual rung
execution is injected so the whole layer is deterministic and offline-testable.

## Steps

1. New `src/harness/child/escalation.ts`:
   - `classifyInitialTier(description, tierOrder)` — keyword/complexity classifier
     (e.g. "critical"/"security"/"production" → highest; "trivial"/"format"/
     "rename" → lowest; else middle). Pure, deterministic; unknown → default middle.
   - `shouldEscalate(result: CanonicalSubagentResult) → { escalate, trigger? }` —
     escalate on status NEEDS_CONTEXT/BLOCKED/FAILED, any acceptance `not_met`, or
     a metrics threshold; DONE/DONE_WITH_CONCERNS with all acceptance met → stop.
   - `escalate(ladder, ctx, deps)` driver: start at the classified rung; call
     injected `runRung(tier, attemptNumber) → CanonicalSubagentResult`; on
     `shouldEscalate` advance to the next ladder rung as a new `attempt.number` on
     the same `branchId`, admitting each rung's reservation to the shared
     `RemainingBudgetLedger`; stop on success, ladder exhaustion, or a ledger
     admission denial (budget self-truncation). Emit a `tier_escalated`
     event per escalation and return `{ finalResult, events, attempts }`.
2. New `src/harness/child/escalation.test.ts`: classifier cases, predicate cases,
   happy escalate path (cheap fail → standard ok), ladder exhaustion, budget
   self-truncation, determinism.
3. `tier_escalated` events conform to
   docs/requirements/keryx-multi-agent-engine/schemas/agent-event-extensions.schema.json.

## Risks

- Keep the layer PURE — inject `runRung`, ledger, and idSeq; no Date.now/random.
- Escalation must be bounded: ladder length + ledger both cap it (no infinite loop).
- `shouldEscalate` is the single source of the escalate decision — the driver
  never re-derives it.
