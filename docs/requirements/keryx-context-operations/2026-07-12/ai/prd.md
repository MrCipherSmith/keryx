# Keryx Context Operations — AI PRD
Version: 1.0.0

## Desired outcome

Given a task/query, produce a schema-valid bounded context package whose every
selected item has source reference, hash, trust/status and explainable score.

## Required behavior

- CO-1…CO-4: assemble and validate sources/provenance/budget.
- CO-5…CO-8: deterministic retrieval first; lifecycle and feedback are gated.
- CO-9…CO-11: secure parity surfaces; adapters remain opt-in.
- CO-12…CO-13: executable development fallback and reproducible evaluation.

## Prohibited behavior

No implicit cloud/network dependency, no automatic accepted-memory promotion,
no quiet removal of mandatory policy context, no unsupported “implemented”
claims.

