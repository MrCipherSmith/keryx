# Implementation Plan

Status: formalized

## Approach

Dependency order: **S1 seam first** (unblocks MP-6), then **MP-6 wiring**, then
**MP-5a** (independent). TDD: failing tests first, then implement to green.

- **S1**: make the field OPTIONAL on `RunDeps` so no existing caller breaks and
  the deterministic floor is preserved when it is undefined. Thread from the
  shell/agent driver (which already builds a port via `createMetaprojectAdapter`)
  down into `runOffline`; harness core only stores/forwards it.
- **MP-6**: do NOT add `PolicyContext.metaprojectContext` (heavier PRD path).
  Instead integrate the existing pure primitive `escalateForBlastRadius` at the
  `decide()` call boundary, invoked only when the run supplies a `metaprojectPort`
  AND a configured blast-radius threshold. No port/threshold => `decide()`
  unchanged. Deterministic (no clock/random); a pure fold over a `graphAffected`
  read.
- **MP-5a**: `wikiBacklinks` is a thin add — a `MetaprojectPort` method delegating
  to the wiki service `backlinksFor` (already implemented), plus one
  `METAPROJECT_OPERATIONS` descriptor (module wiki, risk read) so it flows to
  `toInteractiveTools` / `toToolDefinitions` / `toMcpTools` automatically, with a
  JSON result schema alongside the other operation-result schemas.

## Steps

1. Write failing tests for AC1-AC3 (tests-creator).
2. Implement S1 seam (task-implementer).
3. Implement MP-6 escalation wiring (task-implementer).
4. Implement MP-5a wikiBacklinks op + schema (task-implementer).
5. code-verifier + review-orchestrator (architecture + logic); fix findings.
6. Journal deferred items with rationale.

## Risks

- Blast radius on `RunDeps`/`decide()` — mitigated by keeping both changes
  strictly additive and default-off, with an explicit "unchanged when absent" test.
- Determinism regressions — forbid `Date.now()`/`Math.random()`; escalation stays
  a pure fold.
