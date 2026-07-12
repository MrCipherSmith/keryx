# Keryx Context Operations — AI Contract View
Version: 1.0.0

## Status

`future`; do not claim runtime support for this package.

## Routing

Use this package when implementing a bounded, cited, policy-gated context
assembler. Read canonical [specification](../specification.md),
[agent protocol](../agent-protocol.md), [schemas](../schemas/) and
[implementation plan](../implementation-plan.md) before code changes.

- [AI PRD](prd.md)
- [AI specification](specification.md)

## Invariants

- Preserve deterministic disabled floor and no-network default.
- Markdown/wiki/memory remain source of truth; `data/context` is derived.
- Include mandatory policy and flow criteria before ranking optional evidence.
- Persist redacted provenance traces; never silently promote untrusted input.
- Use CO-1…CO-13 and AC-1…AC-7 as acceptance identifiers; AC-7 requires typed
  `context_overflow` and forbids a partial-success manifest.
