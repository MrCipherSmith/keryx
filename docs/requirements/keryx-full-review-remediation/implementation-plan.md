# Implementation Plan — Keryx Full Review Remediation
Version: 1.1.0

Status: **spec ready — not implemented**.

## Preconditions

Install dependencies, capture the targeted and full-suite baseline, and record
graph cycles before changing code. Compare later full-suite output by failing
test identity, not by requiring the historical suite to become green.

## Waves

1. **Architecture seams:** neutral shell spawn/env module; SAC lifecycle
   composition; narrow workspace facade; injected fleet event sink.
2. **Health and observability:** correct decline/regression labels; add boundary
   tests; audit C-01..C-14 without a mechanical catch rewrite.
3. **Durable-write security:** trace every sink, guard before write, consume
   `guard.redacted`, enforce block/confirmation semantics, and preserve
   read-only research.
4. **Verification:** targeted Bun suites, graph cycle predicates, security sink
   corpus, web-to-proposal scenario, then full-suite comparison.

## Exit checks

Run `keryx gdgraph build` and `keryx gdgraph query cycles`; verify source import
predicates. Run the exact targeted commands in the specification and record
the 5325/49/18 baseline comparison with test identities and skip count.

## Rollback boundaries

Keep behavior-preserving seams separate from security changes. If lifecycle
provenance/expiry/conflict changes, revert that seam before changing public
behavior. If security enforcement over-blocks read-only research, adjust the
durable-write boundary rather than weakening the guard.

## Out of scope

No provider-auth implementation, module-wide reorganization, orphan cleanup,
or health-gate policy change.

