# Change Report

## Summary

Implemented a unified, identity-safe foreground-operation lifecycle for the OpenTUI shell so long-running agent turns and in-process wiki enrichment can be interrupted reliably. The design separates ordinary abort cleanup from renderer disposal and prevents stale async work from mutating UI or persistence state.

## Delivered behavior

- `/interrupt` aborts normal turns and wiki planning/enrichment, stops new page work, fences late writes, and restores a usable idle shell.
- Queue Force cancels the current operation, waits for settlement, and preserves multiple forced selections in deterministic FIFO order without loss.
- Busy exit and renderer teardown cancel before disposal; late callbacks, approvals, repaints, persistence, and queue drains are suppressed.
- One `AbortSignal` reaches model turns and provider streams. Deep enrichment composes external cancellation with its timeout and reports user cancellation distinctly.
- Legacy, light, batched, deep, and RLM wiki paths stop scheduling or persistence at their awaited cancellation boundaries while preserving already committed progress.
- Explicit `keryx wiki enrich` command syntax is no longer mistaken for a natural-language enrichment request; natural-language picker behavior remains.

## Code and tests

- Added `src/tui/foreground-operation.ts` with foreground ownership, identity-safe settlement, guarded `AgentIO`, ordered Force handoff, and abort/dispose finalization seams.
- Updated TUI, provider-turn, wiki enrichment, RLM, and deep enrichment paths.
- Added deterministic deferred tests for provider propagation, page scheduling, persistence fences, Force ordering, stale callbacks/approvals, live abort cleanup, disposal suppression, deep cancellation result, RLM preparation, and explicit command routing.
- Branch diff: 11 code/test files, 895 insertions, 60 deletions across 8 implementation commits.

## Verification

- Focused final suite: 164 passed, 0 failed.
- Changed strict suite: 165 passed, 0 failed.
- TypeScript: passed.
- Changed Code Health: PASS; implementation verifier reported score 97 with no changed findings.
- Full suite on branch: 6357 passed, 49 failed, 18 skipped.
- Exact-base comparison at `09e8555c`: 6350 passed, the same 49 failed, 18 skipped. All failures reproduce on the base; the branch adds seven passing cancellation tests and no full-suite regression.
- Managed review: five recorded rounds, all retained findings acted on; final round clean through minor severity.

## Routing audit

- `graph_used`: yes — gdgraph navigation, affected analysis, and final depth-2 blast radius.
- `wiki_used`: yes — TUI/wiki architecture context consulted before deep code inspection.
- `ctx_used`: yes — searches, diffs, tests, health, and review artifacts routed through gdctx.
- `raw_rg_used`: no.
