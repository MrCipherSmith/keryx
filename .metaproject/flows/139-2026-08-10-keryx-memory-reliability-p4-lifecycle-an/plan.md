# Implementation Plan

Status: frozen approach pending execution

## Approach

Introduce pure lifecycle and write-seam modules beneath `src/memory`, then make
the service the orchestration boundary. This preserves existing adapters and
security profile behavior while giving every Keryx-authored canonical write a
single path-confining, validating, guarded, atomically persisted implementation.

## Steps

1. Establish RED tests for lifecycle, write-seam, CLI, automatic-draft, and
   supersession rollback contracts.
2. Implement pure transition and structured outcomes, then service/CLI wiring.
3. Implement the canonical write seam and migrate create, ingest, reflection,
   transition, and supersession to it.
4. Run focused/security/changed/type tests; perform a scoped review; update only
   the P4 checklist after evidence is green.

## Risks

- Existing write paths have different signatures and failure behavior; retain
  compatibility wrappers only when they delegate to the canonical seam.
- Pair atomic replacement has no cross-file atomic primitive; prevalidate and
  preguard both values, then restore the first byte-for-byte if the second fails.
- Do not broaden into P5 validation semantics or P6 documentation rollout.
