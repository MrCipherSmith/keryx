# Shared Agent Context — Documentation Truth (RP-12)
Version: 0.1.0

## Purpose

RP-12 defines future truth, coverage, and verification requirements for Shared
Agent Context (SAC) documentation. It aligns runtime-facing operation docs,
capability/status terminology, graph/wiki projections, examples, and
commit-pinned evidence so documentation cannot overstate delivery.

## Status

**Future requirements · spec-ready.** The CI, generation, graph/wiki coverage,
and executable-documentation controls described here are planned only.

## Document index

- [Package index](README.md)
- [Product requirements](prd.md)
- [Technical specification](specification.md)
- [CI protocol](ci-protocol.md)
- [Metrics and validation](metrics-and-validation.md)
- [Implementation plan](implementation-plan.md)

## Scope

- A documented truth-source hierarchy and commit-pinned delivery evidence.
- SAC graph/wiki coverage and generated operation-document requirements.
- Executable local examples, capability/status taxonomy, drift detection, and
CI release/documentation gates.

## Non-goals

- Claiming current graph/wiki/docs CI coverage, rewriting the shared roadmap,
or turning documentation into a new runtime authority.
- Replacing owner tests, Security, Flow, Context Operations, or operation
authorization logic.
- Remote identity, UI, or expanded transport behavior.

## Related modules

- Parent [SAC requirements README](../shared-agent-context/README.md).
- Current public [SAC guide](../../docs/guides/shared-agent-context.md).
- Root-owned [requirements roadmap](../roadmap.md) (read-only to this package).
- Future unified operation metadata: `shared-agent-context-unified-operations`.
- Evidence: [integrated analysis report](../../analysis/keryx-improvements-1/2026-08-14/report/ru/report.md).
