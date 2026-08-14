# Shared Agent Context — Source-Owned Projections (RP-02)
Version: 0.1.0

## Purpose

RP-02 defines the **future** typed, read-only source projections that Shared
Agent Context (SAC) uses to assemble FWK (Facts, Work, Know-how). It preserves
the source owner for each datum: Flow owns work, the evidence owner owns
evidence resolution, and Wiki, Memory, and Skills own durable knowledge.

## Status

**Future requirements · spec-ready.** This package is a delivery contract, not
an assertion that the ports or migrations exist in the current runtime.

## Document index

- [Package index](README.md)
- [Product requirements](prd.md)
- [Technical specification](specification.md)
- [Metrics and validation](metrics-and-validation.md)
- [Implementation plan](implementation-plan.md)

## Scope

- Typed owner ports for Flow, evidence, Wiki, Memory, and Skills.
- Canonical Flow-fidelity Work projection and owner-derived Know-how trust and
  applicability.
- Canonical Wiki decision/body writing through a Wiki-owned capability.
- Migration sequencing from verified raw/file-oriented integrations.

## Non-goals

- A second Flow tracker, SAC-authored Flow state, or any Flow mutation path.
- A SAC-owned copy of Wiki, Memory, or Skills knowledge.
- Automatic knowledge promotion, remote sharing, or learned retrieval policy.
- Replacing Context Operations assembly, trace, security guards, or owner ACLs.

## Related modules

- Parent SAC contracts: [shared-agent-context specification](../shared-agent-context/specification.md)
  and [design rationale](../shared-agent-context/design-rationale.md).
- Owners/integrations: Flow, Context Operations, evidence/resource resolvers,
  Wiki, Memory, Skills, Security, Harness, and MCP adapters.
- Evidence baseline: [integrated analysis report](../../analysis/keryx-improvements-1/2026-08-14/report/ru/report.md).
