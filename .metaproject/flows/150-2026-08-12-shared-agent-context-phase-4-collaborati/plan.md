# Implementation Plan

Status: approved for implementation

## Approach

Extend the existing SAC service facade with a single collaboration service that
stores only schema-validated references and allowlisted activity metadata under
the established workspace lock/atomic-write discipline.  CLI and MCP are thin
clients of that facade and use shared normalizers/fixtures; no UI-specific
contract is added. Owner operations re-authorize inside the lock and all
activity records omit content-bearing fields.

Alternatives considered: (A) a dedicated UI activity store (rejected: second
contract and authorization path); (B) expose raw Harness/session data
(rejected: unsafe disclosure); (C) extend SAC's stable facade (chosen: keeps
authorization, strict guard, normalization and fixtures canonical).

## Steps

1. Add red contract/service tests for reference containment, owner-only
   operations, activity minimization, revoked-role/TOCTOU denial and CLI/MCP
   parity.
2. Add the collaboration service and normalized CLI/MCP adapters over the
   existing trusted ActorContext and strict guard seams.
3. Document a repeatable unfamiliar-component onboarding/handoff evaluation
   and record results/actionable gaps without sensitive material.
4. Run focused and full verification, health and full review; remediate every
   finding before the draft PR is opened.

## Risks

- Worktree/session references are untrusted unless resolved/authorized at use.
- Activity feed could accidentally become a content store; enforce allowlisted
  metadata and negative tests.
- New adapters could drift from existing fixtures; share normalized result
  shapes and test both paths against the same fixture corpus.
