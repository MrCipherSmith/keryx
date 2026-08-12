# Implementation Plan

Status: approved for implementation

## Approach

Build an offline `ProposalService` on the existing SAC contract, trusted
ActorContext, strict-guard, atomic-write, and WorkspaceService seams.  It owns
only immutable candidate files and append-only lifecycle metadata.  Target
writes are injected guarded-owner adapters; SAC validates their receipt but
never writes owner-module knowledge directly.  This preserves source ownership
and makes all acceptance gates explicit and testable.

## Steps

1. Add red tests for immutable creation, append-only/idempotent transitions,
   denial/failure paths, and CLI/MCP result parity.
2. Implement proposal persistence and a causally ordered per-proposal ledger
   under the existing workspace locking and atomic-write discipline.
3. Implement review gates: server-created reviewer context, current ACL and
   evidence freshness, strict named policy revision, owning guarded writer,
   and correlation-bound target receipt.
4. Add read-only lifecycle adapters (create/review is intentionally local
   capability-gated, not Flow mutation) with a common normalized result.
5. Run focused tests, typecheck, health and full review; remediate every
   finding before draft PR handoff.

## Risks

- A target writer may accidentally be callable before the last ACL check;
  re-authorize inside the locked transition and require a receipt after write.
- Append-only audit files are operational metadata, not tamper-evident proof;
  do not make integrity claims beyond causal linkage.
- Existing owner APIs may not be ready for a common writer interface; use
  injected owner adapters instead of changing Wiki, Memory, Skills, or Flow.
