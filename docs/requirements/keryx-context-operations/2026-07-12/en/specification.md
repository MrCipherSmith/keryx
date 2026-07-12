# Keryx Context Operations — Specification
Version: 1.0.0

## Contract

Future `context` capability, disabled by default, reads existing Keryx services
and writes only derived receipts below `.metaproject/data/context/`. It exposes
future `assemble`, `explain`, `feedback` and `eval` CLI operations plus
read-only MCP parity.

## Core invariants

1. Source Markdown and module artifacts remain authoritative; receipts rebuild.
2. Mandatory policy/flow items cannot be silently dropped by ranking.
3. Optional semantic or external providers pass through the Capability Seam.
4. Untrusted text cannot become accepted procedural memory without review.
5. Every output validates against the linked canonical JSON schemas.

## Acceptance

AC-1 through AC-7 in the canonical [specification](../specification.md) map
directly to CO-1 through CO-13 and are the complete implementation contract.
AC-7 requires a normalized `context_overflow` error for byte, token or item
budget failure; a partial-success manifest is forbidden.
