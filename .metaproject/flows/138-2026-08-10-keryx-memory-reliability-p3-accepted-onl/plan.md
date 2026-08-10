# Implementation Plan

Status: frozen approach pending implementation

## Approach

Add a memory-owned accepted/current filter builder and authoritative selector;
keep projection/validation at the adapter and MCP boundaries so raw `MemoryEntry`
objects, absolute paths, full details, and unbounded text cannot cross into
automatic consumers. This keeps the canonical Markdown/search service portable,
preserves explicit diagnostic CLI status filters, and avoids P2/P4 scope.

Alternatives considered:

- Per-caller filters: rejected because authority and temporal semantics would
  drift across approval, flow, MCP, and verification.
- Changing all default service search behavior: rejected because diagnostic CLI
  compatibility requires explicit non-accepted searches and P5 owns the wider
  temporal/config contract.

## Steps

1. Add RED cross-surface authority, temporal-boundary, and payload-bound tests.
2. Implement the shared accepted/current filter/current selector with a hard
   automatic result limit and use it from automatic paths.
3. Validate and project portable bounded DTOs in MetaprojectPort; route unified
   harness and both MCP projections through it.
4. Pass explicit accepted/current/limit-one filters from approval; render flow
   accepted/current related memory, isolating any planning advisory text.
5. Enforce procedural hard maximum and current validity; make verifier consult
   canonical accepted/current authoritative entries rather than legacy artifacts.
6. Run focused, changed, cross-surface, typecheck, and broader verification;
   update only P3 progress after evidence is green.

## Risks

- Current validity is exclusive at `Valid-To`; automatic calls must use a
  deterministic as-of day so the boundary is not accidentally inclusive.
- Public port type additions must remain compatible with existing fakes.
- Boundedness must be enforced before rendering, not merely hidden in a UI.
