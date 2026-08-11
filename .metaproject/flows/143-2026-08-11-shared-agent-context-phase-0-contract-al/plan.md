# Implementation Plan

Status: frozen-plan candidate

## Approach

Create a narrow `src/sac` foundation with no persistence or external adapter.
Use a local schema validator over the normative package contracts, then enforce
cross-document invariants in typed semantic validation. Keep trust inputs
server-created and inject a strict guard dependency so capability availability
cannot accidentally inherit Security's advisory/fail-open write seam.

## Steps

1. Add SAC types, schema/fixture loading and Draft 2020-12-compatible schema
   validation with deterministic error results.
2. Add semantic validation for canonical SubjectId role conflicts, typed
   workspace-relative references, UTC/time ordering and proposal replay keys.
3. Add realpath/root-containment resolution and trusted ActorContext plus
   authorize-at-use helper designed for caller revalidation.
4. Add strict production guard capability: only enabled/enforced + successful
   guard decision permits read/egress/write; disabled, advisory, unavailable or
   indeterminate states deny.
5. Add focused Bun tests for contract fixtures and all required authorization,
   freshness/TOCTOU and guard-mode cases; run verifier, health and review.

## Risks

- JSON Schema support must not silently treat `format` as asserted; semantic
  parsing owns UTC/order enforcement.
- The SAC strict guard must be separate from existing advisory guard semantics.
- This phase must remain isolated: no new MCP tool, Flow command or storage.
