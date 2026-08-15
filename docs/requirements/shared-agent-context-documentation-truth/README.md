# Shared Agent Context — Documentation Truth (RP-12)
Version: 0.1.1

## Purpose

RP-12 defines future truth, coverage, and verification requirements for Shared
Agent Context (SAC) documentation. It aligns runtime-facing operation docs,
capability/status terminology, graph/wiki projections, examples, and
commit-pinned evidence so documentation cannot overstate delivery.

## Status

**Future requirements · spec-ready.** The CI, generation, graph/wiki coverage,
and executable-documentation controls described here are planned only.

Parent package [`shared-agent-context`](../shared-agent-context/README.md)
1.5.0 / specification 1.2.0 now describe the **shipped** runtime
(`src/sac/`, `keryx workspace`, `sac.*`, harness `workspace_*`). That
reconciliation does **not** implement RP-12. A validator must not treat
this RP's future CI/taxonomy gates as current, and must not treat the
parent package's pre-1.5.0 `future/planned` CLI/MCP sentences as current.

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
